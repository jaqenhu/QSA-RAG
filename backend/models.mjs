import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './store.mjs';
import { validateModel, providerError } from './providers.mjs';

export function modelFingerprint(model) {
  return createHash('sha256').update(JSON.stringify([model.provider, model.baseUrl, model.modelId, model.dimensions])).digest('hex');
}
export function createModels(store, vault, client) {
  const db = store.db;
  function raw(id) {
    const row = db.prepare('SELECT * FROM model_configs WHERE id=?').get(id);
    if (!row) throw new ApiError(404, '模型配置不存在。');
    const metadata = JSON.parse(row.metadata_json);
    if (metadata.deletedAt) throw new ApiError(404, '模型配置已删除。');
    return { ...metadata, id: row.id, type: row.type, secret: row.secret_ref, createdAt: row.created_at };
  }
  function publicModel(model) {
    const { secret, ...config } = model;
    return { ...config, inferenceRevision: config.inferenceRevision ?? config.revision, hasKey: Boolean(secret), fingerprint: modelFingerprint(config) };
  }
  function list() {
    return db.prepare('SELECT id FROM model_configs ORDER BY created_at,id').all().flatMap(row => {
      try { return [publicModel(raw(row.id))]; } catch { return []; }
    });
  }
  function write(model) {
    const { id, type, secret, createdAt, ...metadata } = model;
    db.prepare('INSERT INTO model_configs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,metadata_json=excluded.metadata_json,secret_ref=excluded.secret_ref').run(id, type, JSON.stringify(metadata), secret, createdAt);
  }
  function defaults(type, chosen = null) {
    const candidates = list().filter(item => item.type === type);
    const selected = chosen || candidates.find(item => item.isDefault)?.id || candidates[0]?.id;
    for (const candidate of candidates) {
      const model = raw(candidate.id);
      model.isDefault = model.id === selected;
      write(model);
    }
  }
  function revision(model, expected) {
    if (model.revision !== expected) throw new ApiError(409, '模型配置已更新，请重新打开后再操作。');
  }
  async function prepare(input, existing = null) {
    const config = validateModel(input);
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\x00-\x20]/.test(input.apiKey))) throw new ApiError(400, '密钥格式无效，请去掉空格和换行。');
    let secret = existing?.secret || null;
    if (input.clearKey === true) secret = null;
    if (input.apiKey) secret = await vault.encrypt(input.apiKey);
    if (existing && new URL(config.baseUrl).origin !== new URL(existing.baseUrl).origin && secret && !input.apiKey && input.clearKey !== true) throw new ApiError(400, '更换服务域名时请重新填写密钥，防止把原密钥发送到新地址。');
    return { ...config, secret };
  }
  async function credentials(model) {
    if (!model.secret && !(model.provider === 'custom' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(model.baseUrl).hostname))) throw new ApiError(400, '请先在本机模型配置中填写 API Key。');
    return model.secret ? vault.decrypt(model.secret) : '';
  }
  return {
    list,
    get: id => publicModel(raw(id)),
    async save(input, id = null) {
      const old = id ? raw(id) : null;
      if (old) revision(old, input.expectedRevision);
      const prepared = await prepare(input, old);
      return store.transaction(() => {
        if (old) revision(raw(id), input.expectedRevision);
        if (list().some(item => item.id !== id && item.type === prepared.type && item.provider === prepared.provider && item.modelId === prepared.modelId && item.baseUrl === prepared.baseUrl)) throw new ApiError(409, '相同模型配置已存在，请编辑已有配置。');
        const time = new Date().toISOString();
        const inferenceChanged = !old || modelFingerprint(prepared) !== modelFingerprint(old) || prepared.type !== old.type || prepared.secret !== old.secret;
        const model = { ...prepared, id: id || randomUUID(), revision: (old?.revision || 0) + 1,
          inferenceRevision: (old?.inferenceRevision ?? old?.revision ?? 0) + Number(inferenceChanged),
          lastTest: inferenceChanged ? null : old.lastTest, createdAt: old?.createdAt || time, updatedAt: time };
        write(model);
        defaults(model.type, model.isDefault ? model.id : null);
        if (old && old.type !== model.type) defaults(old.type);
        return publicModel(raw(model.id));
      });
    },
    remove(id, expectedRevision) {
      return store.transaction(() => {
        const model = raw(id); revision(model, expectedRevision);
        if (db.prepare("SELECT id FROM training_jobs WHERE model_id=? AND status='running' LIMIT 1").get(id)) throw new ApiError(409, '模型正在用于训练，请先取消训练或等待结束。');
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assessment_runs'").get() && db.prepare("SELECT t.id FROM assessment_tasks t JOIN assessment_runs r ON r.task_id=t.id WHERE t.status='running' AND (json_extract(r.snapshot_json,'$.model.id')=? OR json_extract(r.snapshot_json,'$.embedding.id')=? OR json_extract(r.snapshot_json,'$.rerank.id')=?) LIMIT 1").get(id, id, id)) throw new ApiError(409, '模型正在用于自评生成，请先停止任务或等待结束。');
        write({ ...model, secret: null, deletedAt: new Date().toISOString(), isDefault: false }); defaults(model.type);
        return { id };
      });
    },
    setDefault(id) {
      return store.transaction(() => { const model = raw(id); defaults(model.type, id); return publicModel(raw(id)); });
    },
    async access(id, type = null, tested = false) {
      const model = raw(id);
      if (type && model.type !== type) throw new ApiError(400, '所选模型类型不匹配。');
      if (tested && !model.lastTest?.success) throw new ApiError(400, '请先对向量模型执行连接测试，通过后再训练。');
      return { config: publicModel(model), key: await credentials(model) };
    },
    async testSaved(id, expectedRevision) {
      const model = raw(id); revision(model, expectedRevision);
      let result;
      try { result = await client.test(publicModel(model), await credentials(model)); }
      catch (error) { const safe = providerError(error); result = { success: false, checkedAt: new Date().toISOString(), message: safe.message }; }
      return store.transaction(() => {
        const current = raw(id); revision(current, expectedRevision);
        write({ ...current, lastTest: result }); return { result, model: publicModel(raw(id)) };
      });
    },
    async testDraft(input) {
      const old = input.id ? raw(input.id) : null;
      if (old) revision(old, input.expectedRevision);
      const config = await prepare(input, old);
      try { return { result: await client.test(config, await credentials(config)) }; }
      catch (error) { throw providerError(error); }
    },
  };
}
