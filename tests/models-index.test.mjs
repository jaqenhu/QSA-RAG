import test from 'node:test';
import { authenticatedFetch as fetch } from './auth-client.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { startMockProvider, createTestVault } from './mock-provider.mjs';

test('模型持久化与完整索引检索流程（隔离 HTTP 服务）', async t => {
  const parent = resolve('.test-data'); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(join(parent, 'models-')); assert.ok(folder.startsWith(parent + sep));
  assert.equal(spawnSync('python', ['-X','utf8','tests/create_fixtures.py',folder]).status, 0);
  const mock = await startMockProvider();
  const vault = createTestVault();
  const client = createProviderClient({ requestTimeout: 1000, fetchImpl: (url, options) => fetch(mock.base + new URL(url).pathname, options) });
  let app, base;
  async function start() { app = createApp({ dataDir: join(folder, 'db'), vault, providerClient: client }); await new Promise(done => app.server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function stop() { await app.indexer.shutdown(); await new Promise(done => app.server.close(done)); app.store.close(); }
  async function api(path, method = 'GET', input, expected = 200) {
    const response = await fetch(base + path, { method, ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
    const text = await response.text(); assert.equal(text.includes('mock-secret-fixture'), false, '接口不得返回密钥');
    const data = JSON.parse(text); assert.equal(response.status, expected, text); return data;
  }
  async function upload(name, options) {
    const response = await fetch(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body: await readFile(join(folder, name)) });
    assert.equal(response.status, 201); const draft = await response.json();
    return (await api(`/api/knowledge/imports/${draft.importId}/commit`, 'POST', options || { mode: 'new' }, 201)).project;
  }
  async function finish(id) { for (let i = 0; i < 120; i++) { const task = (await api(`/api/training/${id}`)).job; if (task.status !== 'running') return task; await delay(30); } throw new Error('Training did not finish'); }
  const model = (type, extra = {}) => ({ name: `${type} 百炼测试`, type, provider: 'bailian', modelId: type === 'generation' ? 'qwen-plus' : type === 'embedding' ? 'text-embedding-v4' : 'qwen3-rerank', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', dimensions: type === 'embedding' ? 8 : null, apiKey: 'mock-secret-fixture', ...extra });
  await start();
  let generation, embedding, rerank, project, training;
  const input = () => ({ name: '测试索引', expectedVersionId: project.versionId, modelId: embedding.id, sheets: Object.keys(project.sheets), updateMode: 'rebuild', retrieval: 'hybrid', topK: 6, threshold: 0.2 });
  try {
    await t.test('同一数据目录拒绝重复启动，保护正在运行的训练', async () => {
      assert.throws(() => createApp({ dataDir: join(folder, 'db'), vault, providerClient: client }), /已有 QSA 服务/);
      assert.deepEqual((await api('/api/models')).models, []);
    });
    await t.test('真实模型类型测试、加密字段隔离与百炼重排路径', async () => {
      assert.deepEqual((await api('/api/models')).models, []);
      for (const type of ['generation','embedding','rerank']) {
        const saved = (await api('/api/models', 'POST', model(type), 201)).model;
        assert.equal(saved.hasKey, true); assert.equal(saved.isDefault, true);
        const tested = await api(`/api/models/${saved.id}/test`, 'POST', { expectedRevision: saved.revision });
        assert.equal(tested.result.success, true, tested.result.message);
        if (type === 'generation') generation = tested.model;
        if (type === 'embedding') embedding = tested.model;
        if (type === 'rerank') rerank = tested.model;
      }
      assert.ok(mock.requests.some(r => r.path === '/compatible-mode/v1/chat/completions' && r.body.enable_thinking === false));
      assert.ok(mock.requests.some(r => r.path === '/api/v1/services/rerank/text-rerank/text-rerank' && r.body.input.documents));
      const row = app.store.db.prepare('SELECT * FROM model_configs WHERE id=?').get(embedding.id);
      assert.equal(row.secret_ref.includes('mock-secret-fixture'), false);
      assert.equal(row.metadata_json.includes('secret'), false);
      await api('/api/models', 'POST', model('embedding'), 409);
      await api('/api/models', 'POST', model('embedding', { baseUrl: 'https://attacker.example/v1' }), 400);
      await api(`/api/models/${embedding.id}`, 'PUT', { ...model('embedding'), expectedRevision: 0 }, 409);
    });
    await t.test('鉴权、类型、维度及超时失败不暴露服务原文', async () => {
      const rejected = (await api('/api/models', 'POST', model('generation', { modelId: 'unauthorized-model', apiKey: 'mock-rejected' }), 201)).model;
      const denied = await api(`/api/models/${rejected.id}/test`, 'POST', { expectedRevision: rejected.revision });
      assert.equal(denied.result.success, false); assert.match(denied.result.message, /鉴权/); assert.equal(denied.result.message.includes('mock-rejected'), false);
      await api('/api/models/test', 'POST', model('embedding', { modelId: 'bad-dimension' }), 422);
      await api('/api/models/test', 'POST', model('generation', { modelId: 'missing-model' }), 422);
      const timeoutClient = createProviderClient({ requestTimeout: 25, fetchImpl: (url, options) => fetch(mock.base + new URL(url).pathname, options) });
      await assert.rejects(timeoutClient.embeddings(model('embedding', { modelId: 'timeout' }), 'mock', ['test']), error => error.status === 504);
      const reverse = await client.embeddings(model('embedding', { modelId: 'reverse' }), 'mock', ['质量手册', '质量目标']);
      assert.ok(reverse[0][0] > reverse[0][1]);
      await assert.rejects(client.embeddings(model('embedding', { modelId: 'duplicate-index' }), 'mock', ['质量手册', '质量目标']), /返回序号/);
    });
    await t.test('只索引有答案记录、分批向量化、真实来源和三种检索', async () => {
      project = await upload('v1.xlsx');
      training = (await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 202)).job;
      const task = await finish(training.id); assert.equal(task.status, 'success', task.error); assert.equal(task.total, 45); assert.equal(task.processed, 45); assert.equal(task.stage, 4);
      assert.ok(mock.requests.filter(r => r.path.endsWith('/embeddings')).every(r => r.body.input.length <= 8));
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready, true);
      for (const method of ['keyword','vector','hybrid']) {
        const found = await api(`/api/knowledge/${project.id}/retrieve`, 'POST', { query: '质量手册', method, threshold: 0.05, topK: 5 });
        assert.ok(found.results.some(r => r.line === 4 && r.answerCell === 'C4' && r.answer.includes('手册')));
        assert.equal(found.results.some(r => !r.answer), false);
        assert.equal(found.results.some(r => Object.hasOwn(r, 'vector')), false);
      }
      const ranked = await api(`/api/knowledge/${project.id}/retrieve`, 'POST', { query: '质量目标', threshold: 0.5, topK: 3, rerankModelId: rerank.id });
      assert.equal(ranked.reranked, true); assert.ok(ranked.results.length > 0);
      const absent = await api(`/api/knowledge/${project.id}/retrieve`, 'POST', { query: '不存在词语xyz', method: 'keyword', threshold: 0.5 });
      assert.equal(absent.results.length, 0);
    });
    await t.test('训练期间只改显示名称不重算向量，也不丢失连接测试状态', async () => {
      mock.behavior.slowMs = 50;
      const renamedJob = (await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 202)).job;
      const renameInput = model('embedding', { name: '只改显示名称', expectedRevision: embedding.revision }); delete renameInput.apiKey;
      const renamed = (await api(`/api/models/${embedding.id}`, 'PUT', renameInput)).model;
      assert.equal(renamed.inferenceRevision, embedding.inferenceRevision);
      assert.equal(renamed.lastTest.success, true);
      assert.equal(renamed.revision, embedding.revision + 1);
      embedding = renamed;
      const completed = await finish(renamedJob.id); assert.equal(completed.status, 'success', completed.error);
      training = renamedJob; mock.behavior.slowMs = 0;
    });
    await t.test('失败或取消重建不发布半成品，仍可查询原索引', async () => {
      mock.behavior.failEmbeddings = true;
      const failed = (await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 202)).job;
      assert.equal((await finish(failed.id)).status, 'failed'); mock.behavior.failEmbeddings = false;
      let state = await api(`/api/knowledge/${project.id}/training`); assert.equal(state.ready, true); assert.equal(state.index.id, training.indexId);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM index_vectors WHERE index_id=?').get(failed.indexId).n, 0);
      mock.behavior.slowMs = 300;
      const cancelled = (await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 202)).job;
      await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 409);
      await api(`/api/models/${embedding.id}`, 'DELETE', { expectedRevision: embedding.revision }, 409);
      await api(`/api/training/${cancelled.id}/cancel`, 'POST', {});
      assert.equal((await finish(cancelled.id)).status, 'cancelled'); mock.behavior.slowMs = 0;
      state = await api(`/api/knowledge/${project.id}/training`); assert.equal(state.index.id, training.indexId);
    });
    await t.test('重启持久化、模型变化及知识库新版本使旧索引失效', async () => {
      await stop(); await start();
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready, true);
      assert.equal((await api('/api/models')).models.find(m => m.id === embedding.id).hasKey, true);
      embedding = (await api(`/api/models/${embedding.id}`, 'PUT', { ...model('embedding', { modelId: 'embedding-new' }), expectedRevision: embedding.revision }, 200)).model;
      await api(`/api/knowledge/${project.id}/retrieve`, 'POST', { query: '质量目标' }, 409);
      await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 400);
      embedding = (await api(`/api/models/${embedding.id}/test`, 'POST', { expectedRevision: embedding.revision })).model;
      const rebuilt = (await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 202)).job;
      assert.equal((await finish(rebuilt.id)).status, 'success');
      project = await upload('v2.xlsx', { mode: 'replace', projectId: project.id, expectedVersionId: project.versionId });
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready, false);
      await api(`/api/knowledge/${project.id}/retrieve`, 'POST', { query: '质量目标' }, 409);
      const changed = (await api(`/api/knowledge/${project.id}/training`, 'POST', input(), 202)).job;
      assert.equal((await finish(changed.id)).status, 'success');
      const found = await api(`/api/knowledge/${project.id}/retrieve`, 'POST', { query: '质量手册', threshold: 0.1 });
      assert.ok(found.results.some(r => r.answer.includes('v2')));
    });
    await t.test('默认模型切换、保留密钥编辑和删除密钥', async () => {
      const extra = (await api('/api/models', 'POST', model('generation', { name: '备用', modelId: 'generation-secondary' }), 201)).model;
      await api(`/api/models/${extra.id}/default`, 'POST', {});
      assert.equal((await api('/api/models')).models.find(m => m.id === generation.id).isDefault, false);
      const changed = model('generation', { name: '备用改名', modelId: 'generation-secondary', expectedRevision: extra.revision }); delete changed.apiKey;
      const edited = (await api(`/api/models/${extra.id}`, 'PUT', changed)).model; assert.equal(edited.hasKey, true);
      const swapped = { ...changed, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', expectedRevision: edited.revision };
      await api(`/api/models/${extra.id}`, 'PUT', swapped, 400);
      await api(`/api/models/${extra.id}`, 'DELETE', { expectedRevision: edited.revision });
      assert.equal(app.store.db.prepare('SELECT secret_ref FROM model_configs WHERE id=?').get(extra.id).secret_ref, null);
    });
    await t.test('模型类型变化同样使索引失效，包括使用默认维度的模型', async () => {
      const alternative = (await api('/api/models', 'POST', model('embedding', { modelId: 'type-change', dimensions: null }), 201)).model;
      await api(`/api/models/${alternative.id}/test`, 'POST', { expectedRevision: alternative.revision });
      const indexed = (await api(`/api/knowledge/${project.id}/training`, 'POST', { ...input(), modelId: alternative.id }, 202)).job;
      assert.equal((await finish(indexed.id)).status, 'success');
      const changed = (await api(`/api/models/${alternative.id}`, 'PUT', { ...model('generation', { modelId: 'type-change', dimensions: null }), expectedRevision: alternative.revision })).model;
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready, false);
      await api(`/api/models/${alternative.id}`, 'PUT', { ...model('embedding', { modelId: 'type-change', dimensions: null }), expectedRevision: changed.revision });
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready, true);
    });
    await t.test('启动恢复中断任务，不自动重新调用模型或发布半成品', async () => {
      const interrupted = app.store.db.prepare("SELECT id,index_id FROM training_jobs WHERE status='failed' LIMIT 1").get();
      assert.ok(interrupted);
      app.store.db.prepare("UPDATE training_jobs SET status='running' WHERE id=?").run(interrupted.id);
      app.store.db.prepare("UPDATE knowledge_indexes SET status='building' WHERE id=?").run(interrupted.index_id);
      const requestsBefore = mock.requests.length;
      await stop(); await start();
      const recovered = (await api(`/api/training/${interrupted.id}`)).job;
      assert.equal(recovered.status, 'failed'); assert.match(recovered.error, /重启/);
      assert.equal(mock.requests.length, requestsBefore);
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready, true);
    });
  } finally { await stop(); await mock.close(); await rm(folder, { recursive: true, force: true }); }
});
