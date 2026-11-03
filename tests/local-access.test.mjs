import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createStore } from '../backend/store.mjs';
import { createApp } from '../server.mjs';

async function directory() {
  await mkdir(resolve('.test-data'), { recursive: true });
  return mkdtemp(resolve('.test-data/local-access-'));
}

test('升级移除旧账号表，模型密文和业务数据保留，重启可重复执行', async () => {
  const dataDir = await directory();
  const store = createStore(dataDir);
  store.db.exec(`CREATE TABLE auth_users (id TEXT PRIMARY KEY, password_hash TEXT);
    CREATE TABLE auth_sessions (token_hash TEXT, user_id TEXT REFERENCES auth_users(id));
    CREATE TABLE auth_audit (event TEXT);
    CREATE TABLE auth_login_limits (address TEXT);
    INSERT INTO auth_users VALUES ('former-user', 'fixture-hash');
    INSERT INTO auth_sessions VALUES ('fixture-session', 'former-user');`);
  store.db.prepare('INSERT INTO model_configs VALUES (?,?,?,?,?)').run('fixture-model', 'generation', '{"name":"保留的模型"}', 'fixture-ciphertext', '2026-11-02');
  store.db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run('fixture-file', '保留的表格.xlsx', 'fixture-hash', 123, '2026-11-02');
  const before = ['model_configs', 'files'].map(name => store.db.prepare(`SELECT * FROM ${name}`).all());
  store.close();
  for (let i = 0; i < 2; i++) {
    const app = createApp({ dataDir });
    assert.equal(app.store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name GLOB 'auth_*'").get().n, 0);
    assert.deepEqual(['model_configs', 'files'].map(name => app.store.db.prepare(`SELECT * FROM ${name}`).all()), before);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=5').get().n, 1);
    app.store.close();
  }
});

test('本机业务接口无需登录，旧认证入口退役，工作台脚本直接加载', async t => {
  const app = createApp({ dataDir: await directory() });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => app.server.close(done)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of ['/api/knowledge', '/api/models', '/api/assessment/current', '/api/assessment/tasks']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  for (const path of ['/api/auth/status', '/auth.js']) assert.equal((await fetch(base + path)).status, 404);
  for (const path of ['/api/auth/setup', '/api/auth/login', '/api/auth/logout']) {
    assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  }
  const html = await (await fetch(base)).text();
  assert.doesNotMatch(html, /auth-locked|auth-page|auth-logout|signed-in-user/);
  for (const name of ['app', 'knowledge', 'models', 'training', 'settings', 'records', 'assessment']) assert.ok(html.includes(`src="./${name}.js" defer`));
  assert.equal((await (await fetch(base + '/api/health')).json()).schemaVersion, 8);
});

test('移除账号后仍拒绝外部 Host、Origin 和跨站请求', async t => {
  const app = createApp({ dataDir: await directory() });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => app.server.close(done)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const headers of [{ Host: 'example.com' }, { Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    // Native fetch may replace forbidden Host/Sec-Fetch-* headers; send them verbatim.
    const status = await new Promise((done, reject) => {
      get(base + '/api/models', { headers }, response => { response.resume(); done(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
});
