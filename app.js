"use strict";

// Shared rendering for persisted current and historical assessments.
const icon = (name, extra = "") => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const statuses = {
  direct: { label: "可直接复用", icon: "check-circle" },
  partial: { label: "部分有依据", icon: "minus" },
  missing: { label: "无相关信息", icon: "info" },
  failed: { label: "调用失败", icon: "close" },
  pending: { label: "待生成", icon: "minus" },
  running: { label: "生成中", icon: "spark" },
};

let rows = [];
let activeFilter = "all";
let selectedId = "04";
let toastTimer;
const body = document.getElementById("results-body");
const search = document.getElementById("question-search");
const evidence = document.getElementById("evidence-content");
const dialog = document.getElementById("information-dialog");

function statusMarkup(status, label = statuses[status].label) {
  const data = statuses[status];
  return `<span class="row-status status-${status}">${icon(data.icon)}${escapeHTML(label)}</span>`;
}

function renderRows() {
  const term = search.value.trim().toLocaleLowerCase();
  const visible = rows.filter((row) => (activeFilter === "all" || row.status === activeFilter) && `${row.question}${row.answer}${row.gap || ""}`.toLocaleLowerCase().includes(term));
  body.innerHTML = visible.map(row => {
    const basis = row.basis ?? ({ direct: "可直接复用", partial: "部分有依据", missing: "无相关信息", failed: "调用失败" }[row.status] || "");
    const details = row.details ?? (row.status === "direct" ? "/" : row.status === "partial" ? row.gap || "" : row.status === "missing" ? "没有搜索到相关信息" : row.status === "failed" ? "调用失败" : "");
    return `<tr class="result-row${selectedId === row.id ? " selected" : ""}" data-row-id="${row.id}">
      <td class="row-number">${row.position || row.id}</td>
      <td><button class="question-select" data-select="${row.id}" aria-label="查看检查项 ${row.position || row.id} 的证据" aria-pressed="${selectedId === row.id}">${escapeHTML(row.question)}</button>${row.line ? `<span class="assessment-input-location">${escapeHTML(row.sheet)} · 第 ${row.line} 行 · ${escapeHTML(row.questionCell)} / ${escapeHTML(row.answerCell)}</span>` : ""}</td>
      <td><p class="answer-text${row.status === "missing" ? " answer-missing" : ""}">${escapeHTML(row.answer || (row.status === "running" ? "正在检索并生成…" : "尚未生成"))}</p></td>
      <td class="result-basis">${basis ? statusMarkup(row.status, row.basis || statuses[row.status].label) : ""}</td>
      <td class="result-details">${escapeHTML(details)}</td>
      <td>${row.sources.length ? row.sources.map(source => `<button class="source-button" data-select="${row.id}" data-source-link="true" aria-label="查看 ${escapeHTML(source.sheet)} 第 ${source.lines.join("、")} 行原文"><span>${icon("link")}${escapeHTML(source.sheet)}</span><small>第 ${source.lines.join("、")} 行</small></button>`).join("") : '<span class="no-source">未找到来源</span>'}</td></tr>`;
  }).join("");
  document.getElementById("search-empty").hidden = visible.length !== 0;
  document.querySelector(".result-table").hidden = visible.length === 0;
  document.getElementById("evidence-panel").hidden = visible.length === 0;
  document.querySelector(".review-content").classList.toggle("no-results", visible.length === 0);
  document.getElementById("table-count").textContent = `显示 ${visible.length} 项`;
  document.querySelectorAll('[data-filter]').forEach(tab => { const status = tab.dataset.filter; tab.querySelector('span').textContent = rows.filter(row => status === 'all' || row.status === status).length; });
  if (visible.length && !visible.some((row) => row.id === selectedId)) selectedId = visible[0].id;
  if (visible.length) {
    body.querySelectorAll("[data-row-id]").forEach((element) => element.classList.toggle("selected", element.dataset.rowId === selectedId));
    body.querySelectorAll(".question-select").forEach((element) => element.setAttribute("aria-pressed", String(element.dataset.select === selectedId)));
    renderEvidence();
  }
}

function highlightedText(source) {
  let text = escapeHTML(source.excerpt);
  for (const phrase of source.highlights) text = text.replace(escapeHTML(phrase), `<mark>${escapeHTML(phrase)}</mark>`);
  return text;
}

