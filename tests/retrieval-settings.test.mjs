import test from 'node:test';
import { authenticatedFetch as fetch } from './auth-client.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { fuseCandidates } from '../backend/retrieval.mjs';
import { retrievalConfig, RETRIEVAL_DEFAULTS } from '../backend/retrieval-config.mjs';
import { startMockProvider, createTestVault } from './mock-provider.mjs';

test('两路独立召回、RRF真实名次、去重和单路零匹配', () => {
 const rows=[['a',.9,.1],['b',.8,.9],['c',.1,.8],['d',0,0]].map(([id,vectorScore,keywordScore],i)=>({id,sheet:'QSA',line:i+1,score:.65*vectorScore+.35*keywordScore,vectorScore,keywordScore}));
 const config=retrievalConfig({vectorTopK:2,bm25TopK:2});
 const fused=fuseCandidates(rows,config);
 assert.deepEqual(fused.map(row=>row.id),['b','a','c']);assert.equal(fused.length,3);
 assert.equal(fused[0].vectorRank,2);assert.equal(fused[0].bm25Rank,1);
 assert.ok(Math.abs(fused[0].score-(1/62+1/61))<1e-12);assert.equal(fused[1].score,1/61);
 const onlyVector=fuseCandidates(rows,{...config,retrieval:'vector'});assert.deepEqual(onlyVector.map(x=>x.id),['a','b']);
 const onlyKeyword=fuseCandidates(rows,{...config,retrieval:'keyword'});assert.deepEqual(onlyKeyword.map(x=>x.id),['b','c']);
 const weighted=fuseCandidates(rows,{...config,fusion:'weighted'});assert.equal(weighted[0].id,'b');assert.equal(weighted[0].score,rows[1].score);
});
test('推荐默认值及参数边界不混淆不同阶段',()=>{
 assert.deepEqual(retrievalConfig(),RETRIEVAL_DEFAULTS);
 for(const bad of [{vectorTopK:0},{bm25TopK:1.5},{rrfK:0},{fusion:'invalid'},{rerankCandidateLimit:4,rerankTopN:8},{rerankThreshold:1.1},{threshold:NaN}])assert.throws(()=>retrievalConfig(bad));
});

