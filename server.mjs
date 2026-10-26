import http from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createStore, ApiError } from './backend/store.mjs';
import { createVault } from './backend/vault.mjs';
import { createProviderClient } from './backend/providers.mjs';
import { createModels } from './backend/models.mjs';
import { createIndexer } from './backend/indexer.mjs';
import { claimService } from './backend/service-lease.mjs';
import { createAssessment, assessmentWorkbook } from './backend/assessment.mjs';
import { createAuth } from './backend/auth.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const providerAssets = ['openai', 'bailian', 'volcengine', 'hunyuan', 'zhipu', 'kimi', 'deepseek', 'siliconcloud'].map(name => `assets/providers/${name}.svg`);
const allowed = new Set(['index.html', 'styles.css', 'app.js', 'knowledge.js', 'models.js', 'training.js', 'settings.js', 'records.js', 'favicon.svg', 'assets/fonts/qsa-sans-sc.woff2', 'assets/fonts/qsa-serif-sc.woff2', 'assets/images/qsa-assistant.png', 'assets/images/knowledge-library.png', 'assets/images/input-sheet.png', ...providerAssets]);
const MAX_UPLOAD = 20 * 1024 * 1024;
allowed.add('assessment.js');
allowed.add('auth.js');

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new ApiError(413, '请求内容过大，文件不得超过 20 MB。'); }
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new ApiError(413, '请求内容过大，请缩小文件后重试。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '请求格式应为 JSON。');
  try {
    const data = JSON.parse((await readBody(request, 65536)).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, '请求内容无效，请刷新页面后重试。');
  }
}
function parseWorkbook(filePath, python) {
  return new Promise((done, reject) => {
    const child = spawn(python, ['-X', 'utf8', join(root, 'backend', 'parse_workbook.py'), filePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let outputBytes = 0, settled = false;
    const chunks = [];
    const finish = (error, data) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else done(data);
    };
    const timer = setTimeout(() => { child.kill(); finish(new ApiError(422, '解析超过 60 秒，请精简工作簿后重试。')); }, 60000);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 40 * 1024 * 1024) { child.kill(); finish(new ApiError(422, '工作簿文本内容过大，请拆分后上传。')); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => finish(new ApiError(503, '无法启动 Python。请安装 Python 3 和解析依赖，或设置 QSA_PYTHON。')));
    child.on('close', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!result.ok) finish(new ApiError(422, result.error));
        else finish(null, result.data);
      } catch { finish(new ApiError(422, '解析未完成，请确认 Python 和解析依赖可用。')); }
    });
  });
}

