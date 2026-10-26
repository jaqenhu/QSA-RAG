"use strict";
let trainingState = null;
let trainingStateRequest = 0;
let trainingPollTimer;
let trainingSubmitBusy = false;
let retrievalBusy = false;
let retrievalRequest = 0;
let trainingRenderedVersion = null;
let loadedSettingsKey = null;
let retrievalSaveBusy = false;
const retrievalControlNames = { retrieval: ['training-retrieval','retrieval-method'], fusion: ['training-fusion','retrieval-fusion'], rrfK: ['training-rrf-k','retrieval-rrf-k'], vectorTopK: ['training-vector-top-k','retrieval-vector-top-k'], bm25TopK: ['training-bm25-top-k','retrieval-bm25-top-k'], rerankCandidateLimit: ['training-rerank-candidates','retrieval-rerank-candidates'], rerankTopN: ['training-rerank-top-n','retrieval-rerank-top-n'], rerankThreshold: ['training-rerank-threshold','retrieval-rerank-threshold'], topK: ['training-top-k','retrieval-top-k'], threshold: ['training-threshold','retrieval-score-threshold'], rerankModelId: ['training-rerank','retrieval-rerank'] };
function readRetrievalControls(group) {
  return { retrievalVersion: 2, ...Object.fromEntries(Object.entries(retrievalControlNames).map(([key, ids]) => {
    const element = document.getElementById(ids[group]);
    return [key, element.type === 'number' ? Number(element.value) : element.value || null];
  })) };
}
function fillRetrievalControls(config) {
  for (const [key, ids] of Object.entries(retrievalControlNames)) for (const id of ids) if (config[key] !== undefined) document.getElementById(id).value = config[key] ?? '';
  updateRetrievalControls(0); updateRetrievalControls(1);
}
function updateRetrievalControls(group) {
  const value = readRetrievalControls(group), hybrid = value.retrieval === 'hybrid', rerank = Boolean(value.rerankModelId), rrf = hybrid && value.fusion === 'rrf';
  const visible = { fusion: hybrid, rrfK: rrf, vectorTopK: value.retrieval !== 'keyword', bm25TopK: value.retrieval !== 'vector', rerankCandidateLimit: rerank, rerankTopN: rerank, rerankThreshold: rerank, topK: !rerank, threshold: !rerank && !rrf };
  for (const [key, show] of Object.entries(visible)) { const element = document.getElementById(retrievalControlNames[key][group]); element.closest('label').hidden = !show; element.disabled = !show; }
  document.getElementById(group ? 'retrieval-parameter-note' : 'training-parameter-note').textContent = rerank ? '重排后按得分阈值筛选，最多保留 Top N 条；分数不代表可信度。' : rrf ? 'RRF 按排名融合，不使用相似度阈值。' : hybrid ? '加权融合：向量 65%，BM25 35%。' : '';
}
const trainingStatusNames = { running: "训练中", success: "训练完成", failed: "训练失败", cancelled: "已取消" };

