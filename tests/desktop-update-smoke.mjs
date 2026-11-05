import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createServer, request } from 'node:http';
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { databaseFingerprint } from '../backend/data-directory.mjs';
import { createVault } from '../backend/vault.mjs';

const preflight = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`$apps = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object DisplayName -eq "QSA-RAG"; if ($apps) { exit 2 }`], { windowsHide: true });
assert.equal(preflight.status, 0, '已有用户安装，停止升级测试');
const parent = resolve(tmpdir());
const folder = mkdtempSync(join(parent, 'desktop-update-'));
const installDirectory = join(folder, '升级 中文'), dataDirectory = join(folder, '业务数据');
const firstVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const nextVersion = process.env.QSA_UPDATE_TEST_VERSION || firstVersion.replace(/beta\.(\d+)$/, (_, n) => `beta.${Number(n) + 1}`);
const firstInstaller = resolve(`release/QSA-RAG-${firstVersion}-win-x64-setup.exe`);
const nextFolder = resolve('.test-data/desktop-update-build');
const nextInstaller = join(nextFolder, `QSA-RAG-${nextVersion}-win-x64-setup.exe`);
assert.ok(existsSync(firstInstaller) && existsSync(nextInstaller));
const installed = spawnSync(firstInstaller, ['/S', `/D=${installDirectory}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 180000 });
assert.equal(installed.status, 0);
const files = new Map([['beta.yml', join(nextFolder, 'beta.yml')], [basename(nextInstaller), nextInstaller], [basename(nextInstaller) + '.blockmap', nextInstaller + '.blockmap'], [basename(firstInstaller) + '.blockmap', firstInstaller + '.blockmap']]);
let bytesServed = 0, ranges = 0;
const server = createServer((req, res) => {
  const path = files.get(decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1)));
  if (!path) { res.writeHead(404); res.end(); return; }
  const size = statSync(path).size;
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : size - 1;
  if (start >= size || end >= size || start > end) { res.writeHead(416); res.end(); return; }
  if (range) ranges++;
  bytesServed += end - start + 1;
  res.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  createReadStream(path, { start, end }).pipe(res);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const feed = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, QSA_DATA_DIR: dataDirectory, QSA_DESKTOP_TEST_HOME: join(folder, '桌面偏好') }; delete env.ELECTRON_RUN_AS_NODE;
let desktop, closed = true, heldRequest;
async function launch() {
  desktop = await electron.launch({ executablePath: join(installDirectory, 'QSA-RAG.exe'), env, timeout: 45000 }); closed = false;
  const page = await desktop.firstWindow(); await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//); await page.locator('#sidebar').waitFor();
  return new URL(page.url()).origin;
}
async function waitFor(check, seconds = 60) {
  for (let i = 0; i < seconds * 5; i++) { if (await check()) return; await new Promise(done => setTimeout(done, 200)); }
  throw new Error('升级验收等待超时');
}
function fingerprint() {
  const db = new DatabaseSync(join(dataDirectory, 'qsa.sqlite'), { readOnly: true });
  try { return databaseFingerprint(db); } finally { db.close(); }
}
try {
  let base = await launch();
  for (const [path, body] of [['/api/knowledge', { name: '升级后保留的知识库' }], ['/api/models', { name: '升级后保留的密钥', type: 'generation', provider: 'custom', baseUrl: 'http://127.0.0.1:1', modelId: 'fixture', apiKey: 'upgrade-fixture-key', isDefault: true }]]) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 201);
  }
  const cache = join(folder, '更新缓存'); mkdirSync(join(cache, 'qsa-local-updater'), { recursive: true });
  copyFileSync(firstInstaller, join(cache, 'qsa-local-updater', 'installer.exe'));
  const downloaded = await desktop.evaluate(async ({ app, dialog }, { feed, cache }) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const { autoUpdater } = require('electron-updater');
    globalThis.updateNotices = [];
    dialog.showMessageBox = async (...args) => { globalThis.updateNotices.push(args.at(-1).message); return { response: 0, checkboxChecked: false }; };
    Object.defineProperty(autoUpdater.app, 'baseCachePath', { get: () => cache });
    autoUpdater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
    // Test installs stay in the fixture. Relaunch with an explicit environment
    // rather than handing test data paths to Explorer's persistent environment.
    const install = autoUpdater.quitAndInstall.bind(autoUpdater);
    autoUpdater.quitAndInstall = silent => install(silent, false);
    const result = await autoUpdater.checkForUpdates(); await result.downloadPromise;
    return result.updateInfo.version;
  }, { feed, cache });
  assert.equal(downloaded, nextVersion);
  await waitFor(() => desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('qsa-install-update').enabled));
  heldRequest = request(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'holding.xlsx', 'Content-Length': '100000' } });
  heldRequest.on('error', () => {}); heldRequest.write('x'); heldRequest.flushHeaders();
  await new Promise(done => setTimeout(done, 300));
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('qsa-install-update').click());
  await waitFor(() => desktop.evaluate(() => globalThis.updateNotices.some(text => text.includes('任务或文件'))));
  assert.equal((await fetch(base + '/api/health')).status, 200, '忙碌时必须继续提供服务');
  heldRequest.destroy(); heldRequest = null;
  await new Promise(done => setTimeout(done, 300));
  const exited = desktop.waitForEvent('close');
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('qsa-install-update').click());
  await exited; closed = true;
  const before = fingerprint();
  await waitFor(async () => {
    try {
      const { extractFile } = await import('@electron/asar');
      return JSON.parse(extractFile(join(installDirectory, 'resources', 'app.asar'), 'package.json').toString()).version === nextVersion;
    } catch { return false; }
  }, 120);
  // Wait for the NSIS process to finish updating files and uninstall metadata.
  await new Promise(done => setTimeout(done, 1500));
  base = await launch();
  const health = await (await fetch(base + '/api/health')).json(); assert.equal(health.appVersion, nextVersion);
  const projects = await (await fetch(base + '/api/knowledge')).json(); assert.equal(projects.projects[0].name, '升级后保留的知识库');
  const exitedAgain = desktop.waitForEvent('close'); await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('qsa-quit').click()); await exitedAgain; closed = true;
  assert.deepEqual(fingerprint(), before);
  const db = new DatabaseSync(join(dataDirectory, 'qsa.sqlite'), { readOnly: true });
  let cipher; try { cipher = db.prepare('SELECT secret_ref FROM model_configs').get().secret_ref; } finally { db.close(); }
  assert.equal(await createVault(join(installDirectory, 'resources', 'python', 'python.exe')).decrypt(cipher), 'upgrade-fixture-key');
  const report = { from: firstVersion, to: nextVersion, localUpdateFeed: true, downloadedAndInstalledByUpdater: true, byteRanges: ranges, downloadedBytes: bytesServed, fullInstallerBytes: statSync(nextInstaller).size, blockedInstallDuringFileProcessing: true, databaseAndRowidsPreserved: true, keyDecryptedAfterUpgrade: true, explicitFixtureRelaunch: true, realCloudCalls: 0 };
  writeFileSync('outputs/desktop-update-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  heldRequest?.destroy();
  if (desktop && !closed) { try { await desktop.close(); } catch {} }
  await new Promise(done => server.close(done));
  assert.ok(resolve(installDirectory).startsWith(parent + '\\'));
  const name = readdirSync(installDirectory).find(name => /^Uninstall.*\.exe$/i.test(name));
  if (name) {
    const result = spawnSync(join(installDirectory, name), ['/S', `_?=${installDirectory}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 120000 });
    assert.equal(result.status, 0);
  }
}
