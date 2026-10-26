import test from 'node:test';
import { authenticatedFetch as fetch } from './auth-client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { groundedResult } from '../backend/assessment.mjs';
import { startMockProvider, createTestVault } from './mock-provider.mjs';

test('逐题自评：真实协议、证据边界、部分支持、失败重试和保真导出', async t => {
  const directory = await mkdtemp(resolve('.test-data/assessment-'));
  assert.equal(spawnSync('python', ['-X','utf8','tests/create_fixtures.py', directory]).status, 0);
  assert.equal(spawnSync('python', ['-X','utf8','tests/create_assessment_fixtures.py', directory]).status, 0);
  const mock = await startMockProvider(); const vault = createTestVault();
  const client = createProviderClient({ fetchImpl: (url, options) => fetch(mock.base + new URL(url).pathname, options) });
  let app, base;
  async function start() { app = createApp({ dataDir: join(directory,'db'), vault, providerClient: client }); await new Promise(done => app.server.listen(0,'127.0.0.1',done)); base = `http://127.0.0.1:${app.server.address().port}`; }
  async function stop() { await app.assessment.shutdown(); await app.indexer.shutdown(); await new Promise(done => app.server.close(done)); app.store.close(); }
  async function api(path, method='GET', data, expected=200) {
    const response = await fetch(base + path, { method, ...(data === undefined ? {} : { headers: { 'Content-Type':'application/json' }, body: JSON.stringify(data) }) });
    const result = await response.json(); assert.equal(response.status, expected, result.error); return result;
  }
  async function upload(path, name) { const response = await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name)},body:await readFile(join(directory,name))}); const value = await response.json(); assert.equal(response.status,201,value.error); return value; }
  async function finish(id) { for(let attempt=0;attempt<300;attempt++){ const value=(await api(`/api/assessment/tasks/${id}`)).task; if(value.status!=='running')return value; await new Promise(done=>setTimeout(done,20)); } throw new Error('timeout'); }
  await start();
  try {
    const draft = await upload('/api/knowledge/imports','v1.xlsx');
    const project = (await api(`/api/knowledge/imports/${draft.importId}/commit`,'POST',{mode:'new'},201)).project;
    const saved=[];
    for(const type of ['generation','embedding','rerank']) {
      const model=(await api('/api/models','POST',{name:type,modelId:type,provider:'bailian',type,baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'mock-secret-fixture',dimensions:8,isDefault:true},201)).model;
      saved.push((await api(`/api/models/${model.id}/test`,'POST',{expectedRevision:model.revision})).model);
    }
    const [generation,embedding,rerank]=saved;
    const train = (await api(`/api/knowledge/${project.id}/training`,'POST',{name:'测试索引',expectedVersionId:project.versionId,modelId:embedding.id,sheets:Object.keys(project.sheets),updateMode:'rebuild',retrieval:'hybrid',topK:8,threshold:0.5,rerankModelId:rerank.id},202)).job;
    for(let n=0;n<100;n++){ if((await api(`/api/training/${train.id}`)).job.status!=='running')break; await new Promise(done=>setTimeout(done,10)); }
    const {input}=await upload('/api/assessment/inputs','input.xlsx');
    const options={inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id};
    await t.test('无漏题、逐题C行映射、合并明细和前置校验',async()=>{
      assert.equal(input.records.length,3); assert.equal(input.summary.mergeCount,1); assert.equal(input.summary.mergedQuestionCount,2);
      assert.deepEqual(input.records.map(row=>row.line),[3,4,5]); assert.deepEqual(input.records.map(row=>row.answerCell),['C3','C4','C5']);
      assert.equal(input.records[1].originalAnswerCell,'C3'); assert.equal(input.sheets[0].sourceColumn,'G');
      await api('/api/assessment/tasks','POST',{...options,modelId:embedding.id},400);
      await api('/api/assessment/tasks','POST',{...options,questionIds:['invented']},400);
    });
    await t.test('真实处理阶段和逐题进度可查询，完成后不残留运行步骤',async()=>{
      mock.behavior.slowMs=100;mock.behavior.assessmentDelay=150;
      const {task}=await api('/api/assessment/tasks','POST',{...options,questionIds:['q1']},202);
      assert.equal(task.progress.stage,'preparing');assert.equal(task.progress.percent,0);
      const observed=new Set();let latest;
      for(let attempt=0;attempt<100;attempt++){
        latest=(await api(`/api/assessment/tasks/${task.id}`)).task;
        assert.equal(latest.progress.processed,latest.processed);assert.equal(latest.progress.total,1);
        for(const item of latest.progress.items){observed.add(item.stage);assert.equal(item.sheet,'审核检查单');assert.equal(item.line,3);assert.equal(item.questionCell,'B3');}
        if(latest.status!=='running')break;
        await new Promise(done=>setTimeout(done,8));
      }
      assert.ok(observed.has('retrieving'));assert.ok(observed.has('generating'));
      assert.equal(latest.status,'success');assert.equal(latest.progress.stage,'complete');assert.equal(latest.progress.percent,100);assert.deepEqual(latest.progress.items,[]);
      mock.behavior.slowMs=0;mock.behavior.assessmentDelay=0;
    });
    let completed;
    await t.test('逐题判断、原文提取、程序来源、无信息与失败有区别',async()=>{
      const {task}=await api('/api/assessment/tasks','POST',options,202); completed=await finish(task.id);
      assert.equal(completed.status,'success'); assert.equal(completed.total,3); assert.equal(completed.processed,3);
      assert.equal(completed.results[0].status,'direct'); assert.equal(completed.results[1].status,'partial'); assert.equal(completed.results[2].status,'missing');
      assert.match(completed.results[1].gap,/今年/); assert.equal(completed.results[2].sources.length,0);
      for(const row of completed.results.filter(row=>row.sources.length)) for(const source of row.sources) { assert.ok(source.quotes.every(quote=>source.excerpt.includes(quote))); const canonical=app.store.db.prepare('SELECT answer FROM knowledge_records WHERE id=?').get(source.recordId); assert.equal(source.excerpt,canonical.answer); }
      assert.equal(JSON.stringify(completed).includes('mock-secret-fixture'),false);
      assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM result_sources').get().n>0,true);
      assert.ok(mock.requests.some(request=>request.path.endsWith('/chat/completions')&&request.body.response_format?.type==='json_object'));
    });
    await t.test('拒绝伪造引用和非原文；部分支持从已核对片段组合',async()=>{
      const source={id:'a',sheet:'QSA',line:4,answerCell:'C4',questionCell:'B4',question:'体系',answer:'已建立质量手册，由负责人批准。'};
      assert.throws(()=>groundedResult({parts:[{requirement:'认证',status:'supported',citations:[{evidenceId:'fake',quote:'通过认证'}]}]},[source]));
      assert.throws(()=>groundedResult({parts:[{requirement:'认证',status:'supported',citations:[{evidenceId:'a',quote:'已通过认证'}]}]},[source]));
      assert.equal(groundedResult({parts:[{requirement:'缺失要求',status:'missing',citations:null}]},[source]).status,'missing');
      assert.equal(groundedResult({parts:[{requirement:'制度',status:'supported',evidenceId:'a',quote:'已建立质量手册'}]},[source]).status,'direct');
      assert.throws(()=>groundedResult({parts:[{requirement:'认证',status:'supported',evidenceId:'a',quote:'不存在的事实'}]},[source]));
      mock.behavior.invalidCitation=true;
      const run=await finish((await api('/api/assessment/tasks','POST',{...options,questionIds:['q1']},202)).task.id);
      assert.equal(run.counts.failed,1); assert.match(run.results[0].answer,/已拒绝保存/); assert.equal(run.results[0].sources.length,0); assert.equal(run.results[0].errorCode,'MODEL_EVIDENCE_INVALID'); assert.equal(run.results[0].errorStage,'validating'); assert.equal(run.results[0].attempts,2); assert.ok(run.results[0].errorIssues.length);
      mock.behavior.invalidCitation=false;
      const retried=await finish((await api(`/api/assessment/tasks/${run.id}/retry`,'POST',{},202)).task.id);
      assert.equal(retried.status,'success'); assert.equal(retried.retryOf,run.id);
    });
    await t.test('限流、停止、并发保护、失败项重试保留成功结果',async()=>{
      mock.behavior.failAssessment=true;
      const failed=await finish((await api('/api/assessment/tasks','POST',options,202)).task.id);
      assert.equal(failed.status,'failed'); assert.ok(failed.counts.failed>0); assert.equal(JSON.stringify(failed).includes('mock-secret-fixture'),false);
      mock.behavior.failAssessment=false;
      const rebuilt=(await api(`/api/knowledge/${project.id}/training`,'POST',{...train.config,name:'同版本重建',expectedVersionId:project.versionId,modelId:embedding.id,updateMode:'rebuild'},202)).job;
      for(let attempt=0;attempt<100;attempt++){if((await api(`/api/training/${rebuilt.id}`)).job.status!=='running')break;await new Promise(done=>setTimeout(done,10));}
      const retry=await finish((await api(`/api/assessment/tasks/${failed.id}/retry`,'POST',{},202)).task.id);
      assert.equal(retry.status,'success'); assert.equal(retry.results.find(row=>row.status==='missing').answer,'没有相关信息。');
      mock.behavior.assessmentDelay=200;
      const running=(await api('/api/assessment/tasks','POST',options,202)).task;
      await api('/api/assessment/tasks','POST',options,409);
      await api(`/api/models/${generation.id}`,'DELETE',{expectedRevision:generation.revision},409);
      const exporting=await fetch(base+`/api/assessment/tasks/${running.id}/export`);assert.equal(exporting.status,409);
      await api(`/api/assessment/tasks/${running.id}/cancel`,'POST',{});
      assert.equal((await finish(running.id)).status,'failed');mock.behavior.assessmentDelay=0;
    });
    await t.test('导出副本逐题一致、只拆C合并、保留其他表和公式及包部件',async()=>{
      const response=await fetch(base+`/api/assessment/tasks/${completed.id}/export`);
      assert.equal(response.status,200,await response.clone().text());
      const output=join(directory,'export.xlsx');await writeFile(output,Buffer.from(await response.arrayBuffer()));
      await writeFile(join(directory,'expected.json'),JSON.stringify(completed));
      const verification=spawnSync('python',['-X','utf8','tests/verify_assessment_export.py',join(directory,'input.xlsx'),output,join(directory,'expected.json')],{encoding:'utf8'});
      assert.equal(verification.status,0,verification.stdout+verification.stderr);
    });
    await t.test('刷新重启后输入与完成结果、来源快照保持一致',async()=>{
      await stop();await start();
      const restored=(await api(`/api/assessment/tasks/${completed.id}`)).task;
      assert.deepEqual(restored.results,completed.results); assert.equal((await api('/api/assessment/current')).input.id,input.id);
    });
    await t.test('启动恢复中断任务，已完成答案保留且不自动调用模型',async()=>{
      const interrupted=await finish((await api('/api/assessment/tasks','POST',options,202)).task.id);
      const finishedRow=interrupted.results[0];
      app.store.db.prepare("UPDATE assessment_tasks SET status='running',finished_at=NULL WHERE id=?").run(interrupted.id);
      app.store.db.prepare("UPDATE assessment_results SET status='pending',answer='' WHERE id=?").run(interrupted.results[1].id);
      const calls=mock.requests.length;
      await stop();await start();
      const recovered=(await api(`/api/assessment/tasks/${interrupted.id}`)).task;
      assert.equal(recovered.status,'partial_success'); assert.equal(recovered.results[1].status,'failed');
      assert.equal(recovered.processed,recovered.total);
      assert.deepEqual(recovered.results[0],finishedRow);assert.equal(mock.requests.length,calls);
      assert.equal((await finish((await api(`/api/assessment/tasks/${recovered.id}/retry`,'POST',{},202)).task.id)).status,'success');
    });
    await t.test('更换输入后当前任务与新表绑定，重传和改名不复用旧结果，历史保持原名',async()=>{
      assert.equal(spawnSync('python',['-X','utf8','tests/create_replacement_fixtures.py',directory]).status,0);
      const before=(await api('/api/assessment/current')).task;
      const replacement=(await upload('/api/assessment/inputs','replacement.xlsx')).input;
      assert.equal(replacement.name,'replacement.xlsx');
      assert.equal(replacement.records.length,4);
      assert.deepEqual([...new Set(replacement.records.map(row=>row.sheet))],['替换审核表','补充检查']);
      assert.equal((await api('/api/assessment/current')).task,null);
      const completed=await finish((await api('/api/assessment/tasks','POST',{...options,inputId:replacement.id},202)).task.id);
      assert.equal(completed.total,4);
      const renamed=(await upload('/api/assessment/inputs','renamed.xlsx')).input;
      assert.equal(renamed.name,'renamed.xlsx');assert.notEqual(renamed.id,replacement.id);
      assert.equal(renamed.sha256,replacement.sha256);
      assert.equal((await api('/api/assessment/current')).task,null);
      const repeated=(await upload('/api/assessment/inputs','renamed.xlsx')).input;
      assert.notEqual(repeated.id,renamed.id);
      assert.equal((await api('/api/assessment/current')).input.id,repeated.id);
      assert.equal((await api('/api/assessment/current')).task,null);
      assert.equal((await api(`/api/assessment/tasks/${completed.id}`)).task.snapshot.input.name,'replacement.xlsx');
      assert.equal((await api(`/api/assessment/inputs/${replacement.id}`)).input.name,'replacement.xlsx');
      assert.deepEqual((await api(`/api/assessment/tasks/${before.id}`)).task.results,before.results);
      await stop();await start();
      assert.equal((await api('/api/assessment/current')).input.id,repeated.id);
      assert.equal((await api('/api/assessment/current')).task,null);
    });
  } finally { await stop();await mock.close(); }
});
