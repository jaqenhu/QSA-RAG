"use strict";

let assessmentInput = null;
let assessmentTask = null;
let assessmentReady = false;
let assessmentBusy = false;
let assessmentPoll;
let assessmentStateRequest = 0;
let assessmentNotice = "";
let assessmentHistoryId = "";
let assessmentLoadRequest = 0;
let assessmentRetrievalConfig = null;
const assessmentStatus = document.getElementById("assessment-status");
const assessmentStages = { preparing: "准备任务", processing: "逐题处理", retrieving: "检索依据", generating: "生成自评", validating: "校验并保存", summarizing: "汇总结果", complete: "生成结束" };
const assessmentProgressWrap = document.getElementById("assessment-progress-wrap");
const assessmentProgressTooltip = document.getElementById("assessment-progress-tooltip");
let assessmentTooltipTimer;
function positionAssessmentTooltip() {
  if (assessmentProgressTooltip.hidden || assessmentProgressWrap.hidden) return;
  const rect = assessmentProgressWrap.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) { assessmentProgressTooltip.hidden = true; return; }
  const width = Math.min(rect.width, 560, innerWidth - 32);
  assessmentProgressTooltip.style.width = `${width}px`;
  assessmentProgressTooltip.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - width - 16))}px`;
  const height = assessmentProgressTooltip.offsetHeight;
  const below = rect.bottom + 8;
  assessmentProgressTooltip.style.top = `${Math.max(12, below + height <= innerHeight - 12 ? below : rect.top - height - 8)}px`;
}
function showAssessmentTooltip() { clearTimeout(assessmentTooltipTimer); assessmentProgressTooltip.hidden = false; positionAssessmentTooltip(); }

function renderAssessmentProgress(run) {
  assessmentProgressWrap.hidden = !run;
  const progress = document.getElementById("assessment-progress");
  progress.max = run?.total || 1; progress.value = run?.processed || 0;
  if (!run) {
    clearTimeout(assessmentTooltipTimer);
    assessmentProgressTooltip.hidden = true;
    document.getElementById("assessment-progress-label").textContent = "";
    document.getElementById("assessment-progress-step").textContent = "";
    document.getElementById("assessment-progress-items").innerHTML = "";
    progress.removeAttribute("aria-valuetext");
    return;
  }
  const state = run.progress || { stage: run.status === "running" ? "processing" : "complete", items: [] };
  const percent = Math.floor(run.processed / Math.max(1, run.total) * 100);
  const label = `${run.processed}/${run.total} 项 · ${percent}%`;
  document.getElementById("assessment-progress-label").textContent = label;
  const step = state.items.length ? [...new Set(state.items.map(item => assessmentStages[item.stage]))].join("、") : assessmentStages[state.stage];
  document.getElementById("assessment-progress-step").textContent = `当前步骤：${step}`;
  document.getElementById("assessment-progress-items").innerHTML = state.items.map(item => `<li>${escapeHTML(item.sheet)} · 第 ${item.line} 行 · ${escapeHTML(item.questionCell)}：${assessmentStages[item.stage]}</li>`).join("");
  progress.setAttribute("aria-valuetext", `${label}，当前步骤：${step}`);
  positionAssessmentTooltip();
}
function renderAssessmentOverview(run) {
  const overview = document.getElementById("assessment-overview");
  overview.hidden = !run || run.status === "running";
  const failures = run?.results.filter(row => row.status === "failed") || [];
  const successful = run?.results.filter(row => ["direct", "partial", "missing"].includes(row.status)).length || 0;
  document.getElementById("assessment-overview-counts").textContent = run ? `成功 ${successful} 项，失败 ${failures.length} 项` : "";
  const scope = document.getElementById("assessment-overview-scope");
  scope.hidden = !run || run.total === run.snapshot.input.questionCount;
  scope.textContent = run ? `本次生成 ${run.total}/${run.snapshot.input.questionCount} 项` : "";
  document.getElementById("assessment-failures").innerHTML = failures.map((row, index) => {
    const reason = row.error || row.answer?.replace(/^生成失败[：:]\s*/, "") || run.error || "未返回有效结果，请重试。";
    return `<li><strong>失败项 ${index + 1}：</strong><div><span class="assessment-failure-location">位置：${escapeHTML(row.sheet)} · 第 ${row.line} 行 · ${escapeHTML(row.questionCell)} / ${escapeHTML(row.answerCell)}</span><p>失败原因：${escapeHTML(reason)}</p></div></li>`;
  }).join("");
}
assessmentProgressWrap.addEventListener("mouseenter", showAssessmentTooltip);
assessmentProgressWrap.addEventListener("mouseleave", () => { if (!assessmentProgressWrap.contains(document.activeElement)) assessmentTooltipTimer = setTimeout(() => { assessmentProgressTooltip.hidden = true; }, 150); });
assessmentProgressTooltip.addEventListener("mouseenter", () => clearTimeout(assessmentTooltipTimer));
assessmentProgressWrap.addEventListener("focusin", showAssessmentTooltip);
assessmentProgressWrap.addEventListener("focusout", event => { if (!assessmentProgressWrap.contains(event.relatedTarget)) assessmentProgressTooltip.hidden = true; });
assessmentProgressWrap.addEventListener("keydown", event => { if (event.key === "Escape") assessmentProgressTooltip.hidden = true; });
assessmentProgressWrap.addEventListener("click", showAssessmentTooltip);
document.addEventListener("pointerdown", event => { if (!assessmentProgressWrap.contains(event.target)) assessmentProgressTooltip.hidden = true; });
window.addEventListener("resize", positionAssessmentTooltip);
window.addEventListener("scroll", positionAssessmentTooltip, true);

function renderAssessmentModels() {
  const select = document.getElementById("assessment-model");
  const old = select.value;
  const models = configuredModels.filter(model => model.type === "generation");
  select.innerHTML = models.map(model => `<option value="${model.id}">${escapeHTML(model.name)} · ${escapeHTML(model.modelId)}</option>`).join("") || '<option value="">请先配置生成模型</option>';
  select.value = models.some(model => model.id === old) ? old : models.find(model => model.isDefault)?.id || models[0]?.id || "";
}
function activeAssessmentTask() { return assessmentTask?.inputId === assessmentInput?.id ? assessmentTask : null; }
function renderAssessment() {
  const historical = Boolean(assessmentHistoryId);
  document.getElementById("supplier-record-context").hidden = !historical;
  if (historical) {
    document.getElementById("supplier-record-label").textContent = `历史任务 · ${assessmentTask?.id || assessmentHistoryId}`;
    const selector = document.getElementById("supplier-knowledge-project");
    selector.innerHTML = `<option>${escapeHTML(assessmentTask?.snapshot.knowledge.name || "")} · v${assessmentTask?.snapshot.knowledge.version || ""}</option>`;
    selector.disabled = true;
    document.getElementById("supplier-knowledge-total").textContent = "当次知识库快照";
    document.getElementById("supplier-knowledge-sheets").innerHTML = "";
  }
  const run = activeAssessmentTask();
  const running = run?.status === "running";
  const model = configuredModels.find(model => model.id === document.getElementById("assessment-model").value);
  const project = currentKnowledgeProject();
  const reason = assessmentBusy ? "正在处理文件或任务…" : running ? "正在生成自评说明" : !assessmentInput ? "请先选择待填表" : !project ? "请先上传知识库" : !assessmentReady ? "请先完成当前知识库训练" : !model?.lastTest?.success ? "请选择已通过连接测试的生成模型" : "";
  const start = document.getElementById("start-supplier-assessment");
  start.disabled = historical || Boolean(reason); start.title = historical ? "历史任务只读，可新建自评或重试失败项" : reason;
  document.getElementById("assessment-model").disabled = historical || assessmentBusy || running;
  document.getElementById("assessment-scope").disabled = historical || assessmentBusy || running;
  document.getElementById("choose-assessment-file").disabled = historical || assessmentBusy || running;
  if (historical && assessmentTask) {
    document.getElementById("assessment-model").innerHTML = `<option>${escapeHTML(assessmentTask.snapshot.model.name)} · ${escapeHTML(assessmentTask.snapshot.model.modelId)}</option>`;
  }
  document.getElementById("cancel-assessment").hidden = !running;
  document.getElementById("retry-assessment").hidden = !run || running || !run.counts.failed;
  document.getElementById("retry-assessment").disabled = assessmentBusy;
  document.getElementById("assessment-input-name").textContent = assessmentInput?.name || "尚未选择待填表";
  document.getElementById("assessment-input-summary").textContent = assessmentInput ? `${assessmentInput.sheets.filter(sheet => sheet.questionCount).map(sheet => sheet.name).join("、")} · ${assessmentInput.records.length} 项问题 · ${assessmentInput.summary.mergeCount} 组合并待拆开` : "请选择 .xlsx 待填表";
  document.getElementById("supplier-review-section").hidden = !assessmentInput;
  document.getElementById("supplier-generation-empty").hidden = Boolean(assessmentInput);
  document.querySelector(".workflow").hidden = !assessmentInput;
  document.querySelectorAll(".workflow li").forEach((element, index) => {
    const current = run ? run.status === "running" ? 1 : 2 : 0;
    element.classList.toggle("workflow-complete", index < current);
    element.classList.toggle("workflow-current", index === current);
    if (index === current) element.setAttribute("aria-current", "step"); else element.removeAttribute("aria-current");
    element.querySelector(".step-index").innerHTML = index < current ? icon("check") : String(index + 1);
  });
  assessmentStatus.textContent = assessmentNotice || (run ? `${run.status === "running" ? "生成中" : run.status === "success" ? "生成完成" : run.status === "partial_success" ? "生成成功，部分需审核" : "生成失败"} · ${run.processed}/${run.total} 项 · ${run.snapshot.knowledge.name} v${run.snapshot.knowledge.version}${run.error ? " · " + run.error : ""}` : reason || `已就绪 · ${assessmentInput.records.length} 项问题`);
  const retrieval = run ? run.snapshot.retrieval : assessmentRetrievalConfig;
  const retrievalLabel = document.getElementById('assessment-retrieval-settings');
  retrievalLabel.hidden = !retrieval && !run;
  retrievalLabel.textContent = retrieval ? `检索设置：${retrieval.retrieval === 'hybrid' ? `混合检索 · ${retrieval.fusion === 'rrf' ? `RRF k=${retrieval.rrfK}` : '加权融合'}` : retrieval.retrieval === 'vector' ? '向量检索' : '关键词检索'} · 向量 ${retrieval.vectorTopK} / BM25 ${retrieval.bm25TopK} · ${retrieval.rerankModelId ? `重排候选最多 ${retrieval.rerankCandidateLimit} 条 → 返回最多 ${retrieval.rerankTopN} 条 · 阈值 ${retrieval.rerankThreshold}` : `不使用重排 · 返回最多 ${retrieval.topK} 条`}` : run ? '历史检索设置：混合检索 · 加权融合 · 返回最多 8 条 · 阈值 0.5' : '';
  if (retrieval?.retrievalVersion === 1) retrievalLabel.textContent = `历史检索设置：混合检索 · 加权融合 · 返回最多 ${retrieval.topK} 条 · 阈值 ${retrieval.threshold}`;
  renderAssessmentProgress(run); renderAssessmentOverview(run);
  const originalRows = run ? run.results : assessmentInput?.records || [];
  rows = originalRows.map(row => ({ ...row, status: row.status && run ? row.status : "pending", answer: run ? row.answer : "", gap: row.gap || "", coverage: row.coverage || [], sources: (run ? row.sources : []).map(source => ({ ...source, lines: [source.line], highlights: source.quotes || [], knowledgeName: run.snapshot.knowledge.name, version: run.snapshot.knowledge.version })) }));
  if (!rows.some(row => row.id === selectedId)) selectedId = rows[0]?.id || "";
  renderRows();
  document.getElementById("assessment-result-count").textContent = run ? `${run.processed}/${run.total} 项` : `${rows.length} 项待生成`;
  document.getElementById("assessment-total-count").textContent = `${assessmentInput?.records.length || 0} 项输入问题`;
  document.getElementById("export-assessment").disabled = !run || running || assessmentBusy;
  document.getElementById("assessment-input-details").hidden = !assessmentInput;
  if (assessmentInput) {
    document.getElementById("assessment-input-info").innerHTML = `<ul class="import-sheet-summary">${assessmentInput.sheets.map(sheet => `<li><strong>${escapeHTML(sheet.name)}</strong><span>${sheet.questionCount} 项问题 · 来源列 ${escapeHTML(sheet.sourceColumn)}</span></li>`).join("")}</ul><p>${assessmentInput.summary.mergeCount} 组答案合并，涉及 ${assessmentInput.summary.mergedQuestionCount} 项问题；导出副本逐题填写。</p>${assessmentInput.answerMerges.length ? `<p>${assessmentInput.answerMerges.map(item => `${escapeHTML(item.sheet)} ${escapeHTML(item.range)}`).join("、")}</p>` : ""}<div class="assessment-input-scroll"><table class="knowledge-table"><thead><tr><th>位置</th><th>检查内容</th><th>写入位置</th></tr></thead><tbody>${assessmentInput.records.map(row => `<tr><td>${escapeHTML(row.sheet)} · 第 ${row.line} 行</td><td>${escapeHTML(row.question)}</td><td>${escapeHTML(row.answerCell)}</td></tr>`).join("")}</tbody></table></div>`;
  } else document.getElementById("assessment-input-info").innerHTML = "";
}
async function refreshAssessmentReadiness() {
  const request = ++assessmentStateRequest;
  const project = currentKnowledgeProject(); assessmentReady = false; assessmentRetrievalConfig = null; renderAssessment();
  if (!project) return;
  try {
    const state = await knowledgeApi(`/api/knowledge/${project.id}/training`);
    if (request !== assessmentStateRequest) return;
    assessmentReady = state.ready; assessmentRetrievalConfig = state.retrievalSettings?.config || null; renderAssessment();
  } catch (error) { if (request === assessmentStateRequest) { assessmentNotice = error.message; renderAssessment(); } }
}
async function pollAssessment() {
  clearTimeout(assessmentPoll);
  const taskId = assessmentTask?.id;
  const inputId = assessmentInput?.id;
  const request = assessmentLoadRequest;
  if (!taskId || assessmentTask.inputId !== inputId) return;
  const isCurrent = () => request === assessmentLoadRequest && assessmentTask?.id === taskId && assessmentInput?.id === inputId;
  try {
    const { task } = await knowledgeApi(`/api/assessment/tasks/${taskId}`);
    if (!isCurrent()) return;
    assessmentTask = task; assessmentNotice = ""; renderAssessment();
    if (task.status !== "running") document.dispatchEvent(new CustomEvent("assessment-tasks-change"));
    if (task.status === "running") assessmentPoll = setTimeout(pollAssessment, 1800);
  } catch (error) { if (isCurrent()) { assessmentNotice = error.message; renderAssessment(); assessmentPoll = setTimeout(pollAssessment, 5000); } }
}
async function loadAssessment() {
  clearTimeout(assessmentPoll);
  const request = ++assessmentLoadRequest;
  const match = location.hash.match(/^#supplier\/([a-f0-9-]+)$/);
  try {
    let data;
    if (match) {
      const { task } = await knowledgeApi(`/api/assessment/tasks/${match[1]}`);
      const { input } = await knowledgeApi(`/api/assessment/inputs/${task.inputId}`);
      data = { task, input };
    } else data = await knowledgeApi("/api/assessment/current");
    if (request !== assessmentLoadRequest) return;
    assessmentHistoryId = match?.[1] || "";
    assessmentInput = data.input; assessmentTask = data.task; assessmentNotice = "";
    renderAssessmentModels(); renderAssessment();
    if (assessmentTask?.status === "running") pollAssessment();
  } catch (error) {
    if (request !== assessmentLoadRequest) return;
    if (match) { assessmentTask = null; assessmentInput = null; assessmentHistoryId = match[1]; }
    assessmentNotice = error.message; renderAssessment();
  }
}
document.getElementById("choose-assessment-file").addEventListener("click", () => { const input = document.getElementById("assessment-file-input"); input.value = ""; input.click(); });
document.getElementById("assessment-file-input").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file || assessmentBusy || assessmentHistoryId || activeAssessmentTask()?.status === "running") return;
  if (!/\.xlsx$/i.test(file.name) || file.size > 20 * 1024 * 1024) { showToast("请选择不超过 20 MB 的 .xlsx 文件。"); return; }
  const request = ++assessmentLoadRequest;
  clearTimeout(assessmentPoll);
  assessmentBusy = true; assessmentNotice = "正在解析待填表…"; renderAssessment();
  try {
    const response = await fetch("/api/assessment/inputs", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    if (request !== assessmentLoadRequest) return;
    assessmentInput = data.input; assessmentTask = null; selectedId = ""; activeFilter = "all"; search.value = "";
    document.querySelector('[data-filter="all"]').click();
    assessmentNotice = `已保存待填表 · ${data.input.records.length} 项问题`;
  } catch (error) { if (request === assessmentLoadRequest) assessmentNotice = error.message; }
  finally { assessmentBusy = false; renderAssessment(); }
});
document.getElementById("start-supplier-assessment").addEventListener("click", async () => {
  if (assessmentBusy || document.getElementById("start-supplier-assessment").disabled) return;
  const project = currentKnowledgeProject();
  const scope = document.getElementById("assessment-scope").value;
  const request = ++assessmentLoadRequest;
  clearTimeout(assessmentPoll);
  assessmentBusy = true; assessmentNotice = "正在创建自评任务…"; renderAssessment();
  try {
    const data = await knowledgeApi("/api/assessment/tasks", jsonRequest("POST", { inputId: assessmentInput.id, projectId: project.id, expectedVersionId: project.versionId, modelId: document.getElementById("assessment-model").value, ...(scope === "all" ? {} : { questionIds: assessmentInput.records.slice(0, Number(scope)).map(row => row.id) }) }));
    if (request !== assessmentLoadRequest) return;
    assessmentTask = data.task; assessmentNotice = ""; activeFilter = "all"; search.value = "";
    document.querySelector('[data-filter="all"]').click(); pollAssessment();
  } catch (error) { if (request === assessmentLoadRequest) assessmentNotice = error.message; }
  finally { assessmentBusy = false; renderAssessment(); }
});
document.getElementById("cancel-assessment").addEventListener("click", async () => {
  try { await knowledgeApi(`/api/assessment/tasks/${assessmentTask.id}/cancel`, jsonRequest("POST", {})); assessmentNotice = "正在停止；已完成结果将保留。"; renderAssessment(); }
  catch (error) { showToast(error.message); }
});
document.getElementById("retry-assessment").addEventListener("click", async () => {
  if (assessmentBusy) return;
  assessmentBusy = true; renderAssessment();
  try { const data = await knowledgeApi(`/api/assessment/tasks/${assessmentTask.id}/retry`, jsonRequest("POST", {})); assessmentTask = data.task; assessmentHistoryId = ""; location.hash = "supplier"; assessmentNotice = ""; pollAssessment(); }
  catch (error) { assessmentNotice = error.message; }
  finally { assessmentBusy = false; renderAssessment(); }
});
async function downloadAssessment(id, inputName) {
  const response = await fetch(`/api/assessment/tasks/${id}/export`);
  if (!response.ok) throw new Error((await response.json()).error);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a"); link.href = url; link.download = inputName.replace(/\.xlsx$/i, "") + "—自评结果.xlsx";
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
document.getElementById("export-assessment").addEventListener("click", async () => {
  if (!activeAssessmentTask() || assessmentBusy) return;
  assessmentBusy = true; renderAssessment();
  try {
    await downloadAssessment(assessmentTask.id, assessmentInput.name);
    showToast("已导出自评副本，原文件未修改。");
  } catch (error) { showToast(error.message); }
  finally { assessmentBusy = false; renderAssessment(); }
});
document.getElementById("assessment-model").addEventListener("change", () => { assessmentNotice = ""; renderAssessment(); });
document.getElementById("assessment-scope").addEventListener("change", () => { assessmentNotice = ""; renderAssessment(); });
document.addEventListener("models-change", () => { renderAssessmentModels(); refreshAssessmentReadiness(); });
document.addEventListener("knowledge-projects-change", refreshAssessmentReadiness);
document.addEventListener("click", event => { if (event.target.closest('[data-view="supplier"]')) { assessmentHistoryId = ""; document.getElementById("supplier-record-context").hidden = true; renderKnowledgeProjects(); loadAssessment(); } });
window.addEventListener("hashchange", () => { if (location.hash.startsWith("#supplier")) { loadAssessment(); refreshAssessmentReadiness(); } });
renderAssessmentModels(); loadAssessment(); refreshAssessmentReadiness();