test('检索设置独立保存、自评快照和旧任务兼容',async t=>{
 const directory=await mkdtemp(resolve('.test-data/retrieval-settings-'));
 for(const script of ['create_fixtures.py','create_assessment_fixtures.py'])assert.equal(spawnSync('python',['-X','utf8',`tests/${script}`,directory]).status,0);
 const mock=await startMockProvider(),vault=createTestVault();
 const client=createProviderClient({fetchImpl:(url,options)=>fetch(mock.base+new URL(url).pathname,options)});
 let app,base,project,saved,input,settings;
 async function start(){app=createApp({dataDir:join(directory,'db'),vault,providerClient:client});await new Promise(done=>app.server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${app.server.address().port}`;}
 async function stop(){await app.assessment.shutdown();await app.indexer.shutdown();await new Promise(done=>app.server.close(done));app.store.close();}
 async function api(path,data,expected=200,method=data===undefined?'GET':'POST'){const response=await fetch(base+path,{method,...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})});const body=await response.text();assert.equal(body.includes('mock-secret-fixture'),false);const value=JSON.parse(body);assert.equal(response.status,expected,value.error);return value;}
 async function upload(path,name){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':name},body:await readFile(join(directory,name))});assert.equal(response.status,201);return response.json();}
 async function finish(path){for(let attempt=0;attempt<300;attempt++){const data=await api(path);const value=data.task||data.job;if(value.status!=='running')return value;await new Promise(done=>setTimeout(done,10));}throw new Error('timeout');}
 async function save(config,revision){return api(`/api/knowledge/${project.id}/retrieval-settings`,{...config,expectedVersionId:project.versionId,expectedRevision:revision},200,'PUT');}
 await start();
 try{
  const draft=await upload('/api/knowledge/imports','v1.xlsx');project=(await api(`/api/knowledge/imports/${draft.importId}/commit`,{mode:'new'},201)).project;
  await t.test('无索引时可保存、冲突与越界明确拒绝，保存不调用模型',async()=>{
   settings=await api(`/api/knowledge/${project.id}/retrieval-settings`);assert.deepEqual(settings.config,RETRIEVAL_DEFAULTS);assert.equal(settings.revision,0);
   const before=mock.requests.length;settings=await save({...settings.config,topK:6},0);assert.equal(settings.revision,1);assert.equal(mock.requests.length,before);
   await api(`/api/knowledge/${project.id}/retrieval-settings`,{...settings.config,expectedVersionId:project.versionId,expectedRevision:0},409,'PUT');
   await api(`/api/knowledge/${project.id}/retrieval-settings`,{...settings.config,expectedVersionId:project.versionId,vectorTopK:0},400,'PUT');
   assert.equal((await api(`/api/knowledge/${project.id}/training`)).index,null);
  });
  saved=[];for(const type of ['generation','embedding','rerank']){const {model}=await api('/api/models',{name:type,modelId:type,type,provider:'bailian',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'mock-secret-fixture',dimensions:8,isDefault:true},201);saved.push((await api(`/api/models/${model.id}/test`,{expectedRevision:model.revision})).model);}
  const [generation,embedding,rerank]=saved;
  const job=(await api(`/api/knowledge/${project.id}/training`,{...RETRIEVAL_DEFAULTS,rerankModelId:rerank.id,name:'参数验证',expectedVersionId:project.versionId,modelId:embedding.id,sheets:Object.keys(project.sheets),updateMode:'rebuild'},202)).job;
  assert.equal((await finish(`/api/training/${job.id}`)).status,'success');input=(await upload('/api/assessment/inputs','input.xlsx')).input;
  await t.test('调参不改向量，候选上限与TopN各自生效，RRF不用0–1阈值过滤',async()=>{
   const state=await api(`/api/knowledge/${project.id}/training`),count=mock.requests.length;
   const vectors=app.store.db.prepare('SELECT record_id,hex(vector) vector FROM index_vectors WHERE index_id=? ORDER BY record_id').all(state.index.id);
   settings=await save({...RETRIEVAL_DEFAULTS,vectorTopK:5,bm25TopK:5,rerankCandidateLimit:6,rerankTopN:4,rerankModelId:rerank.id},state.retrievalSettings.revision);
   assert.equal(mock.requests.length,count);assert.equal((await api(`/api/knowledge/${project.id}/training`)).index.id,state.index.id);
   assert.deepEqual(app.store.db.prepare('SELECT record_id,hex(vector) vector FROM index_vectors WHERE index_id=? ORDER BY record_id').all(state.index.id),vectors);
   const found=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',retrievalVersion:2});assert.ok(found.results.length>0&&found.results.length<=4);assert.ok(found.candidateCount<=6);
   const request=mock.requests.filter(x=>x.path.endsWith('/text-rerank')).at(-1);assert.equal(request.body.parameters.top_n,4);assert.ok(request.body.input.documents.length<=6);
   const none=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',retrievalVersion:2,rerankThreshold:.99});assert.equal(none.results.length,0);
   const raw=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',retrievalVersion:2,rerankModelId:'',threshold:.7});assert.equal(raw.threshold,null);assert.equal(raw.scoreType,'rrf');assert.ok(raw.results.length);assert.ok(raw.results.every(x=>x.score<.04));
   const legacyClient=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',topK:50,threshold:.5});assert.equal(legacyClient.topK,50);
  });
  await t.test('自评使用保存参数，运行中修改和失败重试不混用新配置',async()=>{
   mock.behavior.failAssessmentMatch='今年';mock.behavior.assessmentDelay=100;
   const run=(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id},202)).task;
   assert.deepEqual(run.snapshot.retrieval,settings.config);
   const original=settings.config;settings=await save({...settings.config,rerankTopN:1},settings.revision);
   const completed=await finish(`/api/assessment/tasks/${run.id}`);assert.equal(completed.status,'partial_success');assert.deepEqual(completed.snapshot.retrieval,original);
   mock.behavior.failAssessmentMatch=null;mock.behavior.assessmentDelay=0;
   const before=mock.requests.length;const retry=await finish(`/api/assessment/tasks/${(await api(`/api/assessment/tasks/${run.id}/retry`,{},202)).task.id}`);
   assert.equal(retry.status,'success');assert.deepEqual(retry.snapshot.retrieval,original);
   assert.ok(mock.requests.slice(before).filter(x=>x.path.endsWith('/text-rerank')).every(x=>x.body.parameters.top_n===4));
   for(const row of completed.results.filter(x=>x.status!=='failed')){const copied=retry.results.find(x=>x.inputRecordId===row.inputRecordId);assert.equal(copied.answer,row.answer);assert.deepEqual(copied.sources,row.sources);}
  });
  await t.test('旧任务重试保持原加权融合、8条结果与0.5阈值',async()=>{
   settings=await save({...settings.config,rerankTopN:4},settings.revision);mock.behavior.failAssessment=true;
   const run=await finish(`/api/assessment/tasks/${(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id,questionIds:['q2']},202)).task.id}`);assert.equal(run.status,'failed');mock.behavior.failAssessment=false;
   const old={...run.snapshot};delete old.retrieval;app.store.db.prepare('UPDATE assessment_runs SET snapshot_json=? WHERE task_id=?').run(JSON.stringify(old),run.id);
   const retry=await finish(`/api/assessment/tasks/${(await api(`/api/assessment/tasks/${run.id}/retry`,{},202)).task.id}`);
   assert.equal(retry.status,'success');assert.equal(retry.snapshot.retrieval.retrievalVersion,1);assert.equal(retry.snapshot.retrieval.fusion,'weighted');assert.equal(retry.snapshot.retrieval.topK,8);assert.equal(retry.snapshot.retrieval.threshold,.5);
   assert.equal(mock.requests.filter(x=>x.path.endsWith('/text-rerank')).at(-1).body.parameters.top_n,8);
  });
  await t.test('重启持久化与项目隔离，原项目向量仍可用',async()=>{
   await stop();await start();assert.deepEqual(await api(`/api/knowledge/${project.id}/retrieval-settings`),settings);
   const second=await upload('/api/knowledge/imports','v1.xlsx');const other=(await api(`/api/knowledge/imports/${second.importId}/commit`,{mode:'new',name:'独立项目'},201)).project;
   assert.deepEqual((await api(`/api/knowledge/${other.id}/retrieval-settings`)).config,RETRIEVAL_DEFAULTS);
   assert.equal((await api(`/api/knowledge/${project.id}/training`)).ready,true);
  });
 }finally{await stop();await mock.close();}
});
