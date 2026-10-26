import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './store.mjs';
import { modelFingerprint } from './models.mjs';
import { providerError } from './providers.mjs';
import { rankRecords, normalizedVector, vectorBlob, fuseCandidates } from './retrieval.mjs';
import { retrievalConfig } from './retrieval-config.mjs';

export function createIndexer(store, models, client) {
  const recordHash = record => createHash('sha256').update(`${record.chapter}\n${record.question}\n${record.answer}`).digest('hex');
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS training_jobs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES knowledge_projects(id), version_id TEXT NOT NULL REFERENCES knowledge_versions(id),
    model_id TEXT NOT NULL REFERENCES model_configs(id), model_revision INTEGER NOT NULL, config_json TEXT NOT NULL, model_snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL, stage INTEGER NOT NULL, processed INTEGER NOT NULL, total INTEGER NOT NULL, error TEXT,
    index_id TEXT NOT NULL REFERENCES knowledge_indexes(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS index_vectors (index_id TEXT NOT NULL REFERENCES knowledge_indexes(id),record_id TEXT NOT NULL REFERENCES knowledge_records(id),vector BLOB NOT NULL,PRIMARY KEY(index_id,record_id));
    CREATE TABLE IF NOT EXISTS retrieval_settings (project_id TEXT PRIMARY KEY REFERENCES knowledge_projects(id),config_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_project ON training_jobs(project_id,created_at);
    INSERT OR IGNORE INTO schema_migrations VALUES (2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
  db.exec("INSERT OR IGNORE INTO schema_migrations VALUES (4,strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  const interruptedAt = new Date().toISOString();
  store.transaction(() => {
    db.prepare("UPDATE training_jobs SET status='failed',error='服务重启，训练已中断，请重新开始。',finished_at=?,updated_at=? WHERE status='running'").run(interruptedAt, interruptedAt);
    db.prepare("DELETE FROM index_vectors WHERE index_id IN (SELECT id FROM knowledge_indexes WHERE status='building')").run();
    db.prepare("UPDATE knowledge_indexes SET status='failed' WHERE status='building'").run();
  });
  const active = new Map();
  function job(id) {
    const row = db.prepare('SELECT * FROM training_jobs WHERE id=?').get(id);
    if (!row) throw new ApiError(404, '训练任务不存在。');
    return { id: row.id, projectId: row.project_id, versionId: row.version_id, modelId: row.model_id, modelRevision: row.model_revision,
      config: JSON.parse(row.config_json), model: JSON.parse(row.model_snapshot_json), status: row.status, stage: row.stage, processed: row.processed,
      total: row.total, error: row.error, indexId: row.index_id, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at };
  }
  function update(id, values) {
    const allowed = ['stage', 'processed', 'total', 'status', 'error', 'finished_at'];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    db.prepare(`UPDATE training_jobs SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), new Date().toISOString(), id);
  }
  function latestIndex(projectId) {
    return db.prepare(`SELECT i.* FROM knowledge_indexes i JOIN knowledge_versions v ON v.id=i.version_id WHERE v.project_id=? AND i.status='ready' ORDER BY i.created_at DESC,i.rowid DESC LIMIT 1`).get(projectId);
  }
  function settings(projectId) {
    store.getProject(projectId);
    const row = db.prepare('SELECT * FROM retrieval_settings WHERE project_id=?').get(projectId);
    const previous = latestIndex(projectId);
    const prior = previous ? JSON.parse(previous.config_json) : {};
    return { config: retrievalConfig(row ? JSON.parse(row.config_json) : { rerankModelId: prior.rerankModelId || null }), revision: row?.revision || 0, updatedAt: row?.updated_at || null };
  }
  function checkRerank(config) {
    if (!config.rerankModelId) return;
    const model = models.get(config.rerankModelId);
    if (model.type !== 'rerank' || !model.lastTest?.success) throw new ApiError(400, '请选择已通过连接测试的重排模型。');
  }
  function writeSettings(projectId, config, expectedRevision) {
    const current = settings(projectId);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new ApiError(409, '检索设置已变化，请重新加载后保存。');
    db.prepare('INSERT INTO retrieval_settings VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at').run(projectId, JSON.stringify(config), current.revision + 1, new Date().toISOString());
  }
  function indexState(projectId) {
    const project = store.getProject(projectId);
    const row = latestIndex(projectId);
    if (!row) return { index: null, ready: false, staleReason: null };
    const config = JSON.parse(row.config_json);
    let staleReason = row.version_id !== project.versionId ? '知识库已有新版本，请重建索引。' : null;
    try {
      const model = models.get(row.model_id);
      if (model.type !== 'embedding' || modelFingerprint(model) !== config.modelFingerprint || config.policyVersion !== 'qa-v1') staleReason = '向量模型配置已改变，请重建索引。';
    } catch { staleReason = '原向量模型已删除，请重新配置并重建索引。'; }
    return { index: { id: row.id, versionId: row.version_id, modelId: row.model_id, dimensions: row.dimensions, config, createdAt: row.created_at,
      count: db.prepare('SELECT COUNT(*) count FROM index_vectors WHERE index_id=?').get(row.id).count }, ready: !staleReason, staleReason };
  }
  function corpus(indexId) {
    return db.prepare(`SELECT r.id,r.sheet,r.line,r.chapter,r.question,r.answer,r.question_cell questionCell,r.answer_cell answerCell,v.vector FROM index_vectors v JOIN knowledge_records r ON r.id=v.record_id WHERE v.index_id=? ORDER BY r.sheet,r.line`).all(indexId);
  }
  function checkCurrent(task, config) {
    const current = store.getProject(task.projectId);
    if (current.versionId !== task.versionId) throw new ApiError(409, '训练期间知识库发生变化，请按新版本重建索引。');
    const model = models.get(task.modelId);
    const boundRevision = task.model.inferenceRevision ?? task.modelRevision;
    if (model.inferenceRevision !== boundRevision || modelFingerprint(model) !== config.modelFingerprint) throw new ApiError(409, '训练期间模型调用配置或密钥发生变化，请重新开始。');
  }
  async function run(id, access, records, controller) {
    const task = job(id);
    const reusable = new Map();
    if (task.config.baseIndexId) for (const record of corpus(task.config.baseIndexId)) reusable.set(recordHash(record), record.vector);
    let dimensions = task.config.baseDimensions || null;
    try {
      controller.signal.throwIfAborted();
      checkCurrent(task, task.config);
      update(id, { stage: 1 });
      if (!records.length) throw new ApiError(400, '所选工作表没有可用问答，请补充自评说明后重试。');
      update(id, { stage: 2 });
      for (let offset = 0; offset < records.length; offset += 8) {
        controller.signal.throwIfAborted(); checkCurrent(task, task.config);
        const batch = records.slice(offset, offset + 8);
        const changed = batch.filter(record => !reusable.has(recordHash(record)));
        const vectors = changed.length ? await client.embeddings(access.config, access.key, changed.map(r => `${r.chapter}\n${r.question}\n${r.answer}`), controller.signal) : [];
        controller.signal.throwIfAborted(); checkCurrent(task, task.config);
        dimensions ??= vectors[0]?.length;
        if (vectors.some(vector => vector.length !== dimensions)) throw new ApiError(422, '模型返回向量维度发生变化，请核对服务配置。');
        const computed = new Map(changed.map((record, index) => [record.id, vectorBlob(vectors[index])]));
        store.transaction(() => {
          const insert = db.prepare('INSERT INTO index_vectors VALUES (?,?,?)');
          batch.forEach(record => insert.run(task.indexId, record.id, reusable.get(recordHash(record)) || computed.get(record.id)));
          update(id, { processed: offset + batch.length });
        });
      }
      update(id, { stage: 3 });
      const query = (await client.embeddings(access.config, access.key, [records[0].question], controller.signal))[0];
      controller.signal.throwIfAborted(); checkCurrent(task, task.config);
      if (query.length !== dimensions) throw new ApiError(422, '检索验证返回维度不一致，未发布索引。');
      const verified = rankRecords(corpus(task.indexId), records[0].question, normalizedVector(query), 'vector');
      if (!verified.length || verified.some(r => !Number.isFinite(r.score))) throw new ApiError(422, '检索验证失败，未发布索引。');
      if (!verified.slice(0, 10).some(r => r.id === records[0].id)) throw new ApiError(422, '检索验证未召回原始问题，请检查向量模型后重试。');
      store.transaction(() => {
        checkCurrent(task, task.config);
        db.prepare("UPDATE knowledge_indexes SET dimensions=?,status='ready' WHERE id=?").run(dimensions, task.indexId);
        update(id, { status: 'success', stage: 4, finished_at: new Date().toISOString() });
      });
    } catch (error) {
      store.transaction(() => {
        const cancelled = controller.signal.aborted;
        db.prepare('DELETE FROM index_vectors WHERE index_id=?').run(task.indexId);
        db.prepare("UPDATE knowledge_indexes SET status='failed' WHERE id=?").run(task.indexId);
        update(id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? '训练已取消，可重新开始。' : providerError(error).message, finished_at: new Date().toISOString() });
      });
    } finally { access.key = ''; active.delete(id); }
  }
  return {
    job, settings,
    saveSettings(projectId, input) {
      const project = store.getProject(projectId);
      if (input.expectedVersionId !== project.versionId) throw new ApiError(409, '知识库版本已变化，请重新选择。');
      const config = retrievalConfig({ ...input, retrievalVersion: 2 }); checkRerank(config);
      store.transaction(() => writeSettings(projectId, config, input.expectedRevision));
      return settings(projectId);
    },
    state(projectId) {
      const state = indexState(projectId);
      const latest = db.prepare('SELECT id FROM training_jobs WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(projectId);
      return { ...state, retrievalSettings: settings(projectId), job: latest ? job(latest.id) : null };
    },
    async start(projectId, input) {
      const project = store.getProject(projectId);
      if (project.versionId !== input.expectedVersionId) throw new ApiError(409, '知识库版本已变化，请重新选择。');
      if (!['rebuild','incremental'].includes(input.updateMode)) throw new ApiError(400, '请选择重建索引或增量更新。');
      if (active.size >= 2) throw new ApiError(429, '已有训练任务运行，请稍后再开始。');
      if (!Array.isArray(input.sheets) || !input.sheets.length || input.sheets.length !== new Set(input.sheets).size || input.sheets.some(name => !Object.hasOwn(project.sheets, name))) throw new ApiError(400, '请选择有效的工作表范围。');
      const retrieval = retrievalConfig({ ...input, retrievalVersion: 2 }); checkRerank(retrieval);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) throw new ApiError(400, '请填写 1–60 字的训练任务名称。');
      if (input.rerankModelId && models.get(input.rerankModelId).type !== 'rerank') throw new ApiError(400, '重排模型类型无效。');
      const access = await models.access(input.modelId, 'embedding', true);
      const placeholders = input.sheets.map(() => '?').join(',');
      const records = db.prepare(`SELECT id,sheet,line,chapter,question,answer FROM knowledge_records WHERE version_id=? AND status='answered' AND sheet IN (${placeholders}) ORDER BY sheet,line`).all(project.versionId, ...input.sheets);
      if (!records.length || records.length > 50000) throw new ApiError(400, '所选工作表没有可用问答，或问答超过 50,000 条。');
      const config = { ...retrieval, name: input.name.trim(), sheets: input.sheets, modelFingerprint: modelFingerprint(access.config), policyVersion: 'qa-v1' };
      config.updateMode = input.updateMode;
      if (input.updateMode === 'incremental') {
        const base = latestIndex(projectId);
        if (!base) throw new ApiError(409, '首次建立索引请使用重建索引。');
        const previousConfig = JSON.parse(base.config_json);
        if (base.model_id !== access.config.id || previousConfig.modelFingerprint !== config.modelFingerprint || previousConfig.policyVersion !== config.policyVersion) throw new ApiError(409, '向量模型或导入规则已变化，请重建索引。');
        const previous = corpus(base.id);
        const hashes = new Set(previous.map(recordHash));
        const locations = new Map(previous.map(record => [`${record.sheet}\0${record.line}`, recordHash(record)]));
        const currentLocations = new Set(records.map(record => `${record.sheet}\0${record.line}`));
        const reused = records.filter(record => hashes.has(recordHash(record))).length;
        config.baseIndexId = base.id; config.baseDimensions = base.dimensions;
        config.changes = { reused, computed: records.length - reused, added: records.filter(record => !locations.has(`${record.sheet}\0${record.line}`)).length, modified: records.filter(record => locations.has(`${record.sheet}\0${record.line}`) && locations.get(`${record.sheet}\0${record.line}`) !== recordHash(record)).length, removed: previous.filter(record => !currentLocations.has(`${record.sheet}\0${record.line}`)).length };
      } else config.changes = { reused: 0, computed: records.length, added: records.length, modified: 0, removed: 0 };
      const id = randomUUID(), indexId = randomUUID(), time = new Date().toISOString();
      store.transaction(() => {
        if (db.prepare("SELECT id FROM training_jobs WHERE project_id=? AND status='running'").get(projectId)) throw new ApiError(409, '该知识库正在训练，请等待或先取消任务。');
        writeSettings(projectId, retrieval, input.retrievalRevision);
        db.prepare('INSERT INTO knowledge_indexes VALUES (?,?,?,?,?,?,?)').run(indexId, project.versionId, access.config.id, 0, JSON.stringify(config), 'building', time);
        db.prepare(`INSERT INTO training_jobs (id,project_id,version_id,model_id,model_revision,config_json,model_snapshot_json,status,stage,processed,total,index_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'running',0,0,?,?,?,?)`).run(id, projectId, project.versionId, access.config.id, access.config.revision, JSON.stringify(config), JSON.stringify(access.config), records.length, indexId, time, time);
      });
      const controller = new AbortController();
      const entry = { controller, done: null }; active.set(id, entry);
      entry.done = new Promise(resolve => setImmediate(() => resolve(run(id, access, records, controller))));
      return job(id);
    },
    cancel(id) {
      const current = job(id);
      if (current.status !== 'running') throw new ApiError(409, '该训练任务已结束。');
      const entry = active.get(id);
      if (!entry) throw new ApiError(409, '训练进程已中断，请刷新任务状态。');
      entry.controller.abort(); return { id, cancelling: true };
    },
    async retrieve(projectId, input, signal) {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.trim().length > 2000) throw new ApiError(400, '请输入 1–2,000 字的检索问题。');
      const state = indexState(projectId);
      if (!state.ready) throw new ApiError(409, state.staleReason || '请先完成知识库训练。');
      const index = state.index;
      const baseConfig = settings(projectId).config;
      const supplied = { ...input };
      // Support old API clients that used topK/threshold for reranking as well.
      if (input.retrievalVersion === undefined) {
        if (input.topK !== undefined && input.rerankTopN === undefined) { supplied.rerankTopN = input.topK; if (input.rerankCandidateLimit === undefined) supplied.rerankCandidateLimit = Math.max(baseConfig.rerankCandidateLimit,input.topK); }
        if (input.threshold !== undefined && input.rerankThreshold === undefined) supplied.rerankThreshold = input.threshold;
      }
      const config = retrievalConfig(supplied, baseConfig);
      const method = config.retrieval, topK = config.topK;
      let queryVector = null;
      if (method !== 'keyword') {
        const access = await models.access(index.modelId, 'embedding');
        const vector = (await client.embeddings(access.config, access.key, [input.query.trim()], signal))[0];
        access.key = '';
        if (vector.length !== index.dimensions) throw new ApiError(409, '查询向量维度发生变化，请重建索引。');
        queryVector = normalizedVector(vector);
      }
      const ranked = rankRecords(corpus(index.id), input.query.trim(), queryVector, method).filter(row => row.score > 0);
      let results = config.retrievalVersion === 1 ? ranked : fuseCandidates(ranked, config);
      const rerankId = config.rerankModelId;
      const rrf = config.retrievalVersion === 2 && method === 'hybrid' && config.fusion === 'rrf';
      const threshold = rerankId ? (config.retrievalVersion === 1 ? config.threshold : config.rerankThreshold) : rrf ? null : config.threshold;
      const returnLimit = rerankId && config.retrievalVersion === 2 ? config.rerankTopN : topK;
      let candidateCount = results.length;
      if (rerankId && results.length) {
        const access = await models.access(rerankId, 'rerank');
        const candidates = results.slice(0, config.retrievalVersion === 1 ? Math.min(50, topK * 3) : config.rerankCandidateLimit);
        candidateCount = candidates.length;
        const reranked = await client.rerank(access.config, access.key, input.query.trim(), candidates.map(r => `${r.question}\n${r.answer}`), Math.min(returnLimit,candidates.length), signal);
        access.key = '';
        results = reranked.map(r => ({ ...candidates[r.index], retrievalScore: candidates[r.index].score, score: r.score, rerankScore: r.score })).sort((a, b) => b.score - a.score);
      }
      const finalState = indexState(projectId);
      if (!finalState.ready || finalState.index.id !== index.id) throw new ApiError(409, '检索期间知识库或索引已更新，请重试。');
      return { indexId: index.id, versionId: index.versionId, method, threshold, topK: returnLimit, config, candidateCount, scoreType: rerankId ? 'rerank' : rrf ? 'rrf' : method, reranked: Boolean(rerankId), results: results.filter(row => threshold === null || row.score >= threshold).slice(0, returnLimit) };
    },
    async shutdown() { const entries = [...active.values()]; entries.forEach(entry => entry.controller.abort()); await Promise.allSettled(entries.map(entry => entry.done)); },
  };
}
