import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, unlink } from 'node:fs/promises';
import { ApiError } from './store.mjs';
import { providerError } from './providers.mjs';
import { groundedResult } from './assessment-output.mjs';
import { legacyAssessmentRetrieval } from './retrieval-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function assessmentWorkbook(python, args, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-X', 'utf8', join(root, 'backend', 'assessment_workbook.py'), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new ApiError(422, '待填表处理超时，请精简文件后重试。')); }, 60000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 40 * 1024 * 1024) { child.kill(); finish(new ApiError(422, '待填表内容过大，请拆分文件。')); } else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => finish(new ApiError(503, '无法启动 Excel 处理，请确认 Python 及解析依赖可用。')));
    child.on('close', () => { try { const response = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!response.ok) throw new ApiError(422, response.error); finish(null, response.data); } catch (error) { finish(error instanceof ApiError ? error : new ApiError(422, 'Excel 处理未完成，请重试。')); } });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

export function failureLabel(row) {
  if (row.errorCode === 'MODEL_EVIDENCE_INVALID') return '引用校验失败';
  if (row.errorCode === 'MODEL_NETWORK_ERROR') return '网络连接异常';
  if (row.errorCode === 'MODEL_TIMEOUT') return '调用超时';
  // Historical rows may predate diagnostic codes. Only classify unambiguous text.
  const text = row.error || row.answer || '';
  if (/引用不属于候选 C 列原文|依据状态与引用不一致|引用校验失败/.test(text)) return '引用校验失败';
  if (/网络连接异常/.test(text)) return '网络连接异常';
  if (!['ASSESSMENT_CANCELLED', 'MODEL_CANCELLED'].includes(row.errorCode) && !/任务已停止|服务重启/.test(text) && /调用超时|模型请求已取消或超时/.test(text)) return '调用超时';
  return '调用失败';
}
const taskErrorPresentation = error => error?.replace(/^(\d+) 项调用失败，可重试失败项。$/, '$1 项生成失败，可重试失败项。') ?? error;
export function resultPresentation(row) {
  const label = row.status === 'failed' ? failureLabel(row) : '';
  const basis = { direct: '可直接复用', partial: '部分有依据', missing: '无相关信息', failed: label }[row.status] || '';
  const details = row.status === 'direct' ? '/' : row.status === 'partial' ? row.gap || '' : row.status === 'missing' ? '没有搜索到相关信息' : row.status === 'failed' ? label : '';
  if (row.status !== 'failed' || label === '调用失败') return { ...row, basis, details };
  const reason = row.error || row.answer?.replace(/^生成失败[：:]\s*/, '') || '';
  const error = reason.startsWith(label) ? reason : `${label}：${reason}`;
  return { ...row, answer: `生成失败：${error}`, error, basis, details };
}

export { groundedResult } from './assessment-output.mjs';

