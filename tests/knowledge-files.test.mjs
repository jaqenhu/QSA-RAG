import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { startMockProvider, createTestVault } from './mock-provider.mjs';

test('多文件目录、独立来源、学习覆盖、版本发布及删除恢复', async t => {
  await mkdir(resolve('.test-data'),{recursive:true});
  const directory=await mkdtemp(resolve('.test-data/knowledge-files-'));
  for(const script of ['create_fixtures.py','create_assessment_fixtures.py'])assert.equal(spawnSync('python',['-X','utf8',`tests/${script}`,directory]).status,0);
  const mock=await startMockProvider(),vault=createTestVault();
  const client=createProviderClient({fetchImpl:(url,options)=>fetch(mock.base+new URL(url).pathname,options)});
  let app,base,project,embedding,generation,oldIndex,legacy;
  async function start(){app=createApp({dataDir:join(directory,'db'),vault,providerClient:client});await new Promise(done=>app.server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${app.server.address().port}`;}
  async function stop(){await app.assessment.shutdown();await app.indexer.shutdown();await new Promise(done=>app.server.close(done));app.store.close();}
  async function api(path,body,expected=200,method=body===undefined?'GET':'POST'){const response=await fetch(base+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await response.json();assert.equal(response.status,expected,data.error);return data;}
  async function stage(name='v1.xlsx',as=name){const response=await fetch(base+'/api/knowledge/imports',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(as)},body:await readFile(join(directory,name))});assert.equal(response.status,201);return response.json();}
  async function upload(name,mode='append',documentId){const draft=await stage(name);project=(await api(`/api/knowledge/imports/${draft.importId}/commit`,{mode,projectId:project.id,expectedVersionId:project.versionId,documentId},201)).project;return project;}
  async function finish(path){for(let n=0;n<300;n++){const data=await api(path),job=data.job||data.task;if(job.status!=='running')return job;await new Promise(done=>setTimeout(done,10));}throw new Error('任务未结束');}
  async function train(mode='incremental',sheets=Object.keys(project.sheets)){const data=await api(`/api/knowledge/${project.id}/training`,{name:project.name,expectedVersionId:project.versionId,modelId:embedding.id,sheets,updateMode:mode},202);return finish(`/api/training/${data.job.id}`);}
  await start();
  try {
    await t.test('创建空库、独立重命名、错误名称与版本冲突',async()=>{
      project=(await api('/api/knowledge',{name:'多文件审核资料'},201)).project;
      assert.equal(project.fileCount,0);assert.equal(project.summary.questionCount,0);
      await api('/api/knowledge',{name:' '},400);
      await api(`/api/knowledge/${project.id}`,{name:'改名',expectedVersionId:'stale'},409,'PATCH');
      project=(await api(`/api/knowledge/${project.id}`,{name:'审核知识库',expectedVersionId:project.versionId},200,'PATCH')).project;
      assert.equal(project.name,'审核知识库');
    });
    for(const type of ['embedding','generation']){
      const {model}=await api('/api/models',{name:type,type,provider:'bailian',modelId:type,baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'mock-secret-fixture',dimensions:8,isDefault:true},201);
      const tested=(await api(`/api/models/${model.id}/test`,{expectedRevision:model.revision})).model;
      if(type==='embedding')embedding=tested;else generation=tested;
    }
    await t.test('上传仅保存，首次重建，覆盖数排除无说明与跳过记录',async()=>{
      const before=mock.requests.length;await upload('v1.xlsx');assert.equal(mock.requests.length,before);
      assert.equal(project.files[0].status,'unlearned');assert.equal(project.files[0].learnedCount,0);
      assert.equal((await train('rebuild')).status,'success');
      project=(await api(`/api/knowledge/${project.id}`)).project;
      assert.equal(project.files[0].status,'learned');assert.equal(project.files[0].learnedCount,45);
      oldIndex=(await api(`/api/knowledge/${project.id}/training`)).index;
    });
    await t.test('同名表跨文件独立预览，增量前继续检索旧版，自评冻结已学习版本',async()=>{
      await upload('v2.xlsx');assert.equal(project.fileCount,2);assert.equal(project.summary.questionCount,96);
      assert.equal(project.files[0].status,'learned');assert.equal(project.files[1].status,'unlearned');
      for(const file of project.files){const rows=await api(`/api/knowledge/${project.id}/records?file=${file.id}&limit=100`);assert.equal(rows.total,48);assert.ok(rows.records.every(r=>r.fileName===file.name&&r.documentId===file.id&&!r.sheet.includes(file.id)));}
      const state=await api(`/api/knowledge/${project.id}/training`);assert.equal(state.ready,true);assert.equal(state.pendingUpdate,true);
      const found=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',threshold:0});assert.ok(found.results.every(r=>r.fileName==='v1.xlsx'));
      const response=await fetch(base+'/api/assessment/inputs',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':'input.xlsx'},body:await readFile(join(directory,'input.xlsx'))});const {input}=await response.json();
      const {task}=await api('/api/assessment/tasks',{inputId:input.id,projectId:project.id,expectedVersionId:project.versionId,modelId:generation.id,questionIds:[input.records[0].id]},202);
      const completed=await finish(`/api/assessment/tasks/${task.id}`);assert.equal(completed.versionId,oldIndex.versionId);assert.equal(completed.snapshot.knowledge.versionId,oldIndex.versionId);assert.equal(completed.snapshot.knowledge.version,oldIndex.version);assert.ok(completed.results.flatMap(r=>r.sources).every(s=>s.fileName==='v1.xlsx'));
      const trained=await train();assert.equal(trained.status,'success');assert.equal(trained.config.changes.computed,1);assert.equal(trained.config.changes.reused,89);
      const updated=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',threshold:0,topK:50});assert.deepEqual(new Set(updated.results.map(r=>r.fileName)),new Set(['v1.xlsx','v2.xlsx']));
      oldIndex=(await api(`/api/knowledge/${project.id}/training`)).index;
    });
    await t.test('重复内容、同名和过期提交拒绝，文件修改事务失败不发布',async()=>{
      const same=await stage('v1.xlsx','改名.xlsx');await api(`/api/knowledge/imports/${same.importId}/commit`,{mode:'append',projectId:project.id,expectedVersionId:project.versionId},409);
      const other=await stage('v1.xlsx','v2.xlsx');await api(`/api/knowledge/imports/${other.importId}/commit`,{mode:'replace-file',documentId:project.files[0].id,projectId:project.id,expectedVersionId:'old'},409);
      const before=project.versionId;
      app.store.db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON knowledge_records BEGIN SELECT RAISE(ABORT,'fixture'); END;");
      await api(`/api/knowledge/${project.id}/files/${project.files[1].id}`,{expectedVersionId:project.versionId},500,'DELETE');app.store.db.exec('DROP TRIGGER reject_snapshot');
      assert.equal((await api(`/api/knowledge/${project.id}`)).project.versionId,before);
    });
    await t.test('删除后仍可检索旧文件，增量发布移除，重启恢复保留来源与覆盖',async()=>{
      const removed=project.files[1];
      project=(await api(`/api/knowledge/${project.id}/files/${removed.id}`,{expectedVersionId:project.versionId},200,'DELETE')).project;
      assert.equal(project.fileCount,1);assert.equal(project.trashFiles.length,1);
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).index.id,oldIndex.id);
      assert.equal((await train()).status,'success');
      const found=await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册',threshold:0,topK:50});assert.ok(found.results.every(r=>r.fileName==='v1.xlsx'));
      await stop();await start();project=(await api(`/api/knowledge/${project.id}/files/${removed.id}/restore`,{expectedVersionId:project.versionId})).project;
      assert.equal(project.fileCount,2);assert.equal(project.trashFiles.length,0);
      assert.equal((await api(`/api/knowledge/${project.id}/records?file=${removed.id}`)).total,48);
      assert.equal((await train()).status,'success');
    });
    await t.test('训练中拒绝文件更改，取消与失败保留可用索引，重试可发布',async()=>{
      mock.behavior.slowMs=40;
      const state=await api(`/api/knowledge/${project.id}/training`);
      const {job}=await api(`/api/knowledge/${project.id}/training`,{name:'取消验证',expectedVersionId:project.versionId,modelId:embedding.id,sheets:Object.keys(project.sheets),updateMode:'rebuild'},202);
      await api(`/api/knowledge/${project.id}/files/${project.files[0].id}`,{expectedVersionId:project.versionId},409,'DELETE');
      await api(`/api/training/${job.id}/cancel`,{});assert.equal((await finish(`/api/training/${job.id}`)).status,'cancelled');
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).index.id,state.index.id);
      mock.behavior.slowMs=0;mock.behavior.failEmbeddings=true;assert.equal((await train('rebuild')).status,'failed');
      assert.equal((await api(`/api/knowledge/${project.id}`)).project.files[0].status,'failed');
      assert.equal((await api(`/api/knowledge/${project.id}/training`)).index.id,state.index.id);
      mock.behavior.failEmbeddings=false;assert.equal((await train()).status,'success');
    });
    await t.test('替换单个文件保留其他文件，部分工作表训练明确显示覆盖',async()=>{
      const other=project.files[1];
      // A replacement with identical content is rejected. Modify one row to form a new file.
      const replacement=join(directory,'revision.xlsx');
      assert.equal(spawnSync('python',['-c','from openpyxl import load_workbook; import sys; w=load_workbook(sys.argv[1]); w.worksheets[0]["C4"]="修订后的质量手册"; w.save(sys.argv[2])',join(directory,'v1.xlsx'),replacement]).status,0);
      await upload('revision.xlsx','replace-file',project.files[0].id);
      assert.equal(project.files[1].fileId,other.fileId);assert.equal(project.files[0].status,'outdated');
      const scope=Object.keys(project.sheets).filter(key=>project.sheetDetails.find(s=>s.name===key)?.documentId===project.files[0].id)[0];
      assert.equal((await train('incremental',[scope])).status,'success');
      project=(await api(`/api/knowledge/${project.id}`)).project;assert.equal(project.files[0].learnedCount,44);assert.equal(project.files[1].learnedCount,0);assert.notEqual(project.files[1].status,'learned');
    });
    await t.test('删除最后文件可发布空索引，旧来源仍可核验',async()=>{
      const snapshot=project.versionId;
      for(const f of [...project.files])project=(await api(`/api/knowledge/${project.id}/files/${f.id}`,{expectedVersionId:project.versionId},200,'DELETE')).project;
      assert.equal((await train()).status,'success');
      assert.equal((await api(`/api/knowledge/${project.id}/retrieve`,{query:'质量手册'})).results.length,0);
      assert.equal((await api(`/api/knowledge/${project.id}/records?version=${snapshot}`)).total,96);
    });
    await t.test('旧单文件库迁移不改记录ID、向量或版本，重复启动不重复迁移',async()=>{
      const draft=await stage();legacy=(await api(`/api/knowledge/imports/${draft.importId}/commit`,{mode:'new',name:'旧库'},201)).project;
      const ids=app.store.db.prepare('SELECT id FROM knowledge_records WHERE version_id=? ORDER BY id').all(legacy.versionId);
      app.store.db.exec('DROP TABLE knowledge_version_files; DELETE FROM schema_migrations WHERE version=7; UPDATE knowledge_records SET document_id=NULL,source_sheet=NULL,file_name=NULL;');
      // Only the legacy project is used in this migration fixture.
      await stop();await start();
      const migrated=(await api(`/api/knowledge/${legacy.id}`)).project;
      assert.equal(migrated.files.length,1);assert.equal(migrated.versionId,legacy.versionId);assert.equal(migrated.files[0].name,'v1.xlsx');
      assert.deepEqual(app.store.db.prepare('SELECT id FROM knowledge_records WHERE version_id=? ORDER BY id').all(legacy.versionId),ids);
      await stop();await start();assert.equal((await api(`/api/knowledge/${legacy.id}`)).project.files.length,1);
    });
  }finally{await stop();await mock.close();}
});
