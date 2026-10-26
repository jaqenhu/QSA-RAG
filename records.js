"use strict";
const taskRecordStates = { success: { name: "生成成功", icon: "check-circle" }, partial_success: { name: "生成成功，部分需审核", icon: "info" }, failed: { name: "生成失败", icon: "close" } };
let taskRecordFilter = "all", taskRecordPage = 1, taskRecordRequest = 0, taskRecordTotal = 0, taskRecordTimer;
let taskRecords = [];
const taskDetailDialog = document.getElementById("task-detail-dialog");
const taskDeleteDialog = document.getElementById("delete-task-dialog");
let pendingTaskDelete = null;
const deletedTaskRecords = [];
function taskStateMarkup(status) { const state = taskRecordStates[status]; return `<span class="task-state task-state-${status}">${icon(state.icon)}${state.name}</span>`; }
function taskResultMarkup(record) { const counts = record.counts; return `<strong class="record-result-total">${record.total} 项</strong><span class="record-result-counts">可复用 ${counts.direct || 0} · 部分 ${counts.partial || 0} · 无信息 ${counts.missing || 0} · 失败 ${counts.failed || 0}</span>`; }
const taskTime = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
async function renderTaskRecords() {
  const request = ++taskRecordRequest;
  const params = new URLSearchParams({ status: taskRecordFilter, date: document.getElementById("task-date-filter").value, q: document.getElementById("task-search").value.trim(), page: taskRecordPage, limit: 20 });
  document.getElementById("task-records-status").textContent = "正在加载…";
  try {
    const data = await knowledgeApi(`/api/assessment/tasks?${params}`);
    if (request !== taskRecordRequest) return;
    const lastPage = Math.max(1, Math.ceil(data.total / 20));
    if (taskRecordPage > lastPage) { taskRecordPage = lastPage; return renderTaskRecords(); }
    taskRecords = data.tasks; taskRecordTotal = data.total;
    document.getElementById("task-records-count").textContent = `${data.counts.all} 条记录`;
    const dates = document.getElementById("task-date-filter"); const selectedDate = dates.value;
    dates.innerHTML = '<option value="all">全部时间</option>' + data.dates.map(date => `<option value="${date}">${date}</option>`).join(""); dates.value = data.dates.includes(selectedDate) ? selectedDate : "all";
    document.querySelectorAll("[data-task-filter]").forEach(tab => { const active = tab.dataset.taskFilter === taskRecordFilter; tab.classList.toggle("selected", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; tab.querySelector("span").textContent = data.counts[tab.dataset.taskFilter]; });
    document.getElementById("task-records-body").innerHTML = taskRecords.map(record => `<tr><td data-label="任务 / 输入表"><strong class="record-task-name">${escapeHTML(record.input.name.replace(/\.xlsx$/i, ""))}</strong><span class="record-input">${icon("file")}${escapeHTML(record.input.name)}</span><span class="record-id">${record.id}${record.retryOf ? `<span>失败项重试</span>` : ""}</span></td><td data-label="知识库">${escapeHTML(record.knowledge.name)}<small class="record-kb-version">v${record.knowledge.version}</small></td><td data-label="生成结果">${taskResultMarkup(record)}</td><td data-label="状态">${taskStateMarkup(record.status)}</td><td data-label="生成时间"><time datetime="${record.createdAt}">${escapeHTML(taskTime(record.createdAt))}</time></td><td data-label="操作"><div class="record-actions"><button class="text-button" data-task-result="${record.id}">查看结果</button><button class="text-button" data-task-detail="${record.id}">详情</button><button class="text-button task-delete-button" data-task-delete="${record.id}" aria-label="删除 ${escapeHTML(record.input.name)} 的任务记录">删除</button></div></td></tr>`).join("");
    document.getElementById("task-records-empty").hidden = Boolean(data.tasks.length);
    document.querySelector(".task-records-scroll").hidden = !data.tasks.length;
    document.getElementById("task-records-visible").textContent = `显示 ${data.tasks.length} 条 · 共 ${data.total} 条`;
    document.getElementById("task-records-page").textContent = `${taskRecordPage} / ${Math.max(1, Math.ceil(data.total / 20))}`;
    document.getElementById("task-records-prev").disabled = taskRecordPage <= 1;
    document.getElementById("task-records-next").disabled = taskRecordPage * 20 >= data.total;
    document.getElementById("task-records-status").textContent = data.running ? "有任务正在生成，可返回当前自评查看进度。" : "";
  } catch (error) { if (request === taskRecordRequest) document.getElementById("task-records-status").textContent = error.message; }
}
async function showTaskDetail(id) {
  try {
    const { task } = await knowledgeApi(`/api/assessment/tasks/${id}`); const snapshot = task.snapshot;
    document.getElementById("task-detail-content").innerHTML = `<div class="record-detail-heading"><strong>${escapeHTML(snapshot.input.name)}</strong>${taskStateMarkup(task.status)}</div><dl class="record-detail-facts"><div><dt>任务编号</dt><dd>${task.id}</dd></div><div><dt>输入表格</dt><dd>${escapeHTML(snapshot.input.name)}</dd></div><div><dt>知识库快照</dt><dd>${escapeHTML(snapshot.knowledge.name)} · v${snapshot.knowledge.version}</dd></div><div><dt>生成模型</dt><dd>${escapeHTML(snapshot.model.name)} · ${escapeHTML(snapshot.model.modelId)}</dd></div><div><dt>生成时间</dt><dd>${escapeHTML(taskTime(task.createdAt))}</dd></div><div><dt>结束时间</dt><dd>${escapeHTML(taskTime(task.finishedAt))}</dd></div>${task.retryOf ? `<div><dt>重试自任务</dt><dd>${task.retryOf}</dd></div>` : ""}</dl><div class="record-detail-result"><h3>生成结果</h3>${taskResultMarkup(task)}</div>${task.error ? `<p class="record-error">${escapeHTML(task.error)}</p>` : ""}<div class="record-detail-footer"><button class="button button-quiet" data-dismiss-task>关闭</button>${task.counts.failed ? `<button class="button button-outline" data-task-retry="${task.id}">重试失败项</button>` : ""}<button class="button button-outline" data-task-export="${task.id}">导出表格</button><button class="button button-primary" data-task-result="${task.id}">查看结果${icon("arrow")}</button></div>`;
    closeSidebar(); if (!taskDetailDialog.open) taskDetailDialog.showModal();
  } catch (error) { showToast(error.message); }
}
function showTaskResult(id) { taskDetailDialog.close(); location.hash = `supplier/${id}`; }

function renderTaskDeleteUndo() {
  const last = deletedTaskRecords.at(-1);
  document.getElementById("task-delete-feedback").hidden = !last;
  document.getElementById("task-delete-feedback-text").textContent = last ? `已删除 ${last.input.name} 的任务记录` : "";
}
function confirmTaskDelete(id) {
  pendingTaskDelete = taskRecords.find(record => record.id === id);
  if (!pendingTaskDelete) return;
  document.getElementById("delete-task-name").textContent = pendingTaskDelete.input.name;
  document.getElementById("delete-task-id").textContent = pendingTaskDelete.id;
  document.getElementById("delete-task-error").textContent = "";
  closeSidebar(); taskDeleteDialog.showModal();
}
document.getElementById("confirm-task-delete").addEventListener("click", async event => {
  const record = pendingTaskDelete;
  if (!record) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    await knowledgeApi(`/api/assessment/tasks/${record.id}`, jsonRequest("DELETE", {}));
    deletedTaskRecords.push(record); renderTaskDeleteUndo(); taskDeleteDialog.close();
    if (assessmentTask?.id === record.id) await loadAssessment();
    await renderTaskRecords();
    document.getElementById("undo-task-delete").focus();
  } catch (error) { document.getElementById("delete-task-error").textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById("undo-task-delete").addEventListener("click", async event => {
  const record = deletedTaskRecords.at(-1); if (!record) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    await knowledgeApi(`/api/assessment/tasks/${record.id}/restore`, jsonRequest("POST", {}));
    deletedTaskRecords.pop(); renderTaskDeleteUndo(); await renderTaskRecords();
    document.querySelector(`[data-task-delete="${record.id}"]`)?.focus();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener("click", async event => {
  const deleting = event.target.closest("[data-task-delete]"); if (deleting) { confirmTaskDelete(deleting.dataset.taskDelete); return; }
  const detail = event.target.closest("[data-task-detail]"); if (detail) { showTaskDetail(detail.dataset.taskDetail); return; }
  const result = event.target.closest("[data-task-result]"); if (result) { showTaskResult(result.dataset.taskResult); return; }
  const filter = event.target.closest("[data-task-filter]"); if (filter) { taskRecordFilter = filter.dataset.taskFilter; taskRecordPage = 1; renderTaskRecords(); return; }
  if (event.target.closest("[data-dismiss-task]")) { taskDetailDialog.close(); return; }
  const exporting = event.target.closest("[data-task-export]");
  if (exporting) { exporting.disabled = true; try { const { task } = await knowledgeApi(`/api/assessment/tasks/${exporting.dataset.taskExport}`); await downloadAssessment(task.id, task.snapshot.input.name); } catch (error) { showToast(error.message); } finally { exporting.disabled = false; } return; }
  const retry = event.target.closest("[data-task-retry]");
  if (retry) { retry.disabled = true; try { await knowledgeApi(`/api/assessment/tasks/${retry.dataset.taskRetry}/retry`, jsonRequest("POST", {})); taskDetailDialog.close(); navigate("supplier"); loadAssessment(); renderTaskRecords(); } catch (error) { showToast(error.message); } finally { retry.disabled = false; } }
});
document.getElementById("close-task-detail").addEventListener("click", () => taskDetailDialog.close());
document.getElementById("task-search").addEventListener("input", () => { clearTimeout(taskRecordTimer); taskRecordTimer = setTimeout(() => { taskRecordPage = 1; renderTaskRecords(); }, 200); });
document.getElementById("task-date-filter").addEventListener("change", () => { taskRecordPage = 1; renderTaskRecords(); });
document.getElementById("reset-task-filters").addEventListener("click", () => { document.getElementById("task-search").value = ""; document.getElementById("task-date-filter").value = "all"; taskRecordPage = 1; taskRecordFilter = "all"; renderTaskRecords(); });
document.getElementById("task-records-prev").addEventListener("click", () => { if (taskRecordPage > 1) { taskRecordPage--; renderTaskRecords(); } });
document.getElementById("task-records-next").addEventListener("click", () => { if (taskRecordPage * 20 < taskRecordTotal) { taskRecordPage++; renderTaskRecords(); } });
document.querySelector(".record-state-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
  event.preventDefault(); const tabs = [...document.querySelectorAll("[data-task-filter]")], index = tabs.indexOf(event.target);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
});
document.addEventListener("assessment-tasks-change", renderTaskRecords);
window.addEventListener("hashchange", () => { if (location.hash === "#task-history") renderTaskRecords(); });
renderTaskRecords();
