"use strict";
const views = { supplier:'供应商自评', 'knowledge-list':'知识库', 'knowledge-preview':'知识库详情', 'knowledge-training':'知识库训练', 'model-settings':'模型配置', 'task-history':'任务记录' };
const uploadedKnowledgeBases = [], knowledgeDeleteHistory = [];
let selectedKnowledgeProjectId = '';
try { selectedKnowledgeProjectId = localStorage.getItem('qsa-knowledge-project') || ''; } catch {}
let selectedKnowledgeFileId = '', selectedKnowledgeSheet = '', knowledgePage = 1, knowledgeTotal = 0;
let knowledgeRequest = 0, catalogRequest = 0, uploadBusy = false, uploadDraft = null, uploadTarget = null, knowledgeSearchTimer, libraryPoll;
let pendingKnowledgeDelete = null, pendingFileDelete = null, namingProject = null;
const $k = id => document.getElementById(id);
const uploadDialog = $k('knowledge-upload-dialog'), nameDialog = $k('knowledge-name-dialog'), knowledgeDeleteDialog = $k('delete-knowledge-dialog'), fileDeleteDialog = $k('knowledge-file-delete-dialog');
const fileStatusNames = { unlearned:'未学习', learning:'学习中', learned:'已学习', outdated:'待更新', failed:'学习失败' };
async function knowledgeApi(path, options = {}) {
  let response;
  try { response = await fetch(path,{...options,signal:AbortSignal.timeout(75000)}); } catch { throw new Error('本地服务未响应，请确认服务正在运行后重试。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('服务响应格式无效，请重新启动 QSA 服务。'); }
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
}
function jsonRequest(method,body={}) { return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}; }
function currentKnowledgeProject() { return uploadedKnowledgeBases.find(p=>p.id===selectedKnowledgeProjectId); }
function currentKnowledgeFile() { return currentKnowledgeProject()?.files.find(f=>f.id===selectedKnowledgeFileId); }
function sheetLabel(project,scope) { return project?.sheetDetails.find(s=>s.name===scope)?.label || scope; }
function fileBadge(file) { return `<span class="library-status library-status-${file.status}">${fileStatusNames[file.status]}${file.status==='learned' && file.learnedCount<file.summary.answeredCount ? ' · 部分':''}</span>`; }
function setServiceError(message='') { const banner=$k('knowledge-service-message');banner.hidden=!message;banner.querySelector('span').textContent=message; }
function selectKnowledgeProject(id) {
  if (!uploadedKnowledgeBases.some(p=>p.id===id)) return;
  catalogRequest++;
  selectedKnowledgeProjectId=id;selectedKnowledgeFileId='';selectedKnowledgeSheet='';knowledgePage=1;
  try {localStorage.setItem('qsa-knowledge-project',id);} catch {}
  $k('knowledge-search').value='';$k('library-file-search').value='';$k('knowledge-missing-only').checked=false;$k('knowledge-saved-diagnostics').hidden=true;
  renderKnowledgeProjects();
}
async function loadKnowledgeCatalog(preferredId=selectedKnowledgeProjectId,quiet=false) {
  const request=++catalogRequest;
  try {
    const data=await knowledgeApi('/api/knowledge');if(request!==catalogRequest)return;
    const before=currentKnowledgeProject(), key=p=>p ? JSON.stringify([p.id,p.versionId,p.name]):'';
    uploadedKnowledgeBases.splice(0,uploadedKnowledgeBases.length,...data.projects);knowledgeDeleteHistory.splice(0,knowledgeDeleteHistory.length,...data.trash);
    selectedKnowledgeProjectId=data.projects.some(p=>p.id===preferredId)?preferredId:data.projects[0]?.id||'';setServiceError();
    try{localStorage.setItem('qsa-knowledge-project',selectedKnowledgeProjectId);}catch{}
    if(!quiet || key(before)!==key(currentKnowledgeProject()))renderKnowledgeProjects();else if(JSON.stringify(before?.files)!==JSON.stringify(currentKnowledgeProject()?.files)){renderKnowledgeCatalog();renderFileDirectory();}
  } catch(error) {if(request===catalogRequest){setServiceError(error.message);if(!quiet)showToast(error.message);}}
}
function renderKnowledgeCatalog() {
  const query=$k('knowledge-catalog-search').value.trim().toLowerCase(),projects=uploadedKnowledgeBases.filter(p=>p.name.toLowerCase().includes(query));
  $k('knowledge-catalog-count').textContent=`全部知识库 · ${uploadedKnowledgeBases.length}`;$k('knowledge-project-empty').hidden=uploadedKnowledgeBases.length>0;$k('knowledge-catalog-empty').hidden=projects.length>0||!uploadedKnowledgeBases.length;
  $k('knowledge-catalog-body').innerHTML=projects.map(p=>{
    const counts=Object.entries(fileStatusNames).map(([status,label])=>{const n=p.files.filter(f=>f.status===status).length;return n?`${label} ${n}`:'';}).filter(Boolean).join(' · ');
    return `<tr><td><button class="library-name" data-library="${p.id}">${icon('book')}<strong>${escapeHTML(p.name)}</strong></button></td><td>${p.fileCount} 个</td><td>${escapeHTML(counts||'暂无文件')}</td><td><time datetime="${p.updatedAt}">${escapeHTML(new Date(p.updatedAt).toLocaleString('zh-CN',{hour12:false}))}</time></td><td><div class="record-actions"><button class="text-button" data-library-rename="${p.id}">重命名</button><button class="text-button danger-text" data-library-delete="${p.id}">删除</button></div></td></tr>`;
  }).join('');
  $k('knowledge-undo-bar').hidden=!knowledgeDeleteHistory.length;$k('knowledge-undo-message').textContent=knowledgeDeleteHistory.length?`已删除“${knowledgeDeleteHistory[0].name}” · ${knowledgeDeleteHistory.length} 项可恢复`:'';
}
function renderKnowledgeProjects() {
  const p=currentKnowledgeProject();
  document.querySelectorAll('[data-knowledge-project]').forEach(select=>{select.innerHTML=uploadedKnowledgeBases.map(item=>`<option value="${item.id}">${escapeHTML(item.name)}</option>`).join('')||'<option value="">暂无知识库</option>';select.value=selectedKnowledgeProjectId;select.disabled=!p;});
  $k('knowledge-detail-title').textContent=p?.name||'知识库';$k('training-library-title').textContent=p?.name||'';
  if(location.hash==='#knowledge-preview')$k('breadcrumb-current').textContent=p?.name||'知识库详情';
  $k('knowledge-project-summary').textContent=p?`${p.fileCount} 个文件 · ${p.summary.questionCount} 项问题 · ${p.summary.answeredCount} 条有说明`:'';
  $k('knowledge-version-label').textContent=p?`文件版本 v${p.version}`:'';
  for(const id of ['delete-knowledge-project','rename-knowledge-project','show-knowledge-diagnostics','open-knowledge-training','open-knowledge-upload'])$k(id).disabled=!p;
  $k('supplier-knowledge-sheets').innerHTML=Object.entries(p?.sheets||{}).map(([scope,count])=>`<button type="button" data-sheet="${escapeHTML(scope)}">${escapeHTML(sheetLabel(p,scope))} <span>${count}</span></button>`).join('');
  $k('supplier-knowledge-total').textContent=p?`${p.summary.answeredCount} 条有说明`:'未选择知识库';
  renderKnowledgeCatalog();renderFileDirectory();renderKnowledge();document.dispatchEvent(new CustomEvent('knowledge-projects-change'));
}
function fileSheets() {const p=currentKnowledgeProject(),f=currentKnowledgeFile();return p?.sheetDetails.filter(s=>(s.documentId===f?.id||(!s.documentId&&f?.id===p.id))&&s.headerRow!==null)||[];}
function renderFileDirectory() {
  const focusedFile=document.activeElement?.dataset.libraryFile;
  const p=currentKnowledgeProject(),query=$k('library-file-search').value.trim().toLowerCase();
  if(!p?.files.some(f=>f.id===selectedKnowledgeFileId)){selectedKnowledgeFileId=p?.files[0]?.id||'';selectedKnowledgeSheet='';}
  const f=currentKnowledgeFile(),sheets=fileSheets();if(!sheets.some(s=>s.name===selectedKnowledgeSheet))selectedKnowledgeSheet=sheets[0]?.name||'';
  $k('library-file-count').textContent=p?.fileCount||0;
  $k('library-file-list').innerHTML=(p?.files||[]).filter(file=>file.name.toLowerCase().includes(query)).map(file=>`<button class="library-file ${file.id===selectedKnowledgeFileId?'selected':''}" data-library-file="${file.id}" aria-pressed="${file.id===selectedKnowledgeFileId}">${icon('file')}<span><strong>${escapeHTML(file.name)}</strong><small>${fileBadge(file)}<span>${file.summary.questionCount} 项问题</span></small></span></button>`).join('');
  if(focusedFile)document.querySelector(`[data-library-file="${focusedFile}"]`)?.focus({preventScroll:true});
  $k('library-no-files').hidden=Boolean(p?.files.some(file=>file.name.toLowerCase().includes(query)));$k('library-no-files').textContent=p?.fileCount?'没有匹配的文件':'暂无文件，请先上传';
  $k('library-deleted-files').hidden=!p?.trashFiles.length;$k('library-file-trash').innerHTML=(p?.trashFiles||[]).map(file=>`<div class="library-trash-file"><span>${escapeHTML(file.name)}</span><button class="text-button" data-restore-file="${file.id}">恢复</button></div>`).join('');
  $k('library-preview-name').textContent=f?.name||'选择文件预览';$k('library-preview-info').textContent=f?`${fileStatusNames[f.status]} · ${f.learnedCount}/${f.summary.answeredCount} 条有说明记录已学习 · ${f.summary.missingCount} 条缺少说明 · ${f.summary.skippedCount} 行跳过`:'';
  $k('library-file-error').hidden=!f?.error;$k('library-file-error').textContent=f?.error||'';
  const learning=Boolean(p?.files.some(file=>file.status==='learning'));
  for(const id of ['open-knowledge-upload','delete-knowledge-project','rename-knowledge-project']){$k(id).disabled=!p||learning;$k(id).title=learning?'训练结束或取消后可管理文件':'';}
  for(const id of ['replace-knowledge-file','delete-knowledge-file'])$k(id).disabled=!f||p.files.some(file=>file.status==='learning');
}
async function renderKnowledge() {
  const p=currentKnowledgeProject(),f=currentKnowledgeFile(),request=++knowledgeRequest,sheets=fileSheets();$k('knowledge-table-panel').hidden=!f;
  const tbody=$k('knowledge-records'),empty=$k('knowledge-empty');tbody.innerHTML='';$k('knowledge-page-label').textContent='';
  $k('knowledge-sheet-tabs').innerHTML=sheets.map(s=>`<button role="tab" aria-selected="${s.name===selectedKnowledgeSheet}" tabindex="${s.name===selectedKnowledgeSheet?0:-1}" data-knowledge-sheet="${escapeHTML(s.name)}">${escapeHTML(s.sourceSheet||s.name)}<span>${s.questionCount}</span></button>`).join('');
  for(const id of ['knowledge-prev-page','knowledge-next-page'])$k(id).disabled=true;
  if(!p||!f)return;empty.hidden=false;empty.textContent='正在加载记录…';
  const params=new URLSearchParams({file:f.id,sheet:selectedKnowledgeSheet,q:$k('knowledge-search').value.trim(),status:$k('knowledge-missing-only').checked?'missing':'all',page:knowledgePage,limit:30});
  try {
    const data=await knowledgeApi(`/api/knowledge/${p.id}/records?${params}`);if(request!==knowledgeRequest)return;knowledgeTotal=data.total;
    tbody.innerHTML=data.records.map(r=>`<tr><td><span class="knowledge-line">${r.line}</span><span class="knowledge-cell-reference">${escapeHTML(r.questionCell)} / ${escapeHTML(r.answerCell)}</span></td><td>${r.chapter?`<span class="knowledge-chapter">${escapeHTML(r.chapter)}</span>`:''}${escapeHTML(r.question)}</td><td>${r.answer?escapeHTML(r.answer):'<span class="knowledge-missing-answer">缺少自评说明</span>'}</td></tr>`).join('');
    empty.hidden=Boolean(data.records.length);empty.textContent='无匹配内容';$k('knowledge-preview-count').textContent=data.total?`第 ${(knowledgePage-1)*30+1}–${(knowledgePage-1)*30+data.records.length} 条 · 共 ${data.total} 条`:'0 条匹配记录';
    $k('knowledge-total-count').textContent=sheets.find(s=>s.name===selectedKnowledgeSheet)?.sourceSheet||selectedKnowledgeSheet;$k('knowledge-page-label').textContent=`${knowledgePage} / ${Math.max(1,Math.ceil(data.total/30))}`;$k('knowledge-prev-page').disabled=knowledgePage<=1;$k('knowledge-next-page').disabled=knowledgePage*30>=data.total;
  }catch(error){if(request===knowledgeRequest){empty.hidden=false;empty.textContent=error.message;}}
}
function detailsMarkup(data) {
  return `<dl class="import-summary">${[['questionCount','有效问题'],['answeredCount','有说明'],['missingCount','缺少说明'],['skippedCount','跳过行']].map(([key,label])=>`<div><dt>${label}</dt><dd>${data.summary[key]||0}</dd></div>`).join('')}</dl><ul class="import-sheet-summary">${data.sheets.map(s=>`<li><strong>${escapeHTML(s.label||s.name)}</strong><span>${s.headerRow===null?'表头未识别，已跳过':`${s.questionCount} 项问题 · ${s.missingCount} 项缺少说明`}</span></li>`).join('')}</ul><details class="import-diagnostics"><summary>校验与跳过原因（${data.diagnostics.length} 处）</summary><ul class="import-diagnostic-list">${data.diagnostics.map(i=>`<li><span>${escapeHTML(i.fileName||'')} ${escapeHTML(i.sheet)}${i.row?` · 第 ${i.row} 行`:''}</span><span>${escapeHTML(i.reason)}</span></li>`).join('')}</ul></details>`;
}
function showUploadStatus(message,error=false){const el=$k('knowledge-upload-status');el.textContent=message;el.classList.toggle('is-error',error);}
function setUploadBusy(busy){uploadBusy=busy;for(const id of ['choose-knowledge-file','knowledge-file-input'])$k(id).disabled=busy;$k('confirm-knowledge-upload').disabled=busy||!uploadDraft;}
function openKnowledgeUpload(replace=false){
  const p=currentKnowledgeProject(),f=currentKnowledgeFile();if(!p){openKnowledgeName();return;}if(replace&&!f)return;
  uploadTarget={mode:replace?'replace-file':'append',projectId:p.id,expectedVersionId:p.versionId,...(replace?{documentId:f.id}:{})};uploadDraft=null;$k('knowledge-upload-preview').hidden=true;$k('knowledge-file-input').value='';
  $k('knowledge-upload-title').textContent=replace?'替换文件':'上传文件';$k('knowledge-upload-filename').textContent=replace?f.name:'知识库文件';$k('knowledge-upload-target').textContent=`${p.name}${replace?` / ${f.name}`:''} · 保存后需训练，上传不会自动学习`;showUploadStatus('请选择 .xlsx 文件');setUploadBusy(false);uploadDialog.showModal();
}
async function stageKnowledgeFile(file){
  if(!file||uploadBusy)return;uploadDraft=null;$k('knowledge-upload-preview').hidden=true;
  if(!/\.xlsx$/i.test(file.name)||!file.size||file.size>20*1024*1024){showUploadStatus('请选择非空的 .xlsx 文件，大小不超过 20 MB。',true);setUploadBusy(false);return;}
  setUploadBusy(true);showUploadStatus('正在上传并解析…');$k('knowledge-upload-filename').textContent=file.name;
  try{uploadDraft=await knowledgeApi('/api/knowledge/imports',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});$k('knowledge-upload-preview').innerHTML=detailsMarkup(uploadDraft);$k('knowledge-upload-preview').hidden=false;showUploadStatus(`解析完成 · ${uploadDraft.summary.questionCount} 项问题，请确认保存`);}catch(error){showUploadStatus(error.message,true);}finally{setUploadBusy(false);}
}
async function commitKnowledgeUpload(){
  if(!uploadDraft||uploadBusy)return;const draft=uploadDraft,target={...uploadTarget};setUploadBusy(true);
  try{const{project}=await knowledgeApi(`/api/knowledge/imports/${draft.importId}/commit`,jsonRequest('POST',target));uploadDialog.close();uploadDraft=null;selectedKnowledgeFileId=target.documentId||project.files.find(f=>f.fileId===draft.importId)?.id||'';selectedKnowledgeSheet='';knowledgePage=1;await loadKnowledgeCatalog(project.id);navigate('knowledge-preview');showToast('文件已保存，完成知识库训练后用于检索');}catch(error){showUploadStatus(error.message,true);}finally{setUploadBusy(false);}
}
function openKnowledgeName(project=null){namingProject=project?{...project}:null;$k('knowledge-name-title').textContent=project?'重命名知识库':'新建知识库';$k('knowledge-name-input').value=project?.name||'';$k('save-knowledge-name').textContent=project?'保存':'创建';$k('knowledge-name-error').textContent='';nameDialog.showModal();$k('knowledge-name-input').focus();}
function openKnowledgeDelete(project){if(!project)return;pendingKnowledgeDelete={...project};$k('delete-knowledge-name').textContent=project.name;knowledgeDeleteDialog.showModal();}
function renderView(view){
  if(view==='knowledge-upload')view='knowledge-preview';const current=Object.hasOwn(views,view)?view:'supplier';
  document.querySelectorAll('[data-page]').forEach(page=>{page.hidden=page.dataset.page!==current;});
  document.querySelectorAll('.nav-item').forEach(item=>{const active=item.classList.contains('nav-parent')?current.startsWith('knowledge-'):item.dataset.view===current;item.classList.toggle('active',active);if(active)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
  document.querySelector('.nav-parent').classList.toggle('parent-active',current.startsWith('knowledge-'));const parent=$k('breadcrumb-parent');parent.textContent=current.startsWith('knowledge-')?'知识库':current==='model-settings'?'设置':'供应商自评';parent.hidden=current==='supplier'||current==='knowledge-list';parent.nextElementSibling.toggleAttribute('hidden',parent.hidden);
  $k('breadcrumb-current').textContent=current==='knowledge-preview'?currentKnowledgeProject()?.name||views[current]:views[current];document.title=`${views[current]} · QSA`;closeSidebar();clearTimeout(libraryPoll);if(current.startsWith('knowledge-'))libraryPoll=setTimeout(pollLibrary,1800);
}
async function pollLibrary(){if(!location.hash.startsWith('#knowledge-'))return;await loadKnowledgeCatalog(selectedKnowledgeProjectId,true);libraryPoll=setTimeout(pollLibrary,1800);}
function navigate(view){if(view==='knowledge-upload'){openKnowledgeUpload();return;}if(!Object.hasOwn(views,view))return;if(location.hash!==`#${view}`)location.hash=view;renderView(view);window.scrollTo({top:0,behavior:'instant'});}
document.addEventListener('click',async event=>{
  const t=event.target;
  if(t.closest('[data-close-upload]')){if(!uploadBusy)uploadDialog.close();return;}if(t.closest('[data-close-name]')){nameDialog.close();return;}if(t.closest('[data-create-library]')){openKnowledgeName();return;}
  const library=t.closest('[data-library]');if(library){selectKnowledgeProject(library.dataset.library);navigate('knowledge-preview');return;}
  const rename=t.closest('[data-library-rename]');if(rename){openKnowledgeName(uploadedKnowledgeBases.find(p=>p.id===rename.dataset.libraryRename));return;}
  const remove=t.closest('[data-library-delete]');if(remove){openKnowledgeDelete(uploadedKnowledgeBases.find(p=>p.id===remove.dataset.libraryDelete));return;}
  const file=t.closest('[data-library-file]');if(file){selectedKnowledgeFileId=file.dataset.libraryFile;selectedKnowledgeSheet='';knowledgePage=1;$k('knowledge-search').value='';renderFileDirectory();renderKnowledge();return;}
  const restore=t.closest('[data-restore-file]');if(restore){const p=currentKnowledgeProject();restore.disabled=true;try{await knowledgeApi(`/api/knowledge/${p.id}/files/${restore.dataset.restoreFile}/restore`,jsonRequest('POST',{expectedVersionId:p.versionId}));await loadKnowledgeCatalog(p.id);showToast('文件已恢复，请更新索引');}catch(error){showToast(error.message);}finally{restore.disabled=false;}return;}
  const sheet=t.closest('[data-knowledge-sheet], [data-sheet]');if(sheet){selectedKnowledgeSheet=sheet.dataset.knowledgeSheet||sheet.dataset.sheet;const p=currentKnowledgeProject(),s=p?.sheetDetails.find(item=>item.name===selectedKnowledgeSheet);selectedKnowledgeFileId=s?.documentId||p?.files[0]?.id||'';knowledgePage=1;renderFileDirectory();renderKnowledge();if(sheet.dataset.sheet)navigate('knowledge-preview');else document.querySelector(`[data-knowledge-sheet="${CSS.escape(selectedKnowledgeSheet)}"]`)?.focus();return;}
  const view=t.closest('[data-view]');if(view){event.preventDefault();navigate(view.dataset.view);}
});
$k('create-knowledge-project').addEventListener('click',()=>openKnowledgeName());$k('rename-knowledge-project').addEventListener('click',()=>openKnowledgeName(currentKnowledgeProject()));$k('delete-knowledge-project').addEventListener('click',()=>openKnowledgeDelete(currentKnowledgeProject()));
$k('knowledge-name-form').addEventListener('submit',async event=>{event.preventDefault();const button=$k('save-knowledge-name');if(button.disabled)return;button.disabled=true;const p=namingProject,name=$k('knowledge-name-input').value.trim();try{const data=await knowledgeApi(p?`/api/knowledge/${p.id}`:'/api/knowledge',jsonRequest(p?'PATCH':'POST',{name,...(p?{expectedVersionId:p.versionId}:{})}));nameDialog.close();await loadKnowledgeCatalog(data.project.id);if(!p)navigate('knowledge-preview');}catch(error){$k('knowledge-name-error').textContent=error.message;}finally{button.disabled=false;}});
$k('confirm-knowledge-delete').addEventListener('click',async event=>{const p=pendingKnowledgeDelete;if(!p)return;event.currentTarget.disabled=true;try{await knowledgeApi(`/api/knowledge/${p.id}`,jsonRequest('DELETE',{expectedVersionId:p.versionId}));knowledgeDeleteDialog.close();await loadKnowledgeCatalog();navigate('knowledge-list');}catch(error){showToast(error.message);}finally{$k('confirm-knowledge-delete').disabled=false;}});
$k('undo-knowledge-delete').addEventListener('click',async event=>{const p=knowledgeDeleteHistory[0];if(!p)return;event.currentTarget.disabled=true;try{await knowledgeApi(`/api/knowledge/${p.id}/restore`,jsonRequest('POST'));await loadKnowledgeCatalog(p.id);}catch(error){showToast(error.message);}finally{$k('undo-knowledge-delete').disabled=false;}});
$k('open-knowledge-upload').addEventListener('click',()=>openKnowledgeUpload());$k('replace-knowledge-file').addEventListener('click',()=>openKnowledgeUpload(true));
$k('delete-knowledge-file').addEventListener('click',()=>{const p=currentKnowledgeProject(),f=currentKnowledgeFile();if(!f)return;pendingFileDelete={projectId:p.id,expectedVersionId:p.versionId,id:f.id};$k('knowledge-file-delete-name').textContent=f.name;$k('knowledge-file-delete-error').textContent='';fileDeleteDialog.showModal();});
$k('confirm-knowledge-file-delete').addEventListener('click',async event=>{if(!pendingFileDelete)return;const target={...pendingFileDelete};event.currentTarget.disabled=true;try{await knowledgeApi(`/api/knowledge/${target.projectId}/files/${target.id}`,jsonRequest('DELETE',{expectedVersionId:target.expectedVersionId}));fileDeleteDialog.close();await loadKnowledgeCatalog(target.projectId);showToast('文件已删除，更新索引后从检索中移除');}catch(error){$k('knowledge-file-delete-error').textContent=error.message;}finally{$k('confirm-knowledge-file-delete').disabled=false;}});
$k('choose-knowledge-file').addEventListener('click',()=>{const input=$k('knowledge-file-input');input.value='';input.click();});$k('knowledge-file-input').addEventListener('change',event=>stageKnowledgeFile(event.target.files[0]));$k('confirm-knowledge-upload').addEventListener('click',commitKnowledgeUpload);uploadDialog.addEventListener('cancel',event=>{if(uploadBusy)event.preventDefault();});
const knowledgeDropzone=$k('knowledge-dropzone');for(const name of ['dragenter','dragover','dragleave','drop'])knowledgeDropzone.addEventListener(name,event=>{event.preventDefault();knowledgeDropzone.classList.toggle('drag-over',['dragenter','dragover'].includes(name));});knowledgeDropzone.addEventListener('drop',event=>{if(event.dataTransfer.files.length!==1){showUploadStatus('请每次上传一个文件。',true);return;}stageKnowledgeFile(event.dataTransfer.files[0]);});
$k('knowledge-catalog-search').addEventListener('input',renderKnowledgeCatalog);$k('library-file-search').addEventListener('input',renderFileDirectory);$k('knowledge-search').addEventListener('input',()=>{clearTimeout(knowledgeSearchTimer);knowledgeRequest++;knowledgeSearchTimer=setTimeout(()=>{knowledgePage=1;renderKnowledge();},180);});$k('knowledge-missing-only').addEventListener('change',()=>{knowledgePage=1;renderKnowledge();});$k('knowledge-prev-page').addEventListener('click',()=>{if(knowledgePage>1){knowledgePage--;renderKnowledge();}});$k('knowledge-next-page').addEventListener('click',()=>{if(knowledgePage*30<knowledgeTotal){knowledgePage++;renderKnowledge();}});
$k('knowledge-sheet-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...event.currentTarget.querySelectorAll('button')],index=tabs.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next]?.click();});
document.querySelectorAll('[data-knowledge-project]').forEach(select=>select.addEventListener('change',()=>selectKnowledgeProject(select.value)));$k('retry-knowledge-load').addEventListener('click',()=>loadKnowledgeCatalog());
$k('show-knowledge-diagnostics').addEventListener('click',async()=>{const p=currentKnowledgeProject();if(!p)return;try{const[data,history]=await Promise.all([knowledgeApi(`/api/knowledge/${p.id}/diagnostics`),knowledgeApi(`/api/knowledge/${p.id}/versions`)]);if(currentKnowledgeProject()?.versionId!==p.versionId)return;$k('knowledge-saved-details').innerHTML=detailsMarkup(data)+`<h3>历史版本</h3><ul class="import-sheet-summary">${history.versions.map(v=>`<li><strong>v${v.number}</strong><span>${v.summary.questionCount} 项问题 · ${escapeHTML(new Date(v.createdAt).toLocaleString('zh-CN'))}</span></li>`).join('')}</ul>`;const details=$k('knowledge-saved-diagnostics');details.hidden=false;details.open=true;details.scrollIntoView({block:'start'});}catch(error){showToast(error.message);}});
$k('jump-retrieval').addEventListener('click',event=>{event.preventDefault();$k('retrieval-title').scrollIntoView({block:'start'});$k('retrieval-query').focus({preventScroll:true});});window.addEventListener('hashchange',()=>{if(location.hash!=='#main')renderView(location.hash.slice(1));});
renderKnowledgeProjects();renderView(location.hash.slice(1));loadKnowledgeCatalog();
