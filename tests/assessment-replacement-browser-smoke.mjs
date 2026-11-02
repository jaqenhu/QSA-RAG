import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { startMockProvider, createTestVault } from './mock-provider.mjs';

const { chromium } = await import(process.env.QSA_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.QSA_PLAYWRIGHT_MODULE).href : 'playwright');
await mkdir(resolve('.test-data'), { recursive: true });
const directory = await mkdtemp(resolve('.test-data/replacement-browser-'));
for (const script of ['create_fixtures.py', 'create_assessment_fixtures.py', 'create_replacement_fixtures.py']) {
  assert.equal(spawnSync('python', ['-X', 'utf8', `tests/${script}`, directory]).status, 0);
}
const mock = await startMockProvider();
const app = createApp({ dataDir: join(directory, 'db'), vault: createTestVault(), providerClient: createProviderClient({ fetchImpl: (url, options) => fetch(mock.base + new URL(url).pathname, options) }) });
await new Promise(done => app.server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) console.log(JSON.stringify({ status: response.status(), path: new URL(response.url()).pathname })); });
const review = resolve('.impeccable/review/20261023-replacement');
await mkdir(review, { recursive: true });
async function api(path, data, method = 'POST') {
  const response = await fetch(base + path, { method, ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  const result = await response.json(); assert.ok(response.ok, result.error); return result;
}
async function upload(file, name) {
  const response = await fetch(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: await readFile(file) });
  assert.ok(response.ok); return response.json();
}
async function replace(file) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/assessment/inputs') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#choose-assessment-file').click();
  await (await chooser).setFiles(file);
  const result = await response;
  await page.waitForFunction(() => !assessmentBusy);
  return result.ok() ? page.evaluate(() => assessmentInput) : undefined;
}
async function pending(input) {
  assert.equal(await page.locator('#assessment-input-name').textContent(), input.name);
  assert.equal(await page.locator('#results-body tr').count(), input.records.length);
  assert.equal(await page.locator('#assessment-progress-wrap').isHidden(), true);
  assert.equal(await page.locator('#assessment-overview').isHidden(), true);
  assert.equal(await page.locator('#export-assessment').isDisabled(), true);
  assert.equal(await page.locator('#retry-assessment').isHidden(), true);
  assert.deepEqual(await page.locator('#results-body .question-select').allTextContents(), input.records.map(row => row.question));
  assert.deepEqual(await page.locator('#assessment-input-info tbody tr td:nth-child(2)').allTextContents(), input.records.map(row => row.question));
  assert.ok((await page.locator('#results-body .answer-text').allTextContents()).every(answer => answer === '尚未生成'));
  assert.ok((await page.locator('#evidence-content').textContent()).includes(input.records[0].question));
}
async function generate() {
  await page.waitForFunction(() => !document.getElementById('start-supplier-assessment').disabled);
  await page.locator('#start-supplier-assessment').click();
  await page.waitForFunction(() => !assessmentBusy && assessmentTask && assessmentTask.status !== 'running', null, { timeout: 60000 });
  return (await api('/api/assessment/current', undefined, 'GET')).task;
}
try {
  const draft = await upload(join(directory, 'v1.xlsx'), 'v1.xlsx');
  const { project } = await api(`/api/knowledge/imports/${draft.importId}/commit`, { mode: 'new' });
  const saved = [];
  for (const type of ['generation', 'embedding']) {
    const { model } = await api('/api/models', { name: type, modelId: type, type, provider: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', dimensions: 8, apiKey: 'mock-secret-fixture', isDefault: true });
    saved.push((await api(`/api/models/${model.id}/test`, { expectedRevision: model.revision })).model);
  }
  const { job } = await api(`/api/knowledge/${project.id}/training`, { name: '换表测试索引', expectedVersionId: project.versionId, modelId: saved[1].id, sheets: Object.keys(project.sheets), updateMode: 'rebuild', retrieval: 'keyword' });
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await api(`/api/training/${job.id}`, undefined, 'GET')).job.status !== 'running') break;
    await new Promise(done => setTimeout(done, 20));
  }
  await page.goto(base + '/#supplier');
  await page.waitForFunction(() => !assessmentBusy && configuredModels.length > 0);
  const original = await replace(join(directory, 'input.xlsx'));
  await pending(original);
  const originalTask = await generate();
  await page.locator('[data-filter="partial"]').click();
  await page.locator('#question-search').fill('今年');
  const renamedBytes = { name: '改名待填表.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await readFile(join(directory, 'input.xlsx')) };
  const renamed = await replace(renamedBytes);
  assert.equal(renamed.name, '改名待填表.xlsx');
  assert.notEqual(renamed.id, original.id);
  await pending(renamed);
  assert.equal(await page.locator('#question-search').inputValue(), '');
  await page.reload(); await page.waitForFunction(() => assessmentInput !== null);
  await pending(renamed);
  checks.push('same-content rename, filter reset, reload without old results');

  // Release an old current-workspace response after a successful replacement.
  let releaseLoad, loadEntered;
  const enteredLoad = new Promise(done => { loadEntered = done; });
  await page.route('**/api/assessment/current', async route => {
    const response = await route.fetch();
    await new Promise(done => { releaseLoad = done; loadEntered(); });
    await route.fulfill({ response });
  }, { times: 1 });
  await page.evaluate(() => { void loadAssessment(); }); await enteredLoad;
  const replacement = await replace(join(directory, 'replacement.xlsx'));
  releaseLoad();
  await page.waitForResponse(response => response.url().endsWith('/api/assessment/current'));
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await pending(replacement);
  assert.match(await page.locator('#assessment-input-summary').textContent(), /替换审核表、补充检查 · 4 项问题 · 0 组合并/);
  checks.push('new sheets, positions, questions and merge counts; delayed load ignored');

  mock.behavior.slowMs = 100; mock.behavior.assessmentDelay = 1500;
  await page.locator('#start-supplier-assessment').click();
  await page.waitForFunction(() => assessmentTask?.progress?.items.length > 0);
  await page.locator('#assessment-progress-wrap').focus();
  assert.match(await page.locator('#assessment-progress-items').textContent(), /替换审核表/);
  assert.equal((await page.locator('#assessment-progress-items').textContent()).includes('审核检查单'), false);
  await page.locator('#assessment-progress-wrap').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(review, 'progress-desktop.png') });
  await page.waitForFunction(() => assessmentTask?.status !== 'running', null, { timeout: 60000 });
  mock.behavior.slowMs = 0; mock.behavior.assessmentDelay = 0;
  const replacementTask = (await api('/api/assessment/current', undefined, 'GET')).task;
  assert.equal(replacementTask.inputId, replacement.id); assert.equal(replacementTask.total, 4);
  assert.deepEqual(await page.locator('#results-body .question-select').allTextContents(), replacement.records.map(row => row.question));
  assert.equal(await page.locator('#assessment-overview-counts').textContent(), '成功 4 项，失败 0 项');
  checks.push('new-task progress and generated preview use replacement only');

  // A final old poll must not restore a task after the user changes files.
  let releasePoll, pollEntered;
  const enteredPoll = new Promise(done => { pollEntered = done; });
  await page.route(`**/api/assessment/tasks/${replacementTask.id}`, async route => {
    const response = await route.fetch();
    await new Promise(done => { releasePoll = done; pollEntered(); });
    await route.fulfill({ response });
  }, { times: 1 });
  await page.evaluate(() => { void pollAssessment(); }); await enteredPoll;
  const repeated = await replace(join(directory, 'replacement.xlsx'));
  releasePoll();
  await page.waitForResponse(response => response.url().endsWith(`/api/assessment/tasks/${replacementTask.id}`));
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.notEqual(repeated.id, replacement.id); await pending(repeated);
  assert.equal(await page.evaluate(() => assessmentTask), null);
  checks.push('same-name reupload clears task; delayed old poll ignored');

  const failed = await replace(join(directory, 'invalid.xlsx'));
  assert.equal(failed, undefined); await pending(repeated);
  assert.match(await page.locator('#assessment-status').textContent(), /有效的 .xlsx/);
  checks.push('failed replacement retains last valid input');

  if (process.env.QSA_REPLACEMENT_WORKBOOK) {
    const originalBytes = await readFile(process.env.QSA_REPLACEMENT_WORKBOOK);
    const real = await replace(process.env.QSA_REPLACEMENT_WORKBOOK);
    await pending(real);
    const parsed = spawnSync('python', ['-X', 'utf8', '-c', "import sys,json;sys.path.insert(0,'backend');from assessment_workbook import parse_input;print(json.dumps(parse_input(sys.argv[1]),ensure_ascii=False))", process.env.QSA_REPLACEMENT_WORKBOOK], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(parsed.status, 0, parsed.stderr);
    const expected = JSON.parse(parsed.stdout);
    assert.deepEqual(real.records, expected.records); assert.deepEqual(real.sheets, expected.sheets);
    await page.reload(); await page.waitForFunction(() => assessmentInput !== null); await pending(real);
    // Verify every position in the real workbook using only the mock provider.
    await page.locator('#assessment-scope').selectOption('all');
    const task = await generate();
    assert.equal(task.inputId, real.id); assert.equal(task.total, real.records.length);
    assert.deepEqual(task.results.map(row => [row.sheet, row.line, row.question]), real.records.map(row => [row.sheet, row.line, row.question]));
    assert.deepEqual(await page.locator('#results-body .question-select').allTextContents(), real.records.map(row => row.question));
    const downloadEvent = page.waitForEvent('download'); await page.locator('#export-assessment').click();
    const download = await downloadEvent; await download.saveAs(join(directory, 'real-workbook-export.xlsx'));
    assert.equal(download.suggestedFilename(), real.name.replace(/\.xlsx$/i, '') + '—自评结果.xlsx');
    await writeFile(join(directory, 'real-expected.json'), JSON.stringify(task.results));
    const exported = spawnSync('python', ['-X', 'utf8', '-c', `import sys,json,openpyxl
w=openpyxl.load_workbook(sys.argv[1],data_only=False)
for row in json.load(open(sys.argv[2],encoding='utf-8')):
    s=w[row['sheet']]; line=row['line']
    assert s[f'B{line}'].value==row['question']
    assert s[f'C{line}'].value==row['answer']
    assert (s[f'D{line}'].value or '')==row['basis']
    assert (s[f'E{line}'].value or '')==row['details']
w.close()`, join(directory, 'real-workbook-export.xlsx'), join(directory, 'real-expected.json')], { encoding: 'utf8' });
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual(await readFile(process.env.QSA_REPLACEMENT_WORKBOOK), originalBytes);
    checks.push({ realWorkbook: real.name, sheets: real.sheets.map(sheet => ({ name: sheet.name, questions: sheet.questionCount })), questions: real.records.length, generated: task.total, export: true, exportVerifiedRows: task.results.length, originalUnchanged: true, resultCounts: task.counts });
  }
  await page.locator('#assessment-input-details').evaluate(element => { element.open = true; });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    if (name === 'mobile') await page.waitForFunction(() => document.getElementById('sidebar').getBoundingClientRect().right <= 1);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: join(review, `input-${name}.png`) });
    await page.locator('#supplier-review-section').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: join(review, `preview-${name}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  assert.deepEqual((await api(`/api/assessment/tasks/${originalTask.id}`, undefined, 'GET')).task.results, originalTask.results);
  assert.equal((await api(`/api/assessment/inputs/${original.id}`, undefined, 'GET')).input.name, 'input.xlsx');
  assert.deepEqual(errors, []);
  checks.push('historical input and results unchanged; desktop/mobile without overflow or script errors');
  const report = { checkedAt: new Date().toISOString(), backend: 'isolated mock HTTP provider', checks, errors };
  await writeFile(join(review, 'checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close(); await app.assessment.shutdown(); await app.indexer.shutdown();
  await new Promise(done => app.server.close(done)); app.store.close(); await mock.close();
}
