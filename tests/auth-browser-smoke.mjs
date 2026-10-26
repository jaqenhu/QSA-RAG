import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';

const { chromium } = await import(process.env.QSA_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.QSA_PLAYWRIGHT_MODULE).href : 'playwright');
await mkdir(resolve('.test-data'), { recursive: true });
const directory = await mkdtemp(resolve('.test-data/auth-browser-'));
const app = createApp({ dataDir: directory });
await new Promise(done => app.server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const screenshots = resolve('.impeccable/review'); await mkdir(screenshots, { recursive: true });
const password = randomBytes(24).toString('base64url');
const checks = [];
async function capture(name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '页面不得横向溢出');
  await page.screenshot({ path: join(screenshots, `v20-auth-${name}.png`), fullPage: true });
}
try {
  await page.goto(base);
  await page.getByRole('heading', { name: '设置管理员密码' }).waitFor();
  assert.equal(await page.locator('script[src="./knowledge.js"]').count(), 0);
  assert.equal((await page.request.get(base + '/api/knowledge')).status(), 401);
  await capture('setup-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await capture('setup-mobile');
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-confirm').fill('a-different-value');
  await page.locator('#auth-submit').click();
  assert.match(await page.locator('#auth-error').textContent(), /不一致/);
  await page.locator('#auth-confirm').fill(password); await page.locator('#auth-submit').click();
  await page.locator('#auth-page').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('knowledge-project-empty').hidden === false);
  assert.match(await page.locator('#signed-in-user').textContent(), /admin/);
  checks.push('首次设置、确认校验与登录后加载业务页面');
  await page.reload(); await page.locator('#auth-page').waitFor({ state: 'hidden' });
  assert.equal((await page.request.get(base + '/api/knowledge')).status(), 200);
  checks.push('刷新保持会话');
  await page.locator('#auth-logout').click(); await page.getByRole('heading', { name: '账号登录' }).waitFor();
  assert.equal((await page.request.get(base + '/api/knowledge')).status(), 401);
  await page.setViewportSize({ width: 1440, height: 1000 }); await capture('login-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await capture('login-mobile');
  await page.locator('#auth-password').fill('wrong'); await page.locator('#auth-submit').click();
  await page.locator('#auth-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#auth-error').textContent(), /不正确/);
  assert.equal(await page.locator('#auth-password').inputValue(), '');
  await page.locator('#auth-password').fill(password); await page.locator('#auth-submit').click();
  await page.locator('#auth-page').waitFor({ state: 'hidden' });
  checks.push('退出使会话失效、错误密码清空、正确密码重新登录');
  app.store.db.prepare('UPDATE auth_sessions SET expires_at=0').run();
  await page.evaluate(() => fetch('/api/knowledge'));
  await page.getByRole('heading', { name: '账号登录' }).waitFor();
  checks.push('会话过期自动回到登录，桌面与手机无横向溢出');
  assert.deepEqual(errors, []);
  await writeFile(join(screenshots, 'v20-auth-browser-checks.json'), JSON.stringify({ mode: '隔离测试数据，不设置真实账号密码，不调用云模型', checks, errors }, null, 2));
  console.log(`账号浏览器验证通过：${checks.length} 项流程，桌面与手机，无脚本异常。`);
} finally {
  await browser.close(); await new Promise(done => app.server.close(done)); app.store.close(); await rm(directory, { recursive: true, force: true });
}
