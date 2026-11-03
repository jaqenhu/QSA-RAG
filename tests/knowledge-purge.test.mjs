import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,access,copyFile,rename,rmdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { startMockProvider,createTestVault } from './mock-provider.mjs';

test('新知识库严格校验前三列表头',async()=>{
  await mkdir(resolve('.test-data'),{recursive:true});const directory=await mkdtemp(resolve('.test-data/headers-'));
  const script=`from openpyxl import Workbook
import sys
from pathlib import Path
for name,headers in [('valid',['序号','审核项目','自评说明']),('alias',['序号','检查内容','自评说明']),('missing',['','审核项目','自评说明']),('reordered',['审核项目','序号','自评说明']),('answer-alias',['序号','审核项目','自评内容'])]:
 w=Workbook();s=w.active;s.append(headers);s.append([1,'审核问题','说明']);w.save(Path(sys.argv[1])/(name+'.xlsx'))`;
  assert.equal(spawnSync('python',['-c',script,directory]).status,0);
  const app=createApp({dataDir:join(directory,'db')});await new Promise(done=>app.server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${app.server.address().port}`;
  try{for(const name of ['valid','alias','missing','reordered','answer-alias']){const response=await fetch(base+'/api/knowledge/imports',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':name+'.xlsx'},body:await readFile(join(directory,name+'.xlsx'))});const data=await response.json();assert.equal(response.status,name==='valid'?201:422);if(name!=='valid')assert.match(data.error,/序号.*审核项目.*自评说明/);}}
  finally{await app.assessment.shutdown();await app.indexer.shutdown();await new Promise(done=>app.server.close(done));app.store.close();}
});

test('彻底删除清理原文件和索引、不可恢复，保留历史引用',async t=>{
  await mkdir(resolve('.test-data'),{recursive:true});const directory=await mkdtemp(resolve('.test-data/purge-'));
  for(const script of ['create_fixtures.py','create_assessment_fixtures.py'])assert.equal(spawnSync('python',['-X','utf8',`tests/${script}`,directory]).status,0);
  const mock=await startMockProvider(),vault=createTestVault(),client=createProviderClient({fetchImpl:(url,options)=>fetch(mock.base+new URL(url).pathname,options)});
  let app,base,project,file,run,embedding,generation,oldVersion;
  async function start(){app=createApp({dataDir:join(directory,'db'),vault,providerClient:client});await new Promise(done=>app.server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${app.server.address().port}`;}
  async function stop(){await app.assessment.shutdown();await app.indexer.shutdown();await new Promise(done=>app.server.close(done));app.store.close();}
  async function api(path,body,expected=200,method=body?'POST':'GET'){const response=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();assert.equal(response.status,expected,data.error);return data;}
  async function upload(name,path='/api/knowledge/imports'){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':name},body:await readFile(join(directory,name))});assert.equal(response.status,201);return response.json();}
  async function finish(path){for(let n=0;n<300;n++){const data=await api(path),job=data.job||data.task;if(job.status!=='running')return job;await new Promise(done=>setTimeout(done,10));}throw new Error('任务超时');}
  const purge=(body,status=200)=>api(`/api/knowledge/${project.id}/files/${file.id}/purge`,body,status,'DELETE');
  await start();
  try{
    const draft=await upload('v1.xlsx');project=(await api(`/api/knowledge/imports/${draft.importId}/commit`,{mode:'new',name:'删除验证'},201)).project;file=project.files[0];oldVersion=project.versionId;
    for(const type of ['embedding','generation']){const saved=(await api('/api/models',{name:type,type,provider:'bailian',modelId:type,baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'mock-secret-fixture',dimensions:8,isDefault:true},201)).model;const tested=(await api(`/api/models/${saved.id}/test`,{expectedRevision:saved.revision})).model;if(type==='embedding')embedding=tested;else generation=tested;}
    const job=(await api(`/api/knowledge/${project.id}/training`,{name:'训练',modelId:embedding.id,expectedVersionId:project.versionId,sheets:Object.keys(project.sheets),updateMode:'rebuild'},202)).job;assert.equal((await finish(`/api/training/${job.id}`)).status,'success');
    const {input}=await upload('input.xlsx','/api/assessment/inputs');const task=(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,modelId:generation.id,expectedVersionId:project.versionId,questionIds:[input.records[0].id]},202)).task;run=await finish(`/api/assessment/tasks/${task.id}`);assert.ok(run.results[0].sources.length);
    await t.test('拒绝在用文件、未确认和过期版本的删除请求',async()=>{
      await purge({expectedVersionId:project.versionId,confirmed:true},404);
      project=(await api(`/api/knowledge/${project.id}/files/${file.id}`,{expectedVersionId:project.versionId},200,'DELETE')).project;
      await purge({expectedVersionId:project.versionId},400);await purge({expectedVersionId:'stale',confirmed:true},409);
      assert.equal((await api(`/api/knowledge/${project.id}`)).project.trashFiles.length,1);
    });
    await t.test('事务失败不删除原文件或产生删除标记',async()=>{
      app.store.db.exec("CREATE TRIGGER prevent_purge BEFORE INSERT ON knowledge_purged_documents BEGIN SELECT RAISE(ABORT,'fixture'); END;");await purge({expectedVersionId:project.versionId,confirmed:true},500);app.store.db.exec('DROP TRIGGER prevent_purge');
      await access(join(directory,'db','files',file.fileId+'.xlsx'));assert.equal((await api(`/api/knowledge/${project.id}`)).project.trashFiles.length,1);
    });
    await t.test('自评正在使用知识库时拒绝彻底删除',async()=>{
      mock.behavior.assessmentDelay=120;
      const task=(await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,modelId:generation.id,expectedVersionId:project.versionId,questionIds:[input.records[0].id]},202)).task;
      await purge({expectedVersionId:project.versionId,confirmed:true},409);await finish(`/api/assessment/tasks/${task.id}`);mock.behavior.assessmentDelay=0;
    });
    await t.test('文件和检索记录即时清理，刷新重启不可恢复，历史导出不变',async()=>{
      const original=join(directory,'db','files',file.fileId+'.xlsx'),backup=join(directory,'fixture-backup.xlsx');await copyFile(original,backup);const bytes=await readFile(original);
      const removed=await purge({expectedVersionId:project.versionId,confirmed:true});assert.equal(removed.cleanupPending,0);assert.equal(removed.project.trashFiles.length,0);await assert.rejects(access(original));assert.deepEqual(await readFile(backup),bytes);
      await api(`/api/knowledge/${project.id}/files/${file.id}/restore`,{expectedVersionId:project.versionId},404);
      assert.equal((await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册'})).results.length,0);
      assert.equal((await api(`/api/knowledge/${project.id}/records?version=${oldVersion}&file=${file.id}`)).total,0);
      assert.deepEqual((await api(`/api/assessment/tasks/${run.id}`)).task.results,run.results);
      assert.equal((await fetch(base+`/api/assessment/tasks/${run.id}/export`)).status,200);assert.equal(app.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
      await stop();await start();assert.equal((await api(`/api/knowledge/${project.id}`)).project.trashFiles.length,0);await api(`/api/knowledge/${project.id}/files/${file.id}/restore`,{expectedVersionId:project.versionId},404);
    });
    await t.test('暂不可清理的原文件持久排队，重启后重试',async()=>{
      const draft=await upload('v2.xlsx');project=(await api(`/api/knowledge/imports/${draft.importId}/commit`,{mode:'append',projectId:project.id,expectedVersionId:project.versionId},201)).project;file=project.files[0];project=(await api(`/api/knowledge/${project.id}/files/${file.id}`,{expectedVersionId:project.versionId},200,'DELETE')).project;
      const original=join(directory,'db','files',file.fileId+'.xlsx'),held=original+'.held';await rename(original,held);await mkdir(original);
      const removed=await purge({expectedVersionId:project.versionId,confirmed:true});assert.equal(removed.cleanupPending,1);assert.equal(removed.project.trashFiles.length,0);
      await rmdir(original);await rename(held,original);await stop();await start();await assert.rejects(access(original));assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM knowledge_file_cleanup').get().n,0);
    });
  }finally{await stop();await mock.close();}
});