export function createAssessment(store, models, indexer, client, { directory, python }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_inputs (id TEXT PRIMARY KEY REFERENCES files(id),parsed_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_workspace (id INTEGER PRIMARY KEY CHECK(id=1),input_id TEXT NOT NULL REFERENCES assessment_inputs(id));
    CREATE TABLE IF NOT EXISTS assessment_runs (task_id TEXT PRIMARY KEY REFERENCES assessment_tasks(id),project_id TEXT NOT NULL,index_id TEXT NOT NULL,input_id TEXT NOT NULL REFERENCES assessment_inputs(id),snapshot_json TEXT NOT NULL,total INTEGER NOT NULL,processed INTEGER NOT NULL DEFAULT 0,error TEXT,retry_of TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_item_details (result_id TEXT PRIMARY KEY REFERENCES assessment_results(id),position INTEGER NOT NULL,input_record_id TEXT NOT NULL,result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assessment_deleted_tasks (task_id TEXT PRIMARY KEY REFERENCES assessment_tasks(id),deleted_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS assessment_unique_row ON assessment_results(task_id,input_sheet,input_row);
    INSERT OR IGNORE INTO schema_migrations VALUES (3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
  const interrupted = db.prepare("SELECT id FROM assessment_tasks WHERE status='running'").all();
  store.transaction(() => {
    for (const { id } of interrupted) {
      const time = new Date().toISOString();
      db.prepare("UPDATE assessment_tasks SET status='failed',finished_at=? WHERE id=?").run(time, id);
      db.prepare("UPDATE assessment_runs SET error='服务重启，任务已中断；已完成结果保留，可重试失败项。',processed=total,updated_at=? WHERE task_id=?").run(time, id);
      db.prepare("UPDATE assessment_results SET status='failed',answer='生成失败：服务重启，请重试。' WHERE task_id=? AND status IN ('pending','running')").run(id);
    }
    // Reclassify existing completed tasks from their persisted item outcomes.
    db.exec(`UPDATE assessment_tasks SET status=CASE
      WHEN NOT EXISTS(SELECT 1 FROM assessment_results r WHERE r.task_id=assessment_tasks.id AND r.status='failed') THEN 'success'
      WHEN EXISTS(SELECT 1 FROM assessment_results r WHERE r.task_id=assessment_tasks.id AND r.status IN ('direct','partial','missing')) THEN 'partial_success'
      ELSE 'failed' END
      WHERE status IN ('success','partial_success','failed') AND id IN (SELECT task_id FROM assessment_runs);`);
  });
  const active = new Map();
  function input(id) {
    const item = db.prepare('SELECT i.*,f.name,f.sha256 FROM assessment_inputs i JOIN files f ON f.id=i.id WHERE i.id=?').get(id);
    if (!item) throw new ApiError(404, '待填表不存在，请重新上传。');
    const parsed = JSON.parse(item.parsed_json);
    for (const sheet of parsed.sheets) if (!sheet.basisColumn && sheet.sourceColumn) {
      let number = [...sheet.sourceColumn].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) + 2;
      let column = ''; while (number) { number--; column = String.fromCharCode(65 + number % 26) + column; number = Math.floor(number / 26); }
      sheet.basisColumn = 'D'; sheet.detailsColumn = 'E'; sheet.sourceColumn = column;
    }
    return { id: item.id, name: item.name, sha256: item.sha256, createdAt: item.created_at, ...parsed };
  }
  function task(id) {
    const item = db.prepare('SELECT t.*,r.* FROM assessment_tasks t JOIN assessment_runs r ON r.task_id=t.id WHERE t.id=? AND NOT EXISTS(SELECT 1 FROM assessment_deleted_tasks d WHERE d.task_id=t.id)').get(id);
    if (!item) throw new ApiError(404, '自评任务不存在。');
    const snapshot = JSON.parse(item.snapshot_json);
    const results = db.prepare('SELECT r.*,d.* FROM assessment_results r JOIN assessment_item_details d ON d.result_id=r.id WHERE r.task_id=? ORDER BY d.position').all(id).map(row => resultPresentation({ ...JSON.parse(row.result_json), id: row.id, status: row.status, answer: row.answer }));
    const counts = Object.fromEntries(['direct', 'partial', 'missing', 'failed', 'pending', 'running'].map(status => [status, results.filter(row => row.status === status).length]));
    const progressItems = [...(active.get(id)?.stages?.values() || [])];
    const progress = { processed: item.processed, total: item.total, percent: item.total ? Math.floor(item.processed / item.total * 100) : 0,
      stage: item.status !== 'running' ? 'complete' : item.processed === item.total ? 'summarizing' : progressItems.length ? 'processing' : 'preparing', items: progressItems };
    return { id, inputId: item.input_id, projectId: item.project_id, indexId: item.index_id, versionId: item.knowledge_version_id, snapshot, status: item.status, total: item.total, processed: item.processed, counts, error: taskErrorPresentation(item.error), retryOf: item.retry_of, createdAt: item.created_at, finishedAt: item.finished_at, progress, results };
  }
  function storeResult(id, resultId, value) {
    store.transaction(() => {
      db.prepare('UPDATE assessment_results SET answer=?,status=? WHERE id=? AND task_id=?').run(value.answer, value.status, resultId, id);
      db.prepare('UPDATE assessment_item_details SET result_json=? WHERE result_id=?').run(JSON.stringify(value), resultId);
      db.prepare('DELETE FROM result_sources WHERE result_id=?').run(resultId);
      for (const source of value.sources || []) db.prepare('INSERT INTO result_sources VALUES (?,?,?)').run(resultId, source.recordId, source.excerpt);
      db.prepare("UPDATE assessment_runs SET processed=(SELECT COUNT(*) FROM assessment_results WHERE task_id=? AND status NOT IN ('pending','running')),updated_at=? WHERE task_id=?").run(id, new Date().toISOString(), id);
    });
  }
  function assertCurrent(run) {
    const current = indexer.state(run.projectId);
    if (!current.ready || current.index.id !== run.indexId || current.index.versionId !== run.versionId) throw new ApiError(409, '知识库或索引已变化，已停止生成，请重新开始。');
    for (const bound of [run.snapshot.model, run.snapshot.embedding, run.snapshot.rerank].filter(Boolean)) {
      const currentModel = models.get(bound.id);
      if (currentModel.inferenceRevision !== bound.inferenceRevision) throw new ApiError(409, '模型调用配置或密钥已改变，请重新开始。');
    }
  }
  async function execute(id, access, controller) {
    const run = task(id); let next = 0;
    const stages = active.get(id).stages;
    const updateStage = (row, stage) => stages.set(row.id, { inputRecordId: row.inputRecordId, position: row.position, sheet: row.sheet, line: row.line, questionCell: row.questionCell, answerCell: row.answerCell, stage });
    const items = run.results.filter(row => row.status === 'pending');
    const worker = async () => {
      while (next < items.length) {
        const row = items[next++];
        if (controller.signal.aborted) break;
        db.prepare("UPDATE assessment_results SET status='running' WHERE id=?").run(row.id);
        try {
          updateStage(row, 'retrieving');
          assertCurrent(run);
          const retrieved = await indexer.retrieve(run.projectId, { ...(run.snapshot.retrieval || legacyAssessmentRetrieval(run.snapshot)), query: row.question }, controller.signal);
          if (retrieved.indexId !== run.indexId) throw new ApiError(409, '索引已更新，请重新开始。');
          const candidates = retrieved.results;
          let value;
          if (candidates.length) {
            updateStage(row, 'generating');
            const output = await client.assess(access.config, access.key, row.question, candidates, controller.signal);
            updateStage(row, 'validating');
            value = { ...groundedResult(output, candidates), generationAttempts: output.assessmentMeta?.attempts || 1, outputMode: output.assessmentMeta?.mode || null };
          } else {
            updateStage(row, 'validating');
            value = { status: 'missing', answer: '没有相关信息。', gap: '', coverage: [{ text: row.question, supported: false }], sources: [] };
          }
          assertCurrent(run); controller.signal.throwIfAborted();
          value = { ...row, ...value, error: null, errorCode: null, errorStage: null, errorIssues: [], attempts: value.generationAttempts || 0, generatedBy: { taskId: id, modelId: run.snapshot.model.modelId, inferenceRevision: run.snapshot.model.inferenceRevision } };
          storeResult(id, row.id, value);
        } catch (error) {
          const safe = controller.signal.aborted ? Object.assign(new ApiError(422, '任务已停止，未完成该题。'), { code: 'ASSESSMENT_CANCELLED' }) : providerError(error);
          const message = controller.signal.aborted ? '任务已停止，未完成该题。' : safe.message;
          storeResult(id, row.id, { ...row, status: 'failed', answer: '生成失败：' + message, error: message, errorCode: safe.code || 'ASSESSMENT_FAILED', errorStage: safe.stage || stages.get(row.id)?.stage || 'preparing', errorIssues: safe.issues || [], attempts: safe.attempts || 1, gap: '', coverage: [], sources: [] });
          if (error.status === 409 || controller.signal.aborted) { controller.abort(message); break; }
        } finally { stages.delete(row.id); }
      }
    };
    try {
      await Promise.all([worker(), worker()]);
    } finally {
      // Mark unscheduled rows explicitly; never make a partial task look complete.
      for (const row of task(id).results.filter(row => ['pending', 'running'].includes(row.status))) storeResult(id, row.id, { ...row, status: 'failed', answer: '生成失败：任务已停止，请重试。', error: '任务已停止，请重试。', gap: '', sources: [], coverage: [] });
      const final = task(id); const time = new Date().toISOString();
      store.transaction(() => {
        const status = !final.counts.failed ? 'success' : final.counts.direct + final.counts.partial + final.counts.missing > 0 ? 'partial_success' : 'failed';
        db.prepare('UPDATE assessment_tasks SET status=?,finished_at=? WHERE id=?').run(status, time, id);
        db.prepare('UPDATE assessment_runs SET error=?,updated_at=? WHERE task_id=?').run(controller.signal.aborted ? String(controller.signal.reason || '任务已停止。') : final.counts.failed ? `${final.counts.failed} 项生成失败，可重试失败项。` : null, time, id);
      });
      access.key = ''; active.delete(id);
    }
  }
  async function start(options, retry = null) {
    if (active.size) throw new ApiError(409, '已有自评任务运行，请等待完成或先停止。');
    const workbook = input(options.inputId);
    const project = store.getProject(options.projectId);
    if (project.versionId !== options.expectedVersionId) throw new ApiError(409, '知识库版本已变化，请重新选择。');
    const state = indexer.state(project.id);
    if (!state.ready) throw new ApiError(409, state.staleReason || '请先完成知识库训练。');
    const model = models.get(options.modelId);
    if (model.type !== 'generation' || !model.lastTest?.success) throw new ApiError(400, '请选择已通过连接测试的生成模型。');
    let records = workbook.records;
    if (options.questionIds !== undefined) {
      if (!Array.isArray(options.questionIds) || !options.questionIds.length || new Set(options.questionIds).size !== options.questionIds.length || options.questionIds.some(id => !records.some(row => row.id === id))) throw new ApiError(400, '请选择有效的输入问题。');
      records = records.filter(row => options.questionIds.includes(row.id));
    }
    if (active.size) throw new ApiError(409, '已有自评任务运行。');
    const access = await models.access(model.id, 'generation', true);
    if (active.size) { access.key = ''; throw new ApiError(409, '已有自评任务运行。'); }
    const retrieval = retry ? retry.snapshot.retrieval || legacyAssessmentRetrieval(retry.snapshot) : indexer.settings(project.id).config;
    const snapshot = { input: { id: workbook.id, name: workbook.name, sha256: workbook.sha256, questionCount: workbook.records.length }, knowledge: { id: project.id, name: project.name, versionId: project.versionId, version: project.version }, model: access.config, embedding: models.get(state.index.modelId), rerank: retrieval.rerankModelId ? models.get(retrieval.rerankModelId) : null, retrieval, policyVersion: 'extractive-evidence-v1', outputContract: 'flat-evidence-v2' };
    const id = randomUUID(), time = new Date().toISOString();
    const previous = retry ? new Map(retry.results.map(row => [row.inputRecordId, row])) : new Map();
    store.transaction(() => {
      db.prepare('INSERT INTO assessment_workspace VALUES (1,?) ON CONFLICT(id) DO UPDATE SET input_id=excluded.input_id').run(workbook.id);
      db.prepare("INSERT INTO assessment_tasks VALUES (?,?,?,?, 'running',?,NULL)").run(id, workbook.id, project.versionId, JSON.stringify(access.config), time);
      db.prepare('INSERT INTO assessment_runs (task_id,project_id,index_id,input_id,snapshot_json,total,processed,retry_of,updated_at) VALUES (?,?,?,?,?,?,0,?,?)').run(id, project.id, state.index.id, workbook.id, JSON.stringify(snapshot), records.length, retry?.id || null, time);
      for (const row of records) {
        const resultId = randomUUID(), old = previous.get(row.id);
        const value = old && ['direct', 'partial', 'missing'].includes(old.status) ? { ...old, id: resultId } : { inputRecordId: row.id, position: row.position, sheet: row.sheet, line: row.line, chapter: row.chapter, question: row.question, questionCell: row.questionCell, answerCell: row.answerCell, status: 'pending', answer: '', gap: '', sources: [], coverage: [] };
        db.prepare('INSERT INTO assessment_results VALUES (?,?,?,?,?,?,?)').run(resultId, id, row.sheet, row.line, row.question, value.answer, value.status);
        db.prepare('INSERT INTO assessment_item_details VALUES (?,?,?,?)').run(resultId, row.position, row.id, JSON.stringify(value));
        for (const source of value.sources) db.prepare('INSERT INTO result_sources VALUES (?,?,?)').run(resultId, source.recordId, source.excerpt);
      }
      db.prepare("UPDATE assessment_runs SET processed=(SELECT COUNT(*) FROM assessment_results WHERE task_id=? AND status NOT IN ('pending','running')) WHERE task_id=?").run(id, id);
    });
    const controller = new AbortController();
    const entry = { controller, done: null, stages: new Map() }; active.set(id, entry);
    entry.done = new Promise(resolve => setImmediate(() => resolve(execute(id, access, controller))));
    return task(id);
  }
  return {
    input, task, start,
    history(params) {
      const status = params.get('status') || 'all';
      const date = params.get('date') || 'all';
      const query = (params.get('q') || '').trim().toLowerCase();
      const page = Number(params.get('page') || 1), limit = Number(params.get('limit') || 20);
      if (!['all','success','partial_success','failed'].includes(status) || (date !== 'all' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) || query.length > 200 || !Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, '历史筛选或分页参数无效。');
      const items = db.prepare("SELECT t.id,t.status,t.created_at,t.finished_at,r.total,r.processed,r.error,r.retry_of,r.snapshot_json FROM assessment_tasks t JOIN assessment_runs r ON r.task_id=t.id WHERE t.status IN ('success','partial_success','failed') AND NOT EXISTS(SELECT 1 FROM assessment_deleted_tasks d WHERE d.task_id=t.id) ORDER BY t.created_at DESC,t.rowid DESC").all().map(row => {
        const snapshot = JSON.parse(row.snapshot_json);
        const counts = Object.fromEntries(db.prepare('SELECT status,COUNT(*) count FROM assessment_results WHERE task_id=? GROUP BY status').all(row.id).map(item => [item.status,item.count]));
        return { id: row.id, status: row.status, createdAt: row.created_at, finishedAt: row.finished_at, total: row.total, counts, error: taskErrorPresentation(row.error), retryOf: row.retry_of, input: snapshot.input, knowledge: snapshot.knowledge, model: { id: snapshot.model.id, name: snapshot.model.name, modelId: snapshot.model.modelId } };
      });
      const day = time => new Date(new Date(time).getTime() + 8 * 3600000).toISOString().slice(0,10);
      const dated = items.filter(item => (date === 'all' || day(item.createdAt) === date) && `${item.id} ${item.input.name} ${item.knowledge.name} ${item.model.modelId}`.toLowerCase().includes(query));
      const filtered = dated.filter(item => status === 'all' || item.status === status);
      return { tasks: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit, counts: { all: dated.length, success: dated.filter(item => item.status === 'success').length, partial_success: dated.filter(item => item.status === 'partial_success').length, failed: dated.filter(item => item.status === 'failed').length }, dates: [...new Set(items.map(item => day(item.createdAt)))], running: db.prepare("SELECT id FROM assessment_tasks WHERE status='running' ORDER BY created_at DESC LIMIT 1").get()?.id || null };
    },
    remove(id) {
      const run = task(id);
      if (run.status === 'running' || active.has(id)) throw new ApiError(409, '任务正在生成，请先停止再删除。');
      db.prepare('INSERT INTO assessment_deleted_tasks VALUES (?,?)').run(id, new Date().toISOString());
      return { id, deleted: true };
    },
    restore(id) {
      if (!db.prepare('SELECT task_id FROM assessment_deleted_tasks WHERE task_id=?').get(id)) throw new ApiError(404, '没有可恢复的任务记录。');
      db.prepare('DELETE FROM assessment_deleted_tasks WHERE task_id=?').run(id);
      return { task: task(id) };
    },
    current() {
      const latestInput = db.prepare('SELECT input_id id FROM assessment_workspace WHERE id=1').get() || db.prepare('SELECT id FROM assessment_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
      const latestTask = latestInput ? db.prepare('SELECT r.task_id FROM assessment_runs r WHERE r.input_id=? AND NOT EXISTS(SELECT 1 FROM assessment_deleted_tasks d WHERE d.task_id=r.task_id) ORDER BY r.rowid DESC LIMIT 1').get(latestInput.id) : null;
      return { input: latestInput ? input(latestInput.id) : null, task: latestTask ? task(latestTask.task_id) : null };
    },
    async import(file, parsed) {
      // Each successful selection starts a new input session, even for identical bytes.
      // Keep original filenames and task associations immutable for historical exports.
      store.transaction(() => {
        db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run(file.id, file.name, file.sha256, file.bytes, file.createdAt);
        db.prepare('INSERT INTO assessment_inputs VALUES (?,?,?)').run(file.id, JSON.stringify(parsed), file.createdAt);
        db.prepare('INSERT INTO assessment_workspace VALUES (1,?) ON CONFLICT(id) DO UPDATE SET input_id=excluded.input_id').run(file.id);
      });
      return { input: input(file.id), duplicate: false };
    },
    async retry(id) {
      const old = task(id);
      if (old.status === 'running' || !old.counts.failed) throw new ApiError(409, '当前没有可重试的失败项。');
      const state = indexer.state(old.projectId);
      const prior = db.prepare('SELECT config_json FROM knowledge_indexes WHERE id=?').get(old.indexId);
      const priorConfig = prior ? JSON.parse(prior.config_json) : null;
      if (!state.ready || state.index.versionId !== old.versionId || !priorConfig || priorConfig.modelFingerprint !== state.index.config.modelFingerprint || priorConfig.policyVersion !== state.index.config.policyVersion || JSON.stringify([...priorConfig.sheets].sort()) !== JSON.stringify([...state.index.config.sheets].sort())) throw new ApiError(409, '原知识库版本、模型或索引范围已改变，请重新创建任务。');
      return start({ inputId: old.inputId, projectId: old.projectId, expectedVersionId: old.versionId, modelId: old.snapshot.model.id, questionIds: old.results.map(row => row.inputRecordId) }, old);
    },
    cancel(id) { const entry = active.get(id); if (!entry) throw new ApiError(409, '任务已结束，请刷新状态。'); entry.controller.abort('用户停止了任务，已完成结果保留。'); return { id, stopping: true }; },
    async export(id) {
      const run = task(id);
      if (run.status === 'running') throw new ApiError(409, '请等待任务完成或先停止，再导出。');
      const workbook = input(run.inputId);
      const original = join(directory, 'files', `${run.inputId}.xlsx`);
      const before = createHash('sha256').update(await readFile(original)).digest('hex');
      if (before !== workbook.sha256) throw new ApiError(409, '原始待填表副本校验失败，未导出。');
      const output = join(directory, 'files', `${randomUUID()}.export.xlsx`);
      try {
        await assessmentWorkbook(python, ['export', original, output], { results: run.results.map(row => ({ ...row, sourceText: row.sources.map(source => `${run.snapshot.knowledge.name} · v${run.snapshot.knowledge.version} · ${source.sheet} · 第 ${source.line} 行 · ${source.answerCell}`).join('\n') })) });
        const bytes = await readFile(output);
        return { bytes, name: workbook.name.replace(/\.xlsx$/i, '') + '—自评结果.xlsx' };
      } finally { await unlink(output).catch(() => {}); }
    },
    async shutdown() { const entries = [...active.values()]; for (const entry of entries) entry.controller.abort('服务关闭。'); await Promise.allSettled(entries.map(entry => entry.done)); },
  };
}
