import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startMockProvider } from './mock-provider.mjs';

await mkdir(resolve('.test-data'), { recursive: true }); await mkdir(resolve('outputs'), { recursive: true });
// Never launch from below the checkout: Node can otherwise find missing runtime
// dependencies in the development node_modules higher up the directory tree.
const folder = await mkdtemp(join(tmpdir(), 'qsa-desktop-中文-'));
const sourceExecutablePath = resolve(process.env.QSA_DESKTOP_EXE || 'release/win-unpacked/QSA-RAG.exe');
assert.ok(existsSync(sourceExecutablePath), '请先构建桌面版');
const isolatedApp = join(folder, '独立安装目录');
await cp(dirname(sourceExecutablePath), isolatedApp, { recursive: true });
const executablePath = join(isolatedApp, basename(sourceExecutablePath));
assert.ok(!executablePath.toLowerCase().startsWith(resolve('.').toLowerCase() + sep));
for (const script of ['create_fixtures.py', 'create_assessment_fixtures.py']) {
  const generated = spawnSync(process.env.QSA_BUILD_PYTHON || 'python', ['-X', 'utf8', `tests/${script}`, folder], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
}
const mock = await startMockProvider();
const env = { ...process.env, QSA_DATA_DIR: join(folder, '业务数据'), QSA_DESKTOP_TEST_HOME: join(folder, '桌面偏好') };
// Prove no installed Node/Python, PYTHONPATH or user site packages are needed.
env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
delete env.ELECTRON_RUN_AS_NODE; delete env.PYTHONPATH; delete env.QSA_PYTHON; delete env.QSA_PYTHON_SCRIPTS; delete env.NODE_PATH; delete env.NODE_OPTIONS;
let desktop, page, base, initial, desktopClosed = true;
const errors = [];
async function launch() {
  desktop = await electron.launch({ executablePath, env, cwd: folder, timeout: 45000 });
  desktopClosed = false;
  page = await desktop.firstWindow({ timeout: 45000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
  base = new URL(page.url()).origin;
  await page.locator('#sidebar').waitFor();
}
async function api(path, body) {
  const response = await fetch(base + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
async function quit(viaWindow = false) {
  const closed = desktop.waitForEvent('close');
  if (viaWindow) await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  else await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('qsa-quit').click());
  await closed;
  desktopClosed = true;
}
try {
  await launch();
  initial = await desktop.evaluate(({ app, BrowserWindow }) => ({ version: app.getVersion(), packaged: app.isPackaged, preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
  assert.equal(initial.packaged, true);
  assert.equal(initial.preferences.nodeIntegration, false);
  assert.equal(initial.preferences.contextIsolation, true); assert.equal(initial.preferences.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const saved = [];
  for (const type of ['generation', 'embedding']) {
    const { model } = await api('/api/models', { name: '桌面测试 ' + type, modelId: type, type, provider: 'custom', baseUrl: mock.base, apiKey: 'mock-secret-fixture', dimensions: 8, isDefault: true });
    const tested = await api(`/api/models/${model.id}/test`, { expectedRevision: model.revision });
    assert.equal(tested.result.success, true); saved.push(tested.model);
  }
  await page.goto(base + '/#knowledge-list');
  await page.reload();
  await page.locator('#create-knowledge-project').click();
  await page.locator('#knowledge-name-input').fill('桌面验收知识库'); await page.locator('#save-knowledge-name').click();
  await page.locator('#open-knowledge-upload').click();
  await page.locator('#knowledge-file-input').setInputFiles(join(folder, 'v1.xlsx'));
  await page.waitForFunction(() => !document.getElementById('confirm-knowledge-upload').disabled);
  await page.locator('#confirm-knowledge-upload').click(); await page.locator('#knowledge-upload-dialog').waitFor({ state: 'hidden' });
  const project = (await api('/api/knowledge')).projects[0];
  const training = await api(`/api/knowledge/${project.id}/training`, { name: '桌面验收', expectedVersionId: project.versionId, modelId: saved[1].id, sheets: Object.keys(project.sheets), updateMode: 'rebuild', retrieval: 'hybrid', topK: 8, threshold: 0.5 });
  for (let i = 0; i < 100; i++) {
    const state = await api(`/api/knowledge/${project.id}/training`);
    if (state.ready) break;
    if (i === 99) throw new Error('桌面训练未完成');
    await new Promise(done => setTimeout(done, 100));
  }
  await page.goto(base + '/#supplier');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('choose-assessment-file').disabled);
  await page.locator('#assessment-file-input').setInputFiles(join(folder, 'input.xlsx'));
  await page.waitForFunction(() => !document.getElementById('start-supplier-assessment').disabled);
  await page.locator('#start-supplier-assessment').click();
  await page.waitForFunction(() => document.getElementById('assessment-status').textContent.includes('生成完成'), { timeout: 30000 });
  assert.equal(await page.locator('#assessment-overview-counts').textContent(), '成功 3 项，失败 0 项');
  const completed = (await api('/api/assessment/current')).task;
  const exported = await fetch(base + `/api/assessment/tasks/${completed.id}/export`);
  assert.equal(exported.status, 200);
  const file = Buffer.from(await exported.arrayBuffer()); assert.ok(file.length > 1000); assert.equal(file.subarray(0, 2).toString(), 'PK');
  await writeFile(join(folder, '桌面导出.xlsx'), file);
  await page.screenshot({ path: resolve('outputs/desktop-assessment.png') });
  const runtime = JSON.parse(await readFile(join(env.QSA_DESKTOP_TEST_HOME, 'runtime-state.json'), 'utf8'));
  assert.match(runtime.python, /^3\.13\./); assert.ok(Number(runtime.node.split('.')[0]) >= 24);
  await quit(true); await launch();
  const history = await api('/api/assessment/tasks'); assert.equal(history.total, 1);
  assert.equal((await api('/api/models')).models.length, 2);
  // A new process must be able to decrypt the model key from the persisted DB.
  const restartedModels = (await api('/api/models')).models;
  assert.equal((await api(`/api/models/${restartedModels[0].id}/test`, { expectedRevision: restartedModels[0].revision })).result.success, true);
  await quit();
  assert.deepEqual(errors, []);
  const report = { version: initial.version, sourceExecutablePath, executablePath, outsideSourceCheckout: true, isolatedDataDirectory: env.QSA_DATA_DIR, bundledPython: runtime.python, bundledNode: runtime.node, withoutInstalledNodeOrPython: true, sandbox: true, contextIsolation: true, knowledgeUpload: true, trainingJob: training.job.id, assessmentItems: completed.results.length, exportBytes: file.length, restartRetainedDataAndKeys: true, windowCloseVerified: true, exitMenuVerified: true, scriptErrors: errors, realCloudCalls: 0 };
  await writeFile(resolve('outputs/desktop-smoke.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  try {
    await page.screenshot({ path: resolve('outputs/desktop-failure.png') });
    console.error('桌面状态：', await page.locator('#assessment-status').textContent());
  } catch {}
  throw error;
} finally {
  if (desktop && !desktopClosed) { try { await desktop.close(); } catch {} }
  await mock.close();
  assert.equal(dirname(isolatedApp), folder);
  await rm(isolatedApp, { recursive: true, force: true });
}
