import test from 'node:test';
import { authenticatedFetch as fetch } from './auth-client.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { mkdirSync } from 'node:fs';
import http from 'node:http';

test('真实导入、来源定位、版本事务、删除恢复与重启持久化', async t => {
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, 'knowledge-'));
  assert.ok(temp.startsWith(parent + sep));
  const generated = spawnSync(process.env.QSA_PYTHON || 'python', ['-X', 'utf8', 'tests/create_fixtures.py', temp], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  let app, base;
  async function start() {
    app = createApp({ dataDir: join(temp, 'db') });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() { await new Promise(done => app.server.close(done)); app.store.close(); }
  async function api(path, method = 'GET', body, expected = 200) {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  async function upload(name, expected = 201) {
    const response = await fetch(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: await readFile(join(temp, name)) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  await start();
  try {
    await t.test('初始为空，未导入示例；数据库与路径不对外开放', async () => {
      assert.deepEqual((await api('/api/knowledge')).projects, []);
      assert.equal((await api('/api/health')).storage, 'sqlite');
      for (const path of ['/.data/qsa.sqlite', '/backend/store.mjs', '/server.mjs', '/.env']) assert.equal((await fetch(base + path)).status, 404);
      assert.equal((await fetch(base + '/api/knowledge', { headers: { Origin: 'https://example.com' } })).status, 403);
      const foreignHostStatus = await new Promise((done, reject) => {
        const request = http.get(base + '/api/knowledge', { headers: { Host: 'attacker.example' } }, response => { response.resume(); done(response.statusCode); });
        request.on('error', reject);
      });
      assert.equal(foreignHostStatus, 403);
    });
    let draft, first, second;
    await t.test('解析不依赖 A 列、忽略 D 列，保留缺失说明和合并来源', async () => {
      draft = await upload('v1.xlsx');
      assert.equal(draft.summary.questionCount, 48);
      assert.equal(draft.summary.missingCount, 3);
      assert.equal(draft.summary.answeredCount, 45);
      assert.ok(draft.diagnostics.some(d => d.reason.includes('整表跳过')));
      assert.equal((await api('/api/knowledge')).projects.length, 0, '解析草稿不应发布为项目');
      first = (await api(`/api/knowledge/imports/${draft.importId}/commit`, 'POST', { mode: 'new', name: '测试知识库' }, 201)).project;
      const data = await api(`/api/knowledge/${first.id}/records?limit=100`);
      assert.equal(data.total, 48);
      const row = data.records.find(r => r.line === 4 && r.sheet.startsWith('质量'));
      assert.equal(row.answer, '已建立质量手册 v1'); assert.equal(row.chapter, '章节一');
      assert.equal(row.questionCell, 'B4'); assert.equal(row.answerCell, 'C4');
      assert.equal(data.records.find(r => r.line === 7).answerCell, 'C6');
      assert.ok(data.records.some(r => r.sheet === '隐藏表'));
      assert.equal((await api(`/api/knowledge/${first.id}/records?status=missing`)).total, 3);
      assert.equal((await api(`/api/knowledge/${first.id}/records?q=${encodeURIComponent('过时')}`)).total, 0);
      assert.equal((await api(`/api/knowledge/${first.id}/records?q=${encodeURIComponent('<img')}`)).total, 1);
      assert.equal((await api(`/api/knowledge/${first.id}/records?limit=30&page=2`)).records.length, 18);
      assert.equal((await api(`/api/knowledge/${first.id}/records?page=Infinity`, 'GET', undefined, 400)).error, '分页参数无效。');
    });
    await t.test('重复提交、重复替换及过期替换均不产生新版本', async () => {
      await api(`/api/knowledge/imports/${draft.importId}/commit`, 'POST', { mode: 'new' }, 409);
      const same = await upload('v1.xlsx');
      await api(`/api/knowledge/imports/${same.importId}/commit`, 'POST', { mode: 'replace', projectId: first.id, expectedVersionId: first.versionId }, 409);
      const updated = await upload('v2.xlsx');
      await api(`/api/knowledge/imports/${updated.importId}/commit`, 'POST', { mode: 'replace', projectId: first.id, expectedVersionId: 'outdated' }, 409);
      second = (await api(`/api/knowledge/imports/${updated.importId}/commit`, 'POST', { mode: 'replace', projectId: first.id, expectedVersionId: first.versionId }, 201)).project;
      assert.equal(second.id, first.id); assert.equal(second.version, 2);
      assert.equal((await api(`/api/knowledge/${first.id}/versions`)).versions.length, 2);
      const old = await api(`/api/knowledge/${first.id}/records?version=${first.versionId}&q=${encodeURIComponent('手册')}`);
      assert.equal(old.records[0].answer, '已建立质量手册 v1');
      assert.equal((await api(`/api/knowledge/${first.id}/records?q=${encodeURIComponent('手册')}`)).records[0].answer, '已建立质量手册 v2');
    });
    await t.test('失败解析不发布项目，不留下无主原文件', async () => {
      const filesBefore = await readdir(join(temp, 'db', 'files'));
      await upload('invalid.xlsx', 422);
      const invalid = await fetch(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'broken.xlsx' }, body: 'not xlsx' });
      assert.equal(invalid.status, 422);
      const wrongName = await fetch(base + '/api/knowledge/imports', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': '../escape.xlsx' }, body: 'no' });
      assert.equal(wrongName.status, 400);
      assert.deepEqual(await readdir(join(temp, 'db', 'files')), filesBefore);
      assert.equal((await api('/api/knowledge')).projects.length, 1);
      assert.equal((await api(`/api/knowledge/${first.id}/versions`)).versions.length, 2);
    });
    await t.test('重启后数据、旧版本与可撤销删除均保留', async () => {
      await stop(); await start();
      assert.equal((await api('/api/knowledge')).projects[0].version, 2);
      await api(`/api/knowledge/${first.id}`, 'DELETE', { expectedVersionId: first.versionId }, 409);
      await api(`/api/knowledge/${first.id}`, 'DELETE', { expectedVersionId: second.versionId });
      assert.equal((await api('/api/knowledge')).projects.length, 0);
      await stop(); await start();
      assert.equal((await api('/api/knowledge')).trash[0].id, first.id);
      await api(`/api/knowledge/${first.id}/records`, 'GET', undefined, 404);
      await api(`/api/knowledge/${first.id}/restore`, 'POST', {});
      assert.equal((await api('/api/knowledge')).projects[0].summary.questionCount, 48);
      assert.equal((await api(`/api/knowledge/${first.id}/versions`)).versions.length, 2);
    });
    await t.test('事务中断不会发布半个版本', async () => {
      const draft3 = await upload('v1.xlsx');
      app.store.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON knowledge_records BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
      await api(`/api/knowledge/imports/${draft3.importId}/commit`, 'POST', { mode: 'new', name: '不能残留' }, 500);
      app.store.db.exec('DROP TRIGGER fail_insert');
      assert.equal((await api('/api/knowledge')).projects.length, 1);
      const recovered = await api(`/api/knowledge/imports/${draft3.importId}/commit`, 'POST', { mode: 'new', name: '恢复提交' }, 201);
      assert.equal(recovered.project.version, 1);
    });
  } finally { await stop(); await rm(temp, { recursive: true, force: true }); }
});
