import test from 'node:test';
import { authenticatedFetch as fetch } from './auth-client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { resultPresentation } from '../backend/assessment.mjs';
import { startMockProvider, createTestVault } from './mock-provider.mjs';

test('历史快照、增量索引与新导出列验收', async t => {
 const directory=await mkdtemp(resolve('.test-data/history-incremental-'));
 for(const script of ['create_fixtures.py','create_assessment_fixtures.py'])assert.equal(spawnSync('python',['-X','utf8',`tests/${script}`,directory]).status,0);
 const patch=spawnSync('python',['-X','utf8','-c',"import sys,openpyxl; p=sys.argv[1]; w=openpyxl.load_workbook(p); s=w.worksheets[0]; s.cell(12,3,None); s['C12']=None; s['B52']='新增质量目标问题'; s['C52']='新增目标说明'; w.save(p)",join(directory,'v2.xlsx')]);assert.equal(patch.status,0);
 const mock=await startMockProvider();const vault=createTestVault();
 const provider=createProviderClient({fetchImpl:(url,options)=>fetch(mock.base+new URL(url).pathname,options)});
 let app,base;
 async function start(){app=createApp({dataDir:join(directory,'db'),vault,providerClient:provider});await new Promise(done=>app.server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${app.server.address().port}`;}
 async function stop(){await app.assessment.shutdown();await app.indexer.shutdown();await new Promise(done=>app.server.close(done));app.store.close();}
 async function api(path,data,expected=200,method=data===undefined?'GET':'POST'){const response=await fetch(base+path,{method,...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})});const value=await response.json();assert.equal(response.status,expected,value.error);return value;}
 async function upload(path,name){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name)},body:await readFile(join(directory,name))});const value=await response.json();assert.equal(response.status,201,value.error);return value;}
 async function finish(path){for(let attempt=0;attempt<300;attempt++){const value=await api(path);const item=value.job||value.task;if(item.status!=='running')return item;await new Promise(done=>setTimeout(done,15));}throw new Error('任务超时');}
 await start();
 try{
  const {importId}=await upload('/api/knowledge/imports','v1.xlsx');
  let project=(await api(`/api/knowledge/imports/${importId}/commit`,{mode:'new'},201)).project;
  const saved=[];
  for(const type of ['generation','embedding','rerank']){const {model}=await api('/api/models',{name:type,modelId:type,type,provider:'bailian',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'mock-secret-fixture',dimensions:8,isDefault:true},201);saved.push((await api(`/api/models/${model.id}/test`,{expectedRevision:model.revision})).model);}
  const [generation,embedding,rerank]=saved;
  const options=mode=>({name:'索引验证',expectedVersionId:project.versionId,modelId:embedding.id,sheets:Object.keys(project.sheets),updateMode:mode,retrieval:'hybrid',topK:8,threshold:0.5,rerankModelId:rerank.id});
  await api(`/api/knowledge/${project.id}/training`,options('incremental'),409);
  let initial=(await api(`/api/knowledge/${project.id}/training`,options('rebuild'),202)).job;assert.equal((await finish(`/api/training/${initial.id}`)).status,'success');
  const {input}=await upload('/api/assessment/inputs','input.xlsx');
  const run=(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id},202)).task;
  const snapshot=await finish(`/api/assessment/tasks/${run.id}`);
  await t.test('历史查询、日期状态搜索和分页不混入运行中或示例',async()=>{
   const history=await api('/api/assessment/tasks?limit=1');assert.equal(history.total,1);assert.equal(history.tasks[0].id,run.id);assert.equal(history.counts.success,1);
   assert.equal((await api('/api/assessment/tasks?status=failed')).total,0);
   assert.equal((await api('/api/assessment/tasks?q=does-not-exist')).total,0);
   assert.equal((await api('/api/assessment/tasks?page=2&limit=1')).tasks.length,0);
   assert.equal((await api(`/api/assessment/tasks?date=${history.dates[0]}`)).total,1);
   await api('/api/assessment/tasks?status=running',undefined,400);
   assert.equal(JSON.stringify(history).includes('mock-secret-fixture'),false);
  });
  await t.test('部分调用失败与整体失败分开，旧任务重启后自动归类',async()=>{
   mock.behavior.failAssessmentMatch='今年';
   const partial=await finish(`/api/assessment/tasks/${(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id},202)).task.id}`);
   assert.equal(partial.status,'partial_success');assert.ok(partial.counts.failed>0);assert.equal(partial.counts.missing,1);
   mock.behavior.failAssessmentMatch=null;mock.behavior.failAssessment=true;
   const failed=await finish(`/api/assessment/tasks/${(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id,questionIds:['q1','q2']},202)).task.id}`);
   assert.equal(failed.status,'failed');assert.equal(failed.counts.failed,2);
   mock.behavior.failAssessment=false;
   assert.equal((await api('/api/assessment/tasks?status=partial_success')).tasks[0].id,partial.id);
   assert.equal((await api('/api/assessment/tasks?status=failed')).tasks[0].id,failed.id);
   app.store.db.prepare("UPDATE assessment_tasks SET status='failed' WHERE id=?").run(partial.id);
   const requests=mock.requests.length;await stop();await start();
   assert.equal((await api(`/api/assessment/tasks/${partial.id}`)).task.status,'partial_success');assert.equal(mock.requests.length,requests);
   await api(`/api/assessment/tasks/${partial.id}`,{},200,'DELETE');await api(`/api/assessment/tasks/${failed.id}`,{},200,'DELETE');
  });
  await t.test('任务删除、撤销、刷新重启持久化及原文件与关联任务保留',async()=>{
   mock.behavior.assessmentDelay=150;
   const running=(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id,questionIds:['q1']},202)).task;
   await api(`/api/assessment/tasks/${running.id}`,{},409,'DELETE');await finish(`/api/assessment/tasks/${running.id}`);mock.behavior.assessmentDelay=0;
   await api(`/api/assessment/tasks/${running.id}`,{},200,'DELETE');
   await api(`/api/assessment/tasks/${run.id}`,{},200,'DELETE');
   assert.equal((await api('/api/assessment/tasks')).total,0);assert.equal((await api('/api/assessment/current')).task,null);
   assert.equal((await api('/api/assessment/current')).input.id,input.id);
   await api(`/api/assessment/tasks/${run.id}`,undefined,404);
   await api(`/api/assessment/tasks/${run.id}/retry`,{},404);
   assert.equal((await fetch(base+`/api/assessment/tasks/${run.id}/export`)).status,404);
   await api(`/api/assessment/tasks/${run.id}`,{},404,'DELETE');
   assert.equal((await api(`/api/assessment/inputs/${input.id}`)).input.records.length,3);
   assert.equal((await api('/api/knowledge')).projects.length,1);
   await stop();await start();assert.equal((await api('/api/assessment/tasks')).total,0);
   const restored=(await api(`/api/assessment/tasks/${run.id}/restore`,{})).task;
   assert.deepEqual(restored.results,snapshot.results);assert.equal((await api('/api/assessment/tasks')).total,1);
   await api(`/api/assessment/tasks/${run.id}/restore`,{},404);
   await api(`/api/assessment/tasks/${running.id}/restore`,{});
   app.store.db.prepare('UPDATE assessment_runs SET retry_of=? WHERE task_id=?').run(run.id,running.id);
   await api(`/api/assessment/tasks/${run.id}`,{},200,'DELETE');
   assert.equal((await api(`/api/assessment/tasks/${running.id}`)).task.retryOf,run.id);
   assert.equal((await fetch(base+`/api/assessment/tasks/${running.id}/export`)).status,200);
   await api(`/api/assessment/tasks/${running.id}`,{},200,'DELETE');await api(`/api/assessment/tasks/${run.id}/restore`,{});
  });
  await t.test('新增修改删除仅计算变化，结果与重建逐条一致',async()=>{
   const imported=await upload('/api/knowledge/imports','v2.xlsx');
   project=(await api(`/api/knowledge/imports/${imported.importId}/commit`,{mode:'replace',projectId:project.id,expectedVersionId:project.versionId},201)).project;
   const before=mock.requests.length;
   const job=(await api(`/api/knowledge/${project.id}/training`,options('incremental'),202)).job;
   const completed=await finish(`/api/training/${job.id}`);assert.equal(completed.status,'success',completed.error);
   assert.equal(completed.config.changes.computed,2);assert.equal(completed.config.changes.removed,1);assert.equal(completed.config.changes.modified,1);assert.equal(completed.config.changes.added,1);
   const inputs=mock.requests.slice(before).filter(request=>request.path.endsWith('/embeddings')).flatMap(request=>request.body.input);
   assert.equal(inputs.length,3); // Two dirty records and one publication query.
   const indexRows=id=>app.store.db.prepare('SELECT r.sheet,r.line,r.question,r.answer,hex(v.vector) vector FROM index_vectors v JOIN knowledge_records r ON r.id=v.record_id WHERE v.index_id=? ORDER BY r.sheet,r.line').all(id);
   const incremental=indexRows(job.indexId);assert.equal(incremental.length,project.summary.answeredCount);assert.ok(!incremental.some(row=>row.line===12));
   const rebuild=(await api(`/api/knowledge/${project.id}/training`,options('rebuild'),202)).job;assert.equal((await finish(`/api/training/${rebuild.id}`)).status,'success');
   assert.deepEqual(incremental,indexRows(rebuild.indexId));
   const unchanged=(await api(`/api/knowledge/${project.id}/training`,options('incremental'),202)).job;assert.equal((await finish(`/api/training/${unchanged.id}`)).status,'success');
   assert.equal(unchanged.config.changes.computed,0);assert.equal(unchanged.config.changes.reused,project.summary.answeredCount);
  });
  await t.test('历史导出和快照不随知识库替换、删除或重启变化',async()=>{
   assert.deepEqual((await api(`/api/assessment/tasks/${run.id}`)).task.results,snapshot.results);
   await api(`/api/knowledge/${project.id}`,{expectedVersionId:project.versionId},200,'DELETE');
   const exported=await fetch(base+`/api/assessment/tasks/${run.id}/export`);assert.equal(exported.status,200,await exported.clone().text());
   assert.deepEqual((await api(`/api/assessment/tasks/${run.id}`)).task.results,snapshot.results);
   await stop();await start();assert.equal((await api('/api/assessment/tasks')).total,1);assert.deepEqual((await api(`/api/assessment/tasks/${run.id}`)).task.results,snapshot.results);
   await api(`/api/assessment/tasks/${run.id}/retry`,{},409);
   await api(`/api/knowledge/${project.id}/restore`,{});
  });
  await t.test('四种依据及详细说明精确映射，失败不当无信息',()=>{
   const cases=[['direct','可直接复用','/'],['partial','部分有依据','今年实际达成值'],['missing','无相关信息','没有搜索到相关信息'],['failed','调用失败','调用失败']];
   for(const [status,basis,details]of cases){const result=resultPresentation({status,answer:'保留正文',gap:'今年实际达成值'});assert.equal(result.basis,basis);assert.equal(result.details,details);assert.equal(result.answer,'保留正文');}
  });
  await t.test('增量失败与取消保留旧索引，模型变化禁止增量',async()=>{
   const ready=(await api(`/api/knowledge/${project.id}/training`)).index.id;
   const original=app.store.db.prepare('SELECT * FROM knowledge_records WHERE version_id=? AND status=? LIMIT 1').get(project.versionId,'answered');
   app.store.db.prepare('UPDATE knowledge_records SET answer=? WHERE id=?').run('模拟新说明',original.id);
   mock.behavior.failEmbeddings=true;const bad=(await api(`/api/knowledge/${project.id}/training`,options('incremental'),202)).job;
   assert.equal((await finish(`/api/training/${bad.id}`)).status,'failed');assert.equal((await api(`/api/knowledge/${project.id}/training`)).index.id,ready);mock.behavior.failEmbeddings=false;
   mock.behavior.slowMs=100;const slow=(await api(`/api/knowledge/${project.id}/training`,options('incremental'),202)).job;await api(`/api/training/${slow.id}/cancel`,{});assert.equal((await finish(`/api/training/${slow.id}`)).status,'cancelled');mock.behavior.slowMs=0;
   await api(`/api/models/${embedding.id}`,{...embedding,modelId:'different',expectedRevision:embedding.revision},200,'PUT');
   await api(`/api/models/${embedding.id}/test`,{expectedRevision:embedding.revision+1});
   await api(`/api/knowledge/${project.id}/training`,options('incremental'),409);
  });
 }finally{await stop();await mock.close();}
});