function trainingMessage(message = "", error = false) {
  const banner = document.getElementById("training-message"); banner.hidden = !message;
  banner.querySelector("span").textContent = message; banner.classList.toggle("is-error", error);
}
function renderTrainingModels() {
  for (const { id, type, empty } of [{ id: "training-embedding", type: "embedding", empty: "请选择已测试的向量模型" }, { id: "training-rerank", type: "rerank", empty: "不使用重排模型" }, { id: "retrieval-rerank", type: "rerank", empty: "不使用重排模型" }]) {
    const select = document.getElementById(id), previous = select.value;
    const candidates = configuredModels.filter(model => model.type === type);
    select.innerHTML = `<option value="">${empty}</option>` + candidates.map(model => `<option value="${model.id}">${escapeHTML(model.name)} · ${escapeHTML(model.modelId)}${model.lastTest?.success ? "" : "（未通过测试）"}</option>`).join("");
    if (candidates.some(model => model.id === previous)) select.value = previous;
    else if (type === "embedding") select.value = candidates.find(model => model.isDefault)?.id || candidates[0]?.id || "";
  }
  updateTrainingSummary();
  if (trainingState?.retrievalSettings) fillRetrievalControls(trainingState.retrievalSettings.config);
}
function renderTrainingKnowledge() {
  const project = currentKnowledgeProject();
  const sheets = Object.entries(project?.sheets || {});
  const same = trainingRenderedVersion === project?.versionId;
  const checked = new Set([...document.querySelectorAll("#training-sheets input:checked")].map(input => input.value));
  trainingRenderedVersion = project?.versionId || null;
  const answered = project?.summary.answeredCount || 0;
  document.getElementById("linked-knowledge-summary").textContent = `${sheets.length} 张可用表 · ${answered.toLocaleString("zh-CN")} 条有说明 · ${project?.summary.missingCount || 0} 条缺少说明`;
  document.getElementById("training-sheets").innerHTML = '<legend>工作表范围</legend>' + sheets.map(([name, count]) => {
    const usable = project.sheetDetails.find(sheet => sheet.name === name)?.answeredCount || 0;
    return `<label><input type="checkbox" value="${escapeHTML(name)}" data-sheet-count="${usable}"${!same || checked.has(name) ? " checked" : ""}>${escapeHTML(name)}<span>${usable} / ${count}</span></label>`;
  }).join("");
  updateTrainingSummary();
}
function renderTrainingProjectOptions() {
  const select = document.getElementById("training-knowledge");
  select.innerHTML = uploadedKnowledgeBases.map(project => `<option value="${project.id}">${escapeHTML(project.name)}</option>`).join("") || '<option value="">暂无知识库项目</option>';
  select.value = selectedKnowledgeProjectId; select.disabled = !uploadedKnowledgeBases.length;
  renderTrainingKnowledge();
  trainingState = null; retrievalRequest++; loadedSettingsKey = null;
  document.getElementById("retrieval-results").innerHTML = "";
  document.getElementById("retrieval-status").textContent = "";
  renderTrainingState(); refreshTrainingState();
}
function updateTrainingSummary() {
  const checked = [...document.querySelectorAll("#training-sheets input:checked")];
  const total = checked.reduce((n, input) => n + Number(input.dataset.sheetCount), 0);
  const model = configuredModels.find(item => item.id === document.getElementById("training-embedding").value);
  const running = trainingState?.job?.status === "running";
  const incremental = document.querySelector('#training-update option[value="incremental"]');
  incremental.disabled = !trainingState?.index || trainingState.index.config.modelFingerprint !== model?.fingerprint || trainingState.index.modelId !== model?.id;
  if (incremental.disabled && document.getElementById('training-update').value === 'incremental') document.getElementById('training-update').value = 'rebuild';
  const reason = !currentKnowledgeProject() ? "请先上传知识库" : !checked.length ? "请选择至少一张工作表" : !total ? "所选工作表没有可用自评说明" : !model ? "请先配置向量模型" : !model.lastTest?.success ? "请先测试向量模型连接" : "";
  document.getElementById("training-selection-summary").textContent = reason || `已选 ${checked.length} 张表 · ${total.toLocaleString("zh-CN")} 条有说明`;
  const start = document.getElementById("start-knowledge-training");
  start.disabled = Boolean(reason) || running || trainingSubmitBusy;
  start.textContent = trainingSubmitBusy ? "正在开始…" : running ? "训练中…" : "开始训练";
  start.title = reason;
  document.getElementById('save-retrieval-settings').disabled = !currentKnowledgeProject() || retrievalSaveBusy || !trainingState?.retrievalSettings;
  if (!trainingState?.job) {
    document.getElementById("training-task-total").textContent = `${total.toLocaleString("zh-CN")} 条`;
    document.getElementById("training-task-model").textContent = model?.modelId || "—";
  }
}
function renderTrainingState() {
  const job = trainingState?.job;
  const ready = trainingState?.ready;
  const stale = trainingState?.staleReason;
  const current = currentKnowledgeProject();
  const settingsKey = trainingState?.retrievalSettings ? `${current?.id}:${trainingState.retrievalSettings.revision}` : null;
  if (settingsKey && settingsKey !== loadedSettingsKey) {
    fillRetrievalControls(trainingState.retrievalSettings.config); loadedSettingsKey = settingsKey;
    document.getElementById('retrieval-save-status').textContent = '保存后用于新自评，无需重建向量';
  }
  document.getElementById("training-overall-status").textContent = ready ? "索引可用" : stale ? "需重建索引" : job?.status === "running" ? "训练中" : "未训练";
  document.getElementById("training-task-status").textContent = job ? `${trainingStatusNames[job.status]}${job.versionId !== current?.versionId ? " · 旧版本" : ""}` : "未开始";
  document.getElementById("training-task-start").textContent = job ? new Date(job.createdAt).toLocaleString("zh-CN") : "—";
  if (job) { document.getElementById("training-task-total").textContent = `${job.total.toLocaleString("zh-CN")} 条`; document.getElementById("training-task-model").textContent = job.model.modelId; }
  const progress = document.getElementById("training-progress");
  progress.hidden = !job; progress.max = job?.total || 1; progress.value = job?.processed || 0;
  document.getElementById("training-progress-text").textContent = job ? `${job.processed} / ${job.total} 条已处理${job.config.changes ? ` · 复用 ${job.config.changes.reused} · 计算 ${job.config.changes.computed} · 移除 ${job.config.changes.removed}` : ''}` : "";
  document.querySelectorAll(".training-stages li").forEach((item, index) => {
    item.querySelector("small").textContent = !job ? "未开始" : job.status === "success" || index < job.stage ? "已完成" : index > job.stage ? "未开始" : job.status === "running" ? "进行中" : job.status === "cancelled" ? "已取消" : "失败";
    item.classList.toggle("stage-complete", Boolean(job && (job.status === "success" || index < job.stage)));
    item.classList.toggle("stage-active", job?.status === "running" && index === job.stage);
  });
  const jobError = document.getElementById("training-job-error"); jobError.hidden = !job?.error; jobError.textContent = job?.error || "";
  const cancel = document.getElementById("cancel-knowledge-training"); cancel.hidden = job?.status !== "running"; cancel.disabled = false;
  document.getElementById("run-retrieval").disabled = !ready || retrievalBusy;
  document.getElementById("retrieval-index-summary").textContent = ready ? `${trainingState.index.count} 条问答 · ${trainingState.index.dimensions} 维 · v${current.version}` : stale || "尚未建立索引";
  if (!document.getElementById("supplier-record-context").hidden) { /* Keep explicit example-history metadata. */ }
  else if (current) document.getElementById("supplier-knowledge-total").textContent = `${current.summary.answeredCount.toLocaleString("zh-CN")} 条有说明 · ${ready ? "索引可用" : stale ? "需重建索引" : "未建立索引"}`;
  if (stale) trainingMessage(stale, true);
  updateTrainingSummary();
}
async function refreshTrainingState() {
  clearTimeout(trainingPollTimer);
  const request = ++trainingStateRequest;
  const project = currentKnowledgeProject();
  if (!project) { trainingState = null; renderTrainingState(); return; }
  try {
    const data = await knowledgeApi(`/api/knowledge/${project.id}/training`);
    if (request !== trainingStateRequest || currentKnowledgeProject()?.versionId !== project.versionId) return;
    trainingState = data; trainingMessage(); renderTrainingState();
    if (data.job?.status === "running") trainingPollTimer = setTimeout(refreshTrainingState, 1200);
  } catch (error) { if (request === trainingStateRequest) trainingMessage(error.message, true); }
}
document.getElementById("training-form").addEventListener("submit", async event => {
  event.preventDefault(); if (trainingSubmitBusy || document.getElementById("start-knowledge-training").disabled) return;
  const project = currentKnowledgeProject();
  const input = { ...readRetrievalControls(0), retrievalRevision: trainingState?.retrievalSettings?.revision, name: document.getElementById("training-name").value.trim(), expectedVersionId: project.versionId, modelId: document.getElementById("training-embedding").value, sheets: [...document.querySelectorAll("#training-sheets input:checked")].map(element => element.value), updateMode: document.getElementById("training-update").value };
  trainingSubmitBusy = true; updateTrainingSummary(); trainingMessage("正在开始训练…");
  try {
    const data = await knowledgeApi(`/api/knowledge/${project.id}/training`, jsonRequest("POST", input));
    if (currentKnowledgeProject()?.id !== project.id) return;
    trainingState = { ...trainingState, job: data.job }; renderTrainingState();
    await refreshTrainingState();
  } catch (error) { trainingMessage(error.message, true); }
  finally { trainingSubmitBusy = false; updateTrainingSummary(); }
});
document.getElementById("cancel-knowledge-training").addEventListener("click", async event => {
  const job = trainingState?.job; if (!job || job.status !== "running") return;
  event.currentTarget.disabled = true;
  try { await knowledgeApi(`/api/training/${job.id}/cancel`, jsonRequest("POST")); trainingMessage("正在取消训练…"); await refreshTrainingState(); }
  catch (error) { trainingMessage(error.message, true); document.getElementById("cancel-knowledge-training").disabled = false; }
});
document.getElementById("retrieval-form").addEventListener("submit", async event => {
  event.preventDefault(); if (retrievalBusy || !trainingState?.ready) return;
  const project = currentKnowledgeProject(); const request = ++retrievalRequest;
  const status = document.getElementById("retrieval-status");
  retrievalBusy = true; document.getElementById("run-retrieval").disabled = true; status.textContent = "正在检索…"; status.classList.remove("is-error");
  document.getElementById("retrieval-results").innerHTML = "";
  try {
    const input = { ...readRetrievalControls(1), query: document.getElementById("retrieval-query").value.trim() };
    const data = await knowledgeApi(`/api/knowledge/${project.id}/retrieve`, jsonRequest("POST", input));
    if (request !== retrievalRequest || currentKnowledgeProject()?.versionId !== project.versionId) return;
    status.textContent = data.results.length ? `${data.results.length} 条匹配 · ${data.reranked ? `已重排 ${data.candidateCount} 条候选` : '未使用重排'}` : "没有达到当前阈值的记录，可调整阈值或补充知识库。";
    document.getElementById("retrieval-results").innerHTML = data.results.map((row, index) => `<article class="retrieval-result"><div class="retrieval-result-heading"><strong>${index + 1}. ${escapeHTML(row.sheet)} · 第 ${row.line} 行</strong><span>${data.scoreType === 'rrf' ? 'RRF 分数 ' + row.score.toFixed(6) : '得分 ' + row.score.toFixed(3)}</span></div><div class="retrieval-result-source">${escapeHTML(project.name)} · v${project.version} · ${escapeHTML(row.questionCell)} / ${escapeHTML(row.answerCell)}${row.chapter ? ` · ${escapeHTML(row.chapter)}` : ""}</div><h3>${escapeHTML(row.question)}</h3><blockquote>${escapeHTML(row.answer)}</blockquote><span class="field-label">${data.reranked ? `重排 ${row.rerankScore.toFixed(3)} · ` : ""}向量 ${row.vectorScore.toFixed(3)} · BM25 ${row.keywordScore.toFixed(3)}</span></article>`).join("");
  } catch (error) { if (request === retrievalRequest) { status.textContent = error.message; status.classList.add("is-error"); } }
  finally { retrievalBusy = false; document.getElementById("run-retrieval").disabled = !trainingState?.ready; }
});
document.addEventListener("knowledge-projects-change", renderTrainingProjectOptions);
document.addEventListener("models-change", () => { renderTrainingModels(); refreshTrainingState(); });
document.getElementById("training-knowledge").addEventListener("change", event => selectKnowledgeProject(event.target.value));
document.getElementById("training-sheets").addEventListener("change", updateTrainingSummary);
document.getElementById("training-embedding").addEventListener("change", updateTrainingSummary);
document.getElementById("reload-training").addEventListener("click", refreshTrainingState);
for (const group of [0,1]) for (const ids of Object.values(retrievalControlNames)) document.getElementById(ids[group]).addEventListener('change', () => { updateRetrievalControls(group); if (!group) document.getElementById('retrieval-save-status').textContent = '设置已修改，保存后用于新自评'; });
document.getElementById('save-retrieval-settings').addEventListener('click', async () => {
  const project = currentKnowledgeProject(); if (!project || retrievalSaveBusy) return;
  const elements = Object.values(retrievalControlNames).map(ids => document.getElementById(ids[0]));
  if (elements.some(element => !element.disabled && !element.reportValidity())) return;
  const config = readRetrievalControls(0), expectedRevision = trainingState.retrievalSettings.revision;
  retrievalSaveBusy = true; updateTrainingSummary();
  const status = document.getElementById('retrieval-save-status'); status.textContent = '正在保存…';
  try {
    const saved = await knowledgeApi(`/api/knowledge/${project.id}/retrieval-settings`, jsonRequest('PUT', { ...config, expectedVersionId: project.versionId, expectedRevision }));
    if (currentKnowledgeProject()?.id !== project.id) return;
    trainingState.retrievalSettings = saved; loadedSettingsKey = `${project.id}:${saved.revision}`; fillRetrievalControls(saved.config); status.textContent = '已保存，将用于新自评；无需重建向量';
  } catch (error) { status.textContent = error.message; }
  finally { retrievalSaveBusy = false; updateTrainingSummary(); }
});
updateRetrievalControls(0); updateRetrievalControls(1);
window.addEventListener("hashchange", () => { if (location.hash === "#knowledge-training") refreshTrainingState(); });
renderTrainingModels(); renderTrainingProjectOptions();
