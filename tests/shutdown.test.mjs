import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, get, request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { closeService } from '../backend/close-service.mjs';

async function fixture(t, options = {}) {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, 'shutdown-'));
  const app = createApp({ dataDir: folder, ...options });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => { app.server.closeAllConnections(); app.server.close(); app.store.close(); assert.ok(folder.startsWith(parent + sep)); rmSync(folder, { recursive: true, force: true }); });
  return { app, folder, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('退出清理浏览器 keep-alive 连接并释放服务租约', { timeout: 3000 }, async t => {
  const { app, folder, base } = await fixture(t);
  const agent = new Agent({ keepAlive: true }); t.after(() => agent.destroy());
  await new Promise((done, reject) => get(base + '/api/health', { agent }, response => { response.resume(); response.once('end', done); }).once('error', reject));
  await closeService(app);
  const db = new DatabaseSync(join(folder, 'qsa.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) n FROM service_lease').get().n, 0); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { db.close(); }
});

test('未发送完的网页请求不能把退出卡住', { timeout: 3000 }, async t => {
  const { app, base } = await fixture(t);
  const held = request(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'pending.xlsx', 'Content-Length': '100000' } });
  held.on('error', () => {}); held.write('x'); held.flushHeaders(); t.after(() => held.destroy());
  for (let i = 0; !app.activity().requests && i < 50; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(app.activity().foregroundRequests, 1);
  await closeService(app);
  assert.equal(app.server.listening, false);
});

test('响应已完成但请求体仍未结束的残留连接也能退出', { timeout: 3000 }, async t => {
  const { app, base } = await fixture(t);
  let responded;
  const done = new Promise(resolve => { responded = resolve; });
  const held = request(base + '/api/health', { method: 'GET', headers: { 'Content-Length': '100000' } }, response => { response.resume(); response.once('end', responded); });
  held.on('error', () => {}); held.write('x'); held.flushHeaders(); t.after(() => held.destroy());
  await done;
  assert.equal(app.activity().busy, false);
  await closeService(app);
  assert.equal(app.server.listening, false);
});

test('断开网页连接后仍等待正在保存的配置完成，再关闭数据库', { timeout: 3000 }, async t => {
  let entered, release;
  const encrypting = new Promise(done => { entered = done; });
  const encryption = new Promise(done => { release = done; });
  const vault = { encrypt: async () => { entered(); await encryption; return 'fixture-ciphertext'; }, decrypt: async () => 'fixture' };
  const { app, base, folder } = await fixture(t, { vault });
  const response = fetch(base + '/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '关闭时保留的配置', type: 'generation', provider: 'custom', baseUrl: 'http://127.0.0.1:12345', modelId: 'fixture', apiKey: 'fixture', isDefault: true }) }).catch(() => {});
  await encrypting;
  const stopping = closeService(app);
  await new Promise(done => setTimeout(done, 20));
  assert.equal(app.activity().requests, 1, '连接被断开不代表后台保存已完成');
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM model_configs').get().n, 0);
  release(); await stopping; await response;
  const db = new DatabaseSync(join(folder, 'qsa.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) n FROM model_configs').get().n, 1); }
  finally { db.close(); }
});
