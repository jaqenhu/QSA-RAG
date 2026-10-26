import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createApp } from '../server.mjs';
import { createAuth } from '../backend/auth.mjs';

async function fixture(t) {
  const parent = resolve('.test-data'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'auth-'));
  let app, base;
  async function start() { app = createApp({ dataDir: directory }); await new Promise(done => app.server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function stop() { await new Promise(done => app.server.close(done)); app.store.close(); }
  await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  async function api(path, data, cookie, extra = {}) {
    return fetch(base + path, { ...extra, method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra.headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  const password = randomBytes(24).toString('base64url');
  const activate = () => api('/api/auth/setup', { password, confirmPassword: password });
  return { get app() { return app; }, api, password, activate, start, stop };
}

test('首次管理员预建、密码验证、会话与所有业务入口鉴权', async t => {
  const f = await fixture(t);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n, 1);
  assert.equal((await (await f.api('/api/auth/status')).json()).setupRequired, true);
  for (const path of ['/api/knowledge', '/api/models', '/api/assessment/current', '/api/assessment/tasks', '/api/assessment/tasks/00000000-0000-0000-0000-000000000000/export']) assert.equal((await f.api(path)).status, 401);
  assert.equal((await f.api('/api/models', {})).status, 401);
  assert.equal((await f.api('/api/auth/setup', { password: 'short', confirmPassword: 'short' })).status, 400);
  assert.equal((await f.api('/api/auth/setup', { password: f.password, confirmPassword: 'different' })).status, 400);
  assert.equal((await f.api('/api/auth/setup', { password: f.password, confirmPassword: f.password }, null, { headers: { Origin: 'https://example.com' } })).status, 403);
  const response = await f.activate(); assert.equal(response.status, 201);
  const cookieHeader = response.headers.get('set-cookie'), cookie = cookieHeader.split(';')[0];
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Strict/); assert.match(cookieHeader, /Max-Age=28800/);
  const body = await response.json(); assert.equal(body.user.username, 'admin'); assert.equal(body.user.role, 'admin');
  assert.equal(JSON.stringify(body).includes(f.password), false);
  const stored = f.app.store.db.prepare('SELECT password_hash FROM auth_users').get().password_hash;
  assert.match(stored, /^scrypt\$32768\$8\$3\$/); assert.equal(stored.includes(f.password), false);
  const session = f.app.store.db.prepare('SELECT token_hash FROM auth_sessions').get(); assert.equal(session.token_hash.includes(cookie.split('=')[1]), false);
  assert.equal((await f.api('/api/knowledge', undefined, cookie)).status, 200);
  assert.equal((await f.api('/api/knowledge', undefined, 'qsa_session=forged')).status, 401);
  assert.equal((await f.activate()).status, 409);
  assert.equal((await f.api('/api/auth/login', { username: 'unknown', password: f.password })).status, 401);
  assert.equal((await f.api('/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await f.api('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await f.api('/api/knowledge', undefined, cookie)).status, 401);
  const login = await f.api('/api/auth/login', { username: 'admin', password: f.password }); assert.equal(login.status, 200);
  const newCookie = login.headers.get('set-cookie').split(';')[0]; assert.notEqual(newCookie, cookie);
  await f.stop(); await f.start();
  assert.equal((await (await f.api('/api/auth/status')).json()).setupRequired, false);
  assert.equal((await f.api('/api/knowledge', undefined, newCookie)).status, 200);
  f.app.store.db.prepare('UPDATE auth_sessions SET expires_at=0').run();
  assert.equal((await f.api('/api/knowledge', undefined, newCookie)).status, 401);
});

test('首次设置只能由本机完成，并发设置不会覆盖密码', async t => {
  const f = await fixture(t), auth = createAuth(f.app.store);
  await assert.rejects(() => auth.setup({ socket: { remoteAddress: '192.168.1.8' } }, {}, { password: f.password, confirmPassword: f.password }), error => error.status === 403);
  const results = await Promise.all([f.activate(), f.activate()]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n, 1);
});

test('失败限流跨重启保留，停用账户立即撤销访问能力', async t => {
  const f = await fixture(t);
  const activated = await f.activate(), cookie = activated.headers.get('set-cookie').split(';')[0];
  for (let index = 0; index < 10; index++) assert.equal((await f.api('/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await f.api('/api/auth/login', { username: 'admin', password: f.password })).status, 429);
  await f.stop(); await f.start();
  assert.equal((await f.api('/api/auth/login', { username: 'admin', password: f.password })).status, 429);
  f.app.store.db.prepare("UPDATE auth_users SET state='disabled'").run();
  assert.equal((await f.api('/api/knowledge', undefined, cookie)).status, 401);
  assert.equal((await f.activate()).status, 409);
});
