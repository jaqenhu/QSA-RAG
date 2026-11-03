import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { createProviderClient } from '../backend/providers.mjs';
import { startMockProvider,createTestVault } from './mock-provider.mjs';
const {chromium}=await import(process.env.QSA_PLAYWRIGHT_MODULE?pathToFileURL(process.env.QSA_PLAYWRIGHT_MODULE).href:'playwright');
await mkdir(resolve('.test-data'),{recursive:true});await mkdir(resolve('.impeccable/review/knowledge-files'),{recursive:true});
const captureDirectory=resolve(process.env.QSA_KNOWLEDGE_CAPTURE_DIR||'.impeccable/review/knowledge-refinement');await mkdir(captureDirectory,{recursive:true});
const directory=await mkdtemp(resolve('.test-data/knowledge-files-browser-'));
assert.equal(spawnSync('python',['-X','utf8','tests/create_fixtures.py',directory]).status,0);
const mock=await startMockProvider(),app=createApp({dataDir:join(directory,'db'),vault:createTestVault(),providerClient:createProviderClient({fetchImpl:(url,options)=>fetch(mock.base+new URL(url).pathname,options)})});
await new Promise(done=>app.server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${app.server.address().port}`;
async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,value.error);return value;}
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
async function upload(name){await page.locator('#open-knowledge-upload').click();await page.locator('#knowledge-file-input').setInputFiles(join(directory,name));await page.waitForFunction(()=>!document.getElementById('confirm-knowledge-upload').disabled);await page.locator('#confirm-knowledge-upload').click();await page.locator('#knowledge-upload-dialog').waitFor({state:'hidden'});}
async function noOverflow(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
async function capture(name){await page.evaluate(()=>scrollTo(0,0));if(!process.env.QSA_SKIP_SCREENSHOTS)await page.screenshot({path:join(captureDirectory,`${name}.png`),fullPage:true});await noOverflow();}
try{
  const {model}=await api('/api/models',{name:'测试向量模型',type:'embedding',provider:'bailian',modelId:'embedding',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',apiKey:'mock-secret-fixture',dimensions:8,isDefault:true});await api(`/api/models/${model.id}/test`,{expectedRevision:model.revision});
  await page.goto(base+'/#knowledge-list');await page.locator('#knowledge-project-empty').waitFor();
  assert.equal(await page.locator('.nav-subitem').count(),0);
  await page.locator('#create-knowledge-project').click();await page.locator('#knowledge-name-input').fill('供应商质量知识库');await page.locator('#save-knowledge-name').click();await page.locator('#knowledge-detail-title').filter({hasText:'供应商质量知识库'}).waitFor();
  await upload('v1.xlsx');await page.locator('.library-file').waitFor();assert.match(await page.locator('#library-preview-info').textContent(),/未学习/);
  await page.locator('#open-knowledge-training').click();await page.waitForFunction(()=>!document.getElementById('start-knowledge-training').disabled);
  assert.equal(await page.locator('#training-update').inputValue(),'rebuild');assert.equal(await page.locator('#training-update option[value="incremental"]').isDisabled(),true);
  await page.locator('#start-knowledge-training').click();await page.waitForFunction(()=>document.getElementById('training-overall-status').textContent==='索引可用');
  await page.locator('#retrieval-query').fill('质量手册');await page.locator('#run-retrieval').click();await page.locator('.retrieval-result').first().waitFor();assert.match(await page.locator('.retrieval-result').first().textContent(),/v1.xlsx/);
  await page.locator('.retrieval-settings summary').click();await page.locator('#training-vector-top-k').fill('12');await page.locator('#save-retrieval-settings').click();await page.waitForFunction(()=>document.getElementById('retrieval-save-status').textContent.includes('已保存'));
  await page.locator('.library-training-nav [data-view="knowledge-preview"]').click();await upload('v2.xlsx');assert.equal(await page.locator('.library-file').count(),2);
  await page.locator('#open-knowledge-upload').click();await page.locator('#knowledge-file-input').setInputFiles(join(directory,'v1.xlsx'));await page.waitForFunction(()=>!document.getElementById('confirm-knowledge-upload').disabled);await page.locator('#confirm-knowledge-upload').click();await page.waitForFunction(()=>document.getElementById('knowledge-upload-status').textContent.includes('相同内容'));await page.locator('[data-close-upload]').click();
  await page.locator('#library-file-list .library-file').first().click();await page.locator('#knowledge-records tr').first().waitFor();
  await page.reload();await page.waitForFunction(()=>document.getElementById('knowledge-detail-title').textContent==='供应商质量知识库');await page.locator('#knowledge-records tr').first().waitFor();
  await page.locator('#knowledge-next-page').click();await page.waitForFunction(()=>document.getElementById('knowledge-preview-count').textContent.includes('第 31–47'));
  await page.locator('#knowledge-missing-only').check();await page.waitForFunction(()=>document.querySelectorAll('#knowledge-records tr').length===3);await page.locator('#knowledge-missing-only').uncheck();
  assert.equal(await page.locator('#knowledge-project-summary').count(),0);await page.locator('[data-library-menu] summary').click();await page.locator('#show-knowledge-diagnostics').click();await page.locator('#knowledge-saved-diagnostics[open]').waitFor();assert.match(await page.locator('#knowledge-saved-details').textContent(),/C 列公式无缓存值/);await page.locator('#knowledge-saved-diagnostics').evaluate(el=>{el.hidden=true;el.open=false;});
  await page.locator('[data-knowledge-sheet]').last().click();await page.waitForFunction(()=>document.querySelectorAll('#knowledge-records tr').length===1);assert.match(await page.locator('#knowledge-records').textContent(),/隐藏表问题/);await page.locator('[data-knowledge-sheet]').first().click();
  await page.locator('#knowledge-search').fill('<img');await page.waitForFunction(()=>document.querySelectorAll('#knowledge-records tr').length===1);assert.equal(await page.locator('#knowledge-records img').count(),0);await page.locator('#knowledge-search').fill('');
  await page.locator('#knowledge-records tr').nth(1).waitFor();await capture('desktop-detail');await page.locator('[data-library-menu] summary').click();await capture('desktop-more');await page.keyboard.press('Escape');
  await page.locator('.library-back').click();await capture('desktop-list');
  await page.locator('[data-library]').click();await page.locator('#open-knowledge-training').click();await page.waitForFunction(()=>!document.getElementById('start-knowledge-training').disabled);
  assert.equal(await page.locator('#training-vector-top-k').inputValue(),'12');
  await page.locator('#training-update').selectOption('incremental');await page.locator('#start-knowledge-training').click();await page.waitForFunction(()=>document.getElementById('training-overall-status').textContent==='索引可用');
  await page.locator('#retrieval-query').fill('质量手册');await page.locator('#run-retrieval').click();await page.locator('.retrieval-result').first().waitFor();await capture('desktop-training');
  await page.setViewportSize({width:390,height:844});await capture('mobile-training');
  await page.locator('.library-training-nav [data-view="knowledge-preview"]').click();await page.locator('#knowledge-records tr').first().waitFor();await capture('mobile-detail');
  await page.locator('#library-file-list .library-file').last().click();await page.locator('#delete-knowledge-file').click();await page.locator('#confirm-knowledge-file-delete').click();await page.locator('#knowledge-file-delete-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('.library-file').count(),1);
  await page.locator('#library-deleted-files summary').click();await page.locator('[data-restore-file]').click();await page.waitForFunction(()=>document.querySelectorAll('.library-file').length===2);
  await page.locator('#open-knowledge-upload').click();assert.match(await page.locator('.knowledge-upload-guide').textContent(),/序号.*审核项目.*自评说明/s);await capture('mobile-upload');await page.locator('[data-close-upload]').click();
  await page.locator('.library-file').last().click();await page.locator('#delete-knowledge-file').click();await page.locator('#confirm-knowledge-file-delete').click();await page.locator('#knowledge-file-delete-dialog').waitFor({state:'hidden'});if(!await page.locator('#library-deleted-files').evaluate(el=>el.open))await page.locator('#library-deleted-files summary').click();
  await page.setViewportSize({width:1440,height:1000});await capture('desktop-trash');await page.locator('[data-purge-file]').click();await page.locator('#knowledge-file-purge-dialog').waitFor();await capture('desktop-purge-confirm');await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});
  await page.locator('[data-purge-file]').click();await page.locator('#knowledge-file-purge-dialog').waitFor();assert.equal(await page.locator('#knowledge-file-purge-dialog button[autofocus]').evaluate(el=>el===document.activeElement),true);await capture('mobile-purge-confirm');await page.keyboard.press('Escape');assert.equal(await page.locator('[data-purge-file]').count(),1);
  await page.locator('[data-purge-file]').click();await page.locator('#confirm-knowledge-file-purge').click();await page.locator('#knowledge-file-purge-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('[data-restore-file]').count(),0);assert.equal(await page.locator('[data-purge-file]').count(),0);await page.reload();await page.locator('#knowledge-detail-title').waitFor();assert.equal(await page.locator('[data-restore-file]').count(),0);
  await page.locator('.library-back').click();await capture('mobile-list');
  await page.locator('[data-library-rename]').click();await page.locator('#knowledge-name-input').fill('供应商审核资料');await page.locator('#save-knowledge-name').click();await page.locator('.library-name').filter({hasText:'供应商审核资料'}).waitFor();
  await page.locator('[data-library-delete]').click();await page.locator('#confirm-knowledge-delete').click();await page.locator('#knowledge-project-empty').waitFor();await page.locator('#undo-knowledge-delete').click();await page.locator('.library-name').waitFor();
  await page.locator('#create-knowledge-project').click();await page.locator('#knowledge-name-input').fill('独立知识库');await page.locator('#save-knowledge-name').click();await page.locator('#knowledge-detail-title').filter({hasText:'独立知识库'}).waitFor();await page.reload();await page.locator('#knowledge-detail-title').filter({hasText:'独立知识库'}).waitFor();
  await page.locator('#open-knowledge-training').click();await page.waitForFunction(()=>document.getElementById('training-knowledge').selectedOptions[0]?.textContent==='独立知识库');assert.equal(await page.locator('#training-vector-top-k').inputValue(),'20');assert.equal(await page.locator('#start-knowledge-training').isDisabled(),true);
  assert.deepEqual(errors,[]);
  await writeFile(join(captureDirectory,'browser-checks.json'),JSON.stringify({mockOnly:true,viewports:['1440x1000','390x844'],singleSidebarEntry:true,createUploadPreviewTrainRetrieve:true,duplicateRejected:true,settingsPersist:true,deleteRestore:true,permanentDeleteConfirmCancel:true,permanentDeleteAfterReload:true,strictHeaderNotice:true,cleanDetailHeader:true,noDocumentOverflow:true,noScriptExecution:true,errors},null,2));
  console.log('知识库桌面/手机完整流程通过，截图已保存。');
}finally{await browser.close();await app.assessment.shutdown();await app.indexer.shutdown();await new Promise(done=>app.server.close(done));app.store.close();await mock.close();}