function renderEvidence() {
  const row = rows.find((item) => item.id === selectedId);
  document.getElementById("evidence-number").textContent = `检查项 ${row.position || row.id}`;
  const summary = `<div class="evidence-summary"><p class="evidence-question-label">当前检查内容</p><p class="evidence-question">${escapeHTML(row.question)}</p>${statusMarkup(row.status, row.basis || statuses[row.status].label)}</div>`;
  if (!row.sources.length) {
    evidence.innerHTML = `${summary}<div class="missing-evidence">${icon("search")}<h4>${row.status === 'failed' ? `${escapeHTML(row.basis || '调用失败')}，未保存结果` : ['pending','running'].includes(row.status) ? '尚未生成' : '没有相关信息'}</h4></div>`;
    return;
  }
  evidence.innerHTML = `${summary}<div class="evidence-sources"><h4 class="evidence-section-title">知识库原文<span>${row.sources.length} 处引用</span></h4>${row.sources.map((source) => `<article class="evidence-source"><div class="source-location"><span class="sheet-marker" aria-hidden="true"><i></i><i></i><i></i><i></i></span>${source.knowledgeName ? `<span class="source-knowledge-name">${escapeHTML(source.knowledgeName)} · v${source.version}</span>` : ""}${escapeHTML(source.sheet)}<span>·</span>第 ${source.lines.join("、")} 行<span class="source-cell">${escapeHTML(source.answerCell || `C${source.lines[0]}`)}</span></div><blockquote>${highlightedText(source)}</blockquote></article>`).join("")}</div><div class="evidence-coverage"><h4 class="evidence-section-title">问题覆盖情况</h4><ul class="coverage-list">${row.coverage.map((item) => `<li class="${item.supported ? "supported" : "unsupported"}">${icon(item.supported ? "check-circle" : "minus")}<span>${escapeHTML(item.text)}</span></li>`).join("")}</ul></div>`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  const toast = document.getElementById("toast");
  toast.querySelector("span").textContent = message;
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3800);
}

function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebar").inert = window.matchMedia("(max-width: 799px)").matches;
  document.getElementById("sidebar-scrim").hidden = true;
  document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
}

const sheetSizes = { QSA: 960, QPA: 473, 有害物质: 258, 社会责任: 264 };
function openPanel() {
  closeSidebar();
  document.getElementById("dialog-title").textContent = "填表规则";
  document.getElementById("dialog-content").innerHTML = `<dl class="rules-summary"><div><dt>知识依据</dt><dd>C 列自评说明</dd></div><div><dt>D 列备注</dt><dd>忽略</dd></div><div><dt>填写方式</dt><dd>每项独立回答</dd></div><div><dt>无依据内容</dt><dd>没有相关信息</dd></div><div><dt>来源格式</dt><dd>Sheet 与原始行号</dd></div></dl>`;
  if (!dialog.open) dialog.showModal();
}

document.addEventListener("click", (event) => {
  const demo = event.target.closest("[data-demo]");
  if (demo) { showToast(demo.dataset.demo); closeSidebar(); return; }
  const panel = event.target.closest("[data-panel]");
  if (panel) { openPanel(panel.dataset.panel); return; }
  const select = event.target.closest("[data-select]");
  if (select) {
    selectedId = select.dataset.select;
    renderRows();
    document.querySelector(`.question-select[data-select="${selectedId}"]`).focus({ preventScroll: true });
    if (select.dataset.sourceLink && window.matchMedia("(max-width: 1699px)").matches) document.getElementById("evidence-panel").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    return;
  }
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    activeFilter = filter.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach((tab) => { const active = tab === filter; tab.classList.toggle("selected", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; });
    renderRows();
  }
});

document.querySelector(".filter-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll(".filter-tab")];
  const index = tabs.indexOf(event.target);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
});
document.querySelectorAll(".filter-tab").forEach((tab) => { tab.tabIndex = tab.classList.contains("selected") ? 0 : -1; });
search.addEventListener("input", renderRows);
document.getElementById("clear-search").addEventListener("click", () => { search.value = ""; document.querySelector('[data-filter="all"]').click(); search.focus(); });
document.getElementById("dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
document.getElementById("menu-toggle").addEventListener("click", () => { const sidebar = document.getElementById("sidebar"); const isOpen = sidebar.classList.toggle("open"); sidebar.inert = !isOpen; document.getElementById("sidebar-scrim").hidden = !isOpen; document.getElementById("menu-toggle").setAttribute("aria-expanded", String(isOpen)); });
document.getElementById("sidebar-scrim").addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSidebar(); });
const sidebarBreakpoint = window.matchMedia("(max-width: 799px)");
document.getElementById("sidebar").inert = sidebarBreakpoint.matches;
sidebarBreakpoint.addEventListener("change", closeSidebar);
renderRows();