export function createApp({ dataDir = process.env.QSA_DATA_DIR || join(root, '.data'), python = process.env.QSA_PYTHON || 'python', providerClient = createProviderClient(), vault = createVault(python) } = {}) {
  const directory = resolve(dataDir);
  const store = createStore(directory);
  try { claimService(store); } catch (error) { store.close(); throw error; }
  const auth = createAuth(store);
  const models = createModels(store, vault, providerClient);
  const indexer = createIndexer(store, models, providerClient);
  const assessment = createAssessment(store, models, indexer, providerClient, { directory, python });
  let parsing = 0;
  const server = http.createServer(async (request, response) => {
    const json = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const host = request.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new ApiError(403, '仅允许本机访问。');
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, '请从本机 QSA 页面执行操作。');
        const path = url.pathname;
        const method = request.method;
        if (path === '/api/health' && method === 'GET') return json(200, { status: 'ok', storage: 'sqlite', schemaVersion: 4, maxUploadBytes: MAX_UPLOAD });
        if (path === '/api/auth/status' && method === 'GET') return json(200, auth.status(request));
        if (path === '/api/auth/setup' && method === 'POST') return json(201, await auth.setup(request, response, await readJson(request)));
        if (path === '/api/auth/login' && method === 'POST') return json(200, await auth.login(request, response, await readJson(request)));
        if (path === '/api/auth/logout' && method === 'POST') { await readJson(request); return json(200, auth.logout(request, response)); }
        auth.requireAdmin(request);
        if (path === '/api/assessment/current' && method === 'GET') return json(200, assessment.current());
        if (path === '/api/assessment/tasks' && method === 'GET') return json(200, assessment.history(url.searchParams));
        const assessmentInput = path.match(/^\/api\/assessment\/inputs\/([a-f0-9-]+)$/);
        if (assessmentInput && method === 'GET') return json(200, { input: assessment.input(assessmentInput[1]) });
        if (path === '/api/assessment/tasks' && method === 'POST') return json(202, { task: await assessment.start(await readJson(request)) });
        const assessmentTask = path.match(/^\/api\/assessment\/tasks\/([a-f0-9-]+)(?:\/(retry|cancel|export|restore))?$/);
        if (assessmentTask) {
          const [, id, action] = assessmentTask;
          if (!action && method === 'GET') return json(200, { task: assessment.task(id) });
          if (!action && method === 'DELETE') { await readJson(request); return json(200, assessment.remove(id)); }
          if (action === 'restore' && method === 'POST') { await readJson(request); return json(200, assessment.restore(id)); }
          if (action === 'retry' && method === 'POST') { await readJson(request); return json(202, { task: await assessment.retry(id) }); }
          if (action === 'cancel' && method === 'POST') { await readJson(request); return json(200, assessment.cancel(id)); }
          if (action === 'export' && method === 'GET') {
            const exported = await assessment.export(id);
            response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="assessment.xlsx"; filename*=UTF-8''${encodeURIComponent(exported.name)}` });
            return response.end(exported.bytes);
          }
        }
        if (path === '/api/assessment/inputs' && method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/octet-stream')) throw new ApiError(415, '请上传 .xlsx 待填表。');
          let name;
          try { name = decodeURIComponent(request.headers['x-file-name'] || ''); } catch { throw new ApiError(400, '文件名无效。'); }
          if (!name || name.length > 180 || /[\\/\x00-\x1f]/.test(name) || !/\.xlsx$/i.test(name)) throw new ApiError(400, '请选择文件名不超过 180 字的 .xlsx 待填表。');
          if (parsing >= 2) throw new ApiError(429, '已有文件正在解析，请稍后重试。');
          parsing++;
          const id = randomUUID(), filePath = join(directory, 'files', `${id}.xlsx`); let keep = false;
          try {
            const bytes = await readBody(request, MAX_UPLOAD);
            if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new ApiError(422, '文件不是有效的 .xlsx。');
            await writeFile(filePath, bytes, { flag: 'wx' });
            const parsed = await assessmentWorkbook(python, ['parse', filePath]);
            const result = await assessment.import({ id, name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString() }, parsed);
            keep = !result.duplicate; return json(201, result);
          } finally { if (!keep) await unlink(filePath).catch(() => {}); parsing--; }
        }
        if (path === '/api/models' && method === 'GET') return json(200, { models: models.list() });
        if (path === '/api/models' && method === 'POST') return json(201, { model: await models.save(await readJson(request)) });
        if (path === '/api/models/test' && method === 'POST') return json(200, await models.testDraft(await readJson(request)));
        const modelMatch = path.match(/^\/api\/models\/([a-f0-9-]+)(?:\/(test|default))?$/);
        if (modelMatch) {
          const [, id, action] = modelMatch;
          if (action === 'test' && method === 'POST') { const data = await readJson(request); return json(200, await models.testSaved(id, data.expectedRevision)); }
          if (action === 'default' && method === 'POST') { await readJson(request); return json(200, { model: models.setDefault(id) }); }
          if (!action && method === 'PUT') return json(200, { model: await models.save(await readJson(request), id) });
          if (!action && method === 'DELETE') { const data = await readJson(request); return json(200, models.remove(id, data.expectedRevision)); }
        }
        const trainingMatch = path.match(/^\/api\/knowledge\/([a-f0-9-]+)\/(training|retrieve|retrieval-settings)$/);
        if (trainingMatch) {
          const [, id, action] = trainingMatch;
          if (action === 'retrieval-settings' && method === 'GET') return json(200, indexer.settings(id));
          if (action === 'retrieval-settings' && method === 'PUT') return json(200, indexer.saveSettings(id, await readJson(request)));
          if (action === 'training' && method === 'GET') return json(200, indexer.state(id));
          if (action === 'training' && method === 'POST') return json(202, { job: await indexer.start(id, await readJson(request)) });
          if (action === 'retrieve' && method === 'POST') {
            const controller = new AbortController();
            response.on('close', () => { if (!response.writableEnded) controller.abort(); });
            return json(200, await indexer.retrieve(id, await readJson(request), controller.signal));
          }
        }
        const jobMatch = path.match(/^\/api\/training\/([a-f0-9-]+)(?:\/(cancel))?$/);
        if (jobMatch) {
          if (!jobMatch[2] && method === 'GET') return json(200, { job: indexer.job(jobMatch[1]) });
          if (jobMatch[2] && method === 'POST') { await readJson(request); return json(200, indexer.cancel(jobMatch[1])); }
        }
        if (path === '/api/knowledge' && method === 'GET') return json(200, { projects: store.list(), trash: store.trash() });
        if (path === '/api/knowledge/imports' && method === 'POST') {
          if (!request.headers['content-type']?.startsWith('application/octet-stream')) throw new ApiError(415, '请通过文件选择器上传 .xlsx。');
          let name;
          try { name = decodeURIComponent(request.headers['x-file-name'] || ''); } catch { throw new ApiError(400, '文件名无效。'); }
          if (!name || name.length > 180 || /[\\/\x00-\x1f]/.test(name) || !/\.xlsx$/i.test(name)) throw new ApiError(400, '请选择文件名不超过 180 字的 .xlsx 文件。');
          if (parsing >= 2) throw new ApiError(429, '已有文件正在解析，请稍后重试。');
          parsing++;
          const id = randomUUID();
          const filePath = join(directory, 'files', `${id}.xlsx`);
          let saved = false;
          try {
            const data = await readBody(request, MAX_UPLOAD);
            if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new ApiError(422, '文件不是有效的 .xlsx，请确认文件格式。');
            await writeFile(filePath, data, { flag: 'wx' }); saved = true;
            const parsed = await parseWorkbook(filePath, python);
            const file = { id, name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), createdAt: new Date().toISOString() };
            store.stage(file, parsed);
            return json(201, { importId: id, fileName: name, sha256: file.sha256, summary: parsed.summary, sheets: parsed.sheets, diagnostics: parsed.diagnostics });
          } catch (error) {
            if (saved) await unlink(filePath).catch(() => {});
            throw error;
          } finally { parsing--; }
        }
        const importMatch = path.match(/^\/api\/knowledge\/imports\/([a-f0-9-]+)\/commit$/);
        if (importMatch && method === 'POST') {
          const options = await readJson(request);
          if (!['new', 'replace'].includes(options.mode)) throw new ApiError(400, '请选择新建或替换知识库。');
          if (options.mode === 'replace' && (typeof options.projectId !== 'string' || typeof options.expectedVersionId !== 'string')) throw new ApiError(400, '请选择需要替换的知识库。');
          if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim() || options.name.trim().length > 100)) throw new ApiError(400, '知识库名称应为 1–100 个字。');
          if (options.name) options.name = options.name.trim();
          return json(201, { project: store.commit(importMatch[1], options) });
        }
        const match = path.match(/^\/api\/knowledge\/([a-f0-9-]+)(?:\/(records|versions|diagnostics|restore))?$/);
        if (match) {
          const [, id, action] = match;
          if (action === 'records' && method === 'GET') return json(200, store.records(id, url.searchParams));
          if (action === 'versions' && method === 'GET') return json(200, { versions: store.versions(id) });
          if (action === 'diagnostics' && method === 'GET') return json(200, store.diagnostics(id, url.searchParams.get('version')));
          if (action === 'restore' && method === 'POST') { await readJson(request); return json(200, { project: store.restore(id) }); }
          if (!action && method === 'DELETE') { const body = await readJson(request); return json(200, store.remove(id, body.expectedVersionId)); }
          if (!action && method === 'GET') return json(200, { project: store.getProject(id) });
        }
        throw new ApiError(404, '接口不存在。');
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, '不支持此请求方法。');
      const name = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = resolve(root, name);
      if (!file.startsWith(root + sep) || !allowed.has(name)) throw new ApiError(404, '文件不存在。');
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(error.status || 500, { error: error instanceof ApiError ? error.message : '服务处理失败，请重试。数据未确认保存时不会发布新版本。' });
    }
  });
  server.requestTimeout = 90000;
  return { server, store, models, indexer, assessment, auth };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, store, indexer, assessment } = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口已占用，请关闭旧服务或设置 PORT。' : '本地服务启动失败。'); process.exitCode = 1; store.close(); });
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`QSA: http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(async () => { await assessment.shutdown(); await indexer.shutdown(); store.close(); process.exit(0); }));
}
