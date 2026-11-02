"use strict";

// Live knowledge catalog. Assessment/model/history samples remain separate.
const views = { supplier: "供应商自评", "knowledge-preview": "知识库预览", "knowledge-upload": "知识库上传", "knowledge-training": "知识库训练", "model-settings": "模型配置", "task-history": "任务记录" };
const uploadedKnowledgeBases = [];
let selectedKnowledgeProjectId = "";
let selectedKnowledgeSheet = "";
const knowledgeDeleteHistory = [];
let pendingKnowledgeDelete = null;
let knowledgePage = 1;
let knowledgeTotal = 0;
let knowledgeRequest = 0;
let catalogRequest = 0;
let uploadRequest = 0;
let uploadBusy = false;
let uploadDraft = null;
let uploadTarget = null;
let knowledgeSearchTimer;
const knowledgeDeleteDialog = document.getElementById("delete-knowledge-dialog");
const uploadStatus = document.getElementById("knowledge-upload-status");

async function knowledgeApi(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, signal: AbortSignal.timeout(75000) }); }
  catch { throw new Error(location.protocol === "file:" ? "请启动本地服务，并通过 http://127.0.0.1:4174 打开页面。" : "本地服务未响应，请确认服务正在运行后重试。"); }
  let data;
  try { data = await response.json(); } catch { throw new Error("服务响应格式无效，请确认已启动新版 QSA 服务。"); }
  if (!response.ok) throw new Error(data.error || "操作失败，请重试。");
  return data;
}
function jsonRequest(method, body = {}) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function currentKnowledgeProject() { return uploadedKnowledgeBases.find(project => project.id === selectedKnowledgeProjectId); }
function setServiceError(message = "") {
  const banner = document.getElementById("knowledge-service-message");
  banner.hidden = !message;
  banner.querySelector("span").textContent = message;
}
function showUploadStatus(message, error = false) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("is-error", error);
}
function selectKnowledgeProject(id) {
  if (!uploadedKnowledgeBases.some(project => project.id === id)) return;
  selectedKnowledgeProjectId = id;
  knowledgePage = 1;
  document.getElementById("knowledge-search").value = "";
  document.getElementById("knowledge-missing-only").checked = false;
  document.getElementById("supplier-record-context").hidden = true;
  document.getElementById("knowledge-saved-diagnostics").hidden = true;
  renderKnowledgeProjects();
}
async function loadKnowledgeCatalog(preferredId = selectedKnowledgeProjectId) {
  const request = ++catalogRequest;
  try {
    const data = await knowledgeApi("/api/knowledge");
    if (request !== catalogRequest) return;
    uploadedKnowledgeBases.splice(0, uploadedKnowledgeBases.length, ...data.projects);
    knowledgeDeleteHistory.splice(0, knowledgeDeleteHistory.length, ...data.trash);
    selectedKnowledgeProjectId = data.projects.some(project => project.id === preferredId) ? preferredId : data.projects[0]?.id || "";
    setServiceError();
    renderKnowledgeProjects();
  } catch (error) {
    if (request !== catalogRequest) return;
    setServiceError(error.message);
    showUploadStatus(error.message, true);
    showToast(error.message);
  }
}
function renderKnowledgeProjects() {
  const project = currentKnowledgeProject();
  const snapshot = false;
  const options = uploadedKnowledgeBases.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join("") || '<option value="">暂无知识库项目</option>';
  document.querySelectorAll("[data-knowledge-project]").forEach(select => {
    select.innerHTML = options;
    select.value = selectedKnowledgeProjectId;
    select.disabled = !project || uploadBusy;
  });
  const sheets = Object.entries(project?.sheets || {});
  if (!Object.hasOwn(project?.sheets || {}, selectedKnowledgeSheet)) selectedKnowledgeSheet = sheets[0]?.[0] || "";
  document.getElementById("knowledge-project-summary").textContent = project ? `${sheets.length} 张可用工作表 · ${project.summary.questionCount.toLocaleString("zh-CN")} 项问题 · ${project.summary.answeredCount.toLocaleString("zh-CN")} 条有说明 · ${project.summary.missingCount} 条缺少说明` : "";
  document.getElementById("knowledge-version-label").textContent = project ? `v${project.version} · 已保存` : "本地保存";
  document.getElementById("delete-knowledge-project").disabled = !project || uploadBusy;
  document.getElementById("show-knowledge-diagnostics").disabled = !project;
  document.getElementById("knowledge-project-empty").hidden = Boolean(project);
  document.getElementById("knowledge-table-panel").hidden = !project;
  const supplierProject = project;
  document.getElementById("supplier-knowledge-sheets").innerHTML = Object.entries(supplierProject?.sheets || {}).map(([name, count]) => `<button type="button" data-sheet="${escapeHTML(name)}"${snapshot ? " disabled" : ""}>${escapeHTML(name)} <span>${count}</span></button>`).join("");
  document.getElementById("supplier-knowledge-total").textContent = project ? `${project.summary.answeredCount.toLocaleString("zh-CN")} 条有说明 · 未建立索引` : "未选择知识库";
  document.getElementById("supplier-review-section").hidden = !snapshot;
  document.getElementById("supplier-generation-empty").hidden = snapshot;
  document.querySelector(".workflow").hidden = !snapshot;
  document.getElementById("start-supplier-assessment").disabled = true;
  document.getElementById("start-supplier-assessment").title = "正在核对待填表和模型";
  document.getElementById("supplier-empty-title").textContent = project ? "尚未生成自评说明" : "请先上传知识库";
  const action = document.getElementById("supplier-empty-action");
  action.dataset.view = project ? "knowledge-preview" : "knowledge-upload";
  action.innerHTML = `${project ? "查看知识库" : "上传知识库"}${icon("arrow")}`;
  const deleted = knowledgeDeleteHistory[0];
  document.getElementById("knowledge-undo-bar").hidden = !deleted;
  document.getElementById("knowledge-undo-message").textContent = deleted ? `已删除“${deleted.name}”${knowledgeDeleteHistory.length > 1 ? `，共 ${knowledgeDeleteHistory.length} 项可撤销` : ""}` : "";
  document.querySelector(".current-knowledge-panel").innerHTML = project ? `<h2>当前知识库</h2><div class="current-file-name">${icon("file")}<strong>${escapeHTML(project.name)}</strong></div><dl class="knowledge-facts"><div><dt>版本</dt><dd>v${project.version}</dd></div><div><dt>工作表</dt><dd>${sheets.length} 张</dd></div><div><dt>有效问题</dt><dd>${project.summary.questionCount.toLocaleString("zh-CN")} 项</dd></div><div><dt>有自评说明</dt><dd>${project.summary.answeredCount.toLocaleString("zh-CN")} 条</dd></div><div><dt>缺少说明</dt><dd>${project.summary.missingCount} 条</dd></div></dl><div class="current-sheet-list">${sheets.map(([name]) => `<span>${escapeHTML(name)}</span>`).join("")}</div><button class="text-button" data-view="knowledge-preview">预览知识库${icon("arrow")}</button>` : '<h2>当前知识库</h2><p class="no-source">暂无知识库项目</p>';
  const replace = document.querySelector('input[name="upload-mode"][value="replace"]');
  replace.disabled = !project || uploadBusy;
  if (!project) document.querySelector('input[name="upload-mode"][value="new"]').checked = true;
  renderUploadMode();
  renderKnowledge();
  document.dispatchEvent(new CustomEvent("knowledge-projects-change"));
}
async function renderKnowledge() {
  const project = currentKnowledgeProject();
  const request = ++knowledgeRequest;
  const tbody = document.getElementById("knowledge-records");
  tbody.innerHTML = "";
  document.getElementById("knowledge-prev-page").disabled = true;
  document.getElementById("knowledge-next-page").disabled = true;
  document.getElementById("knowledge-page-label").textContent = "";
  const empty = document.getElementById("knowledge-empty");
  document.getElementById("knowledge-sheet-tabs").innerHTML = Object.entries(project?.sheets || {}).map(([name, count]) => `<button role="tab" aria-selected="${name === selectedKnowledgeSheet}" aria-controls="knowledge-records" tabindex="${name === selectedKnowledgeSheet ? 0 : -1}" data-knowledge-sheet="${escapeHTML(name)}" class="${name === selectedKnowledgeSheet ? "selected" : ""}">${escapeHTML(name)}<span>${count}</span></button>`).join("");
  document.getElementById("knowledge-preview-count").textContent = project ? "正在加载记录…" : "";
  document.getElementById("knowledge-total-count").textContent = project ? `${selectedKnowledgeSheet} · ${project.sheets[selectedKnowledgeSheet] || 0} 项问题` : "";
  if (!project) { empty.hidden = true; return; }
  empty.hidden = false; empty.textContent = "正在加载记录…";
  const params = new URLSearchParams({ sheet: selectedKnowledgeSheet, q: document.getElementById("knowledge-search").value.trim(), status: document.getElementById("knowledge-missing-only").checked ? "missing" : "all", page: knowledgePage, limit: 30 });
  document.getElementById("knowledge-table-panel").setAttribute("aria-busy", "true");
  try {
    const data = await knowledgeApi(`/api/knowledge/${project.id}/records?${params}`);
    if (request !== knowledgeRequest) return;
    setServiceError();
    knowledgeTotal = data.total;
    tbody.innerHTML = data.records.map(record => `<tr><td><span class="knowledge-line">${record.line}</span><span class="knowledge-cell-reference">${escapeHTML(record.questionCell)} / ${escapeHTML(record.answerCell)}</span></td><td>${record.chapter ? `<span class="knowledge-chapter">${escapeHTML(record.chapter)}</span>` : ""}${escapeHTML(record.question)}</td><td>${record.answer ? escapeHTML(record.answer) : '<span class="knowledge-missing-answer">缺少自评说明</span>'}</td></tr>`).join("");
    empty.hidden = data.records.length !== 0; empty.textContent = "无匹配内容";
    const start = (knowledgePage - 1) * 30;
    document.getElementById("knowledge-preview-count").textContent = data.total ? `第 ${start + 1}–${start + data.records.length} 条 · 共 ${data.total.toLocaleString("zh-CN")} 条` : "0 条匹配记录";
    document.getElementById("knowledge-page-label").textContent = `${knowledgePage} / ${Math.max(1, Math.ceil(data.total / 30))}`;
    document.getElementById("knowledge-prev-page").disabled = knowledgePage <= 1;
    document.getElementById("knowledge-next-page").disabled = knowledgePage * 30 >= data.total;
  } catch (error) {
    if (request !== knowledgeRequest) return;
    tbody.innerHTML = ""; empty.hidden = false; empty.textContent = error.message;
    document.getElementById("knowledge-preview-count").textContent = "加载失败";
    setServiceError(error.message);
  } finally {
    if (request === knowledgeRequest) document.getElementById("knowledge-table-panel").setAttribute("aria-busy", "false");
  }
}
function detailsMarkup(data) {
  const summary = data.summary;
  const counts = `<dl class="import-summary"><div><dt>有效问题</dt><dd>${summary.questionCount}</dd></div><div><dt>有说明</dt><dd>${summary.answeredCount}</dd></div><div><dt>缺少说明</dt><dd>${summary.missingCount}</dd></div><div><dt>跳过行</dt><dd>${summary.skippedCount}</dd></div></dl>`;
  const sheets = `<ul class="import-sheet-summary">${data.sheets.map(sheet => `<li><strong>${escapeHTML(sheet.name)}</strong><span>${sheet.headerRow === null ? "表头未识别，已跳过" : `${sheet.questionCount} 项问题 · ${sheet.missingCount} 项缺少说明`}${sheet.hidden ? " · 隐藏工作表" : ""}</span></li>`).join("")}</ul>`;
  const reasons = Object.entries(summary.reasons).map(([reason, count]) => `<li>${escapeHTML(reason)}<span>${count} 处</span></li>`).join("");
  const diagnostics = data.diagnostics.map(item => `<li><span>${escapeHTML(item.sheet)}${item.row ? ` · 第 ${item.row} 行` : ""}</span><span>${escapeHTML(item.reason)}</span></li>`).join("");
  return `${counts}${sheets}<details class="import-diagnostics"><summary>校验与跳过原因（${data.diagnostics.length} 处）</summary><ul class="import-reasons">${reasons}</ul><ul class="import-diagnostic-list">${diagnostics}</ul></details>`;
}
function renderUploadMode() {
  const replace = document.querySelector('input[name="upload-mode"]:checked').value === "replace";
  document.getElementById("knowledge-new-name-field").hidden = replace;
  document.getElementById("knowledge-replace-target").hidden = !replace;
  const project = currentKnowledgeProject();
  uploadTarget = project ? { projectId: project.id, expectedVersionId: project.versionId } : null;
  document.getElementById("knowledge-replace-version").textContent = project ? `当前 v${project.version}，确认后保存为 v${project.version + 1}，旧版本保留` : "";
  document.getElementById("confirm-knowledge-upload").disabled = uploadBusy || !uploadDraft || (replace && !project);
}
function setUploadBusy(busy) {
  uploadBusy = busy;
  document.getElementById("choose-knowledge-file").disabled = busy;
  document.getElementById("knowledge-file-input").disabled = busy;
  document.getElementById("knowledge-new-name").disabled = busy;
  document.querySelectorAll('input[name="upload-mode"]').forEach(input => { input.disabled = busy || (input.value === "replace" && !currentKnowledgeProject()); });
  document.querySelectorAll("[data-knowledge-project]").forEach(select => { select.disabled = busy || !currentKnowledgeProject() || (select.id === "supplier-knowledge-project" && !document.getElementById("supplier-record-context").hidden); });
  document.getElementById("delete-knowledge-project").disabled = busy || !currentKnowledgeProject();
  renderUploadMode();
}
async function stageKnowledgeFile(file) {
  if (!file || uploadBusy) return;
  uploadDraft = null;
  document.getElementById("knowledge-upload-preview").hidden = true;
  renderUploadMode();
  if (!/\.xlsx$/i.test(file.name) || file.size > 20 * 1024 * 1024 || !file.size) { showUploadStatus("请选择非空的 .xlsx 文件，大小不超过 20 MB。", true); return; }
  const request = ++uploadRequest;
  setUploadBusy(true);
  document.getElementById("knowledge-upload-filename").textContent = file.name;
  showUploadStatus("正在上传并解析文件…");
  try {
    const data = await knowledgeApi("/api/knowledge/imports", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    if (request !== uploadRequest) return;
    uploadDraft = data;
    if (!document.getElementById("knowledge-new-name").value.trim()) document.getElementById("knowledge-new-name").value = file.name.slice(0, 100);
    document.getElementById("knowledge-upload-preview").innerHTML = detailsMarkup(data);
    document.getElementById("knowledge-upload-preview").hidden = false;
    showUploadStatus(`解析完成：${data.summary.questionCount} 项问题，${data.summary.missingCount} 项缺少说明。确认后保存到知识库。`);
  } catch (error) { showUploadStatus(error.message, true); }
  finally { setUploadBusy(false); }
}
async function commitKnowledgeUpload() {
  if (!uploadDraft || uploadBusy) return;
  const mode = document.querySelector('input[name="upload-mode"]:checked').value;
  const target = uploadTarget;
  const draft = uploadDraft;
  setUploadBusy(true);
  showUploadStatus("正在保存知识库…");
  try {
    const options = { mode, ...(mode === "replace" ? target : {}), ...(mode === "new" && document.getElementById("knowledge-new-name").value.trim() ? { name: document.getElementById("knowledge-new-name").value.trim() } : {}) };
    const data = await knowledgeApi(`/api/knowledge/imports/${draft.importId}/commit`, jsonRequest("POST", options));
    uploadDraft = null;
    document.getElementById("knowledge-upload-preview").hidden = true;
    document.getElementById("knowledge-file-input").value = "";
    document.getElementById("knowledge-new-name").value = "";
    document.getElementById("knowledge-upload-filename").textContent = "知识库文件";
    showUploadStatus(`已保存“${data.project.name}” · v${data.project.version}`);
    knowledgePage = 1;
    document.getElementById("knowledge-search").value = "";
    document.getElementById("knowledge-missing-only").checked = false;
    document.getElementById("knowledge-saved-diagnostics").hidden = true;
    await loadKnowledgeCatalog(data.project.id);
    navigate("knowledge-preview");
    showToast(`知识库已保存 · ${data.project.summary.questionCount} 项问题`);
  } catch (error) { showUploadStatus(error.message, true); }
  finally { setUploadBusy(false); }
}
function renderView(view) {
  const requested = view === "model-training" ? "knowledge-training" : view;
  const current = Object.hasOwn(views, requested) ? requested : "supplier";
  document.querySelectorAll("[data-page]").forEach(page => { page.hidden = page.dataset.page !== current; });
  document.querySelectorAll(".nav-subitem, .nav-list > .nav-item, .knowledge-tabs a").forEach(item => {
    const active = item.dataset.view === current;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
  document.querySelector(".nav-parent").classList.toggle("parent-active", current.startsWith("knowledge-"));
  const parent = document.getElementById("breadcrumb-parent");
  parent.textContent = current === "model-settings" ? "设置" : current.startsWith("knowledge-") ? "知识库" : "供应商自评";
  parent.hidden = current === "supplier";
  parent.nextElementSibling.toggleAttribute("hidden", current === "supplier");
  document.getElementById("breadcrumb-current").textContent = views[current];
  document.title = `${views[current]} · QSA`;
  closeSidebar();
}
function navigate(view) {
  if (!Object.hasOwn(views, view)) return;
  if (location.hash !== `#${view}`) location.hash = view;
  renderView(view);
  window.scrollTo({ top: 0, behavior: "instant" });
}
function focusKnowledgeSheet() {
  [...document.querySelectorAll("[data-knowledge-sheet]")].find(tab => tab.dataset.knowledgeSheet === selectedKnowledgeSheet)?.focus({ preventScroll: true });
}
document.addEventListener("click", event => {
  const view = event.target.closest("[data-view]");
  if (view) { event.preventDefault(); navigate(view.dataset.view); return; }
  const sheet = event.target.closest("[data-sheet]");
  if (sheet) { selectedKnowledgeSheet = sheet.dataset.sheet; knowledgePage = 1; document.getElementById("knowledge-search").value = ""; renderKnowledge(); navigate("knowledge-preview"); return; }
  const knowledgeSheet = event.target.closest("[data-knowledge-sheet]");
  if (knowledgeSheet) { selectedKnowledgeSheet = knowledgeSheet.dataset.knowledgeSheet; knowledgePage = 1; renderKnowledge(); focusKnowledgeSheet(); }
});
document.getElementById("knowledge-search").addEventListener("input", () => { clearTimeout(knowledgeSearchTimer); knowledgeRequest++; knowledgeSearchTimer = setTimeout(() => { knowledgePage = 1; renderKnowledge(); }, 180); });
document.getElementById("knowledge-missing-only").addEventListener("change", () => { knowledgePage = 1; renderKnowledge(); });
document.getElementById("knowledge-prev-page").addEventListener("click", () => { if (knowledgePage > 1) { knowledgePage--; renderKnowledge(); } });
document.getElementById("knowledge-next-page").addEventListener("click", () => { if (knowledgePage * 30 < knowledgeTotal) { knowledgePage++; renderKnowledge(); } });
document.getElementById("knowledge-sheet-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const names = Object.keys(currentKnowledgeProject()?.sheets || {});
  if (!names.length) return;
  const index = names.indexOf(selectedKnowledgeSheet);
  const next = event.key === "Home" ? 0 : event.key === "End" ? names.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + names.length) % names.length;
  selectedKnowledgeSheet = names[next]; knowledgePage = 1; renderKnowledge(); focusKnowledgeSheet();
});
window.addEventListener("hashchange", () => { if (location.hash !== "#main") renderView(location.hash.slice(1)); });
document.querySelectorAll("[data-knowledge-project]").forEach(select => select.addEventListener("change", () => selectKnowledgeProject(select.value)));
document.getElementById("retry-knowledge-load").addEventListener("click", () => loadKnowledgeCatalog());
document.getElementById("delete-knowledge-project").addEventListener("click", () => {
  const project = currentKnowledgeProject();
  if (!project) return;
  pendingKnowledgeDelete = { ...project };
  document.getElementById("delete-knowledge-name").textContent = `${project.name} · v${project.version}`;
  knowledgeDeleteDialog.showModal();
});
document.getElementById("confirm-knowledge-delete").addEventListener("click", async event => {
  if (!pendingKnowledgeDelete) return;
  const project = pendingKnowledgeDelete;
  event.currentTarget.disabled = true;
  try {
    await knowledgeApi(`/api/knowledge/${project.id}`, jsonRequest("DELETE", { expectedVersionId: project.versionId }));
    knowledgeDeleteDialog.close(); knowledgePage = 1;
    document.getElementById("knowledge-saved-diagnostics").hidden = true;
    document.getElementById("knowledge-search").value = "";
    await loadKnowledgeCatalog();
    document.getElementById("undo-knowledge-delete").focus();
  } catch (error) { showToast(error.message); }
  finally { document.getElementById("confirm-knowledge-delete").disabled = false; }
});
knowledgeDeleteDialog.addEventListener("close", () => { pendingKnowledgeDelete = null; });
document.getElementById("undo-knowledge-delete").addEventListener("click", async () => {
  const deleted = knowledgeDeleteHistory[0];
  if (!deleted) return;
  const button = document.getElementById("undo-knowledge-delete"); button.disabled = true;
  try {
    await knowledgeApi(`/api/knowledge/${deleted.id}/restore`, jsonRequest("POST"));
    knowledgePage = 1; await loadKnowledgeCatalog(deleted.id);
    document.getElementById("preview-knowledge-project").focus();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
document.getElementById("show-knowledge-diagnostics").addEventListener("click", async () => {
  const project = currentKnowledgeProject();
  if (!project) return;
  try {
    const [data, history] = await Promise.all([knowledgeApi(`/api/knowledge/${project.id}/diagnostics`), knowledgeApi(`/api/knowledge/${project.id}/versions`)]);
    if (currentKnowledgeProject()?.versionId !== project.versionId) return;
    document.getElementById("knowledge-saved-details").innerHTML = detailsMarkup(data) + `<h3>历史版本</h3><ul class="import-sheet-summary">${history.versions.map(version => `<li><strong>v${version.number}</strong><span>${version.summary.questionCount} 项问题 · ${escapeHTML(new Date(version.createdAt).toLocaleString("zh-CN"))}</span></li>`).join("")}</ul>`;
    const details = document.getElementById("knowledge-saved-diagnostics"); details.hidden = false; details.open = true;
    details.scrollIntoView({ block: "nearest" });
  } catch (error) { showToast(error.message); }
});
document.getElementById("choose-knowledge-file").addEventListener("click", () => {
  const input = document.getElementById("knowledge-file-input");
  input.value = "";
  input.click();
});
document.getElementById("knowledge-file-input").addEventListener("change", event => stageKnowledgeFile(event.target.files[0]));
document.getElementById("confirm-knowledge-upload").addEventListener("click", commitKnowledgeUpload);
document.querySelectorAll('input[name="upload-mode"]').forEach(input => input.addEventListener("change", renderUploadMode));
const knowledgeDropzone = document.getElementById("knowledge-dropzone");
for (const name of ["dragenter", "dragover"]) knowledgeDropzone.addEventListener(name, event => { event.preventDefault(); knowledgeDropzone.classList.add("drag-over"); });
for (const name of ["dragleave", "drop"]) knowledgeDropzone.addEventListener(name, event => { event.preventDefault(); knowledgeDropzone.classList.remove("drag-over"); });
knowledgeDropzone.addEventListener("drop", event => { if (event.dataTransfer.files.length !== 1) { showUploadStatus("请每次上传一个知识库文件。", true); return; } stageKnowledgeFile(event.dataTransfer.files[0]); });
renderKnowledgeProjects();
renderView(location.hash.slice(1));
loadKnowledgeCatalog();
