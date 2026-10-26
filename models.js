"use strict";
const modelProviders = { openai: "OpenAI", bailian: "阿里云百炼", ark: "火山引擎方舟", hunyuan: "腾讯云混元", zhipu: "智谱 GLM", kimi: "Kimi", deepseek: "DeepSeek", siliconflow: "硅基流动", custom: "自定义兼容服务" };
const modelProviderLogos = { openai: "openai", bailian: "bailian", ark: "volcengine", hunyuan: "hunyuan", zhipu: "zhipu", kimi: "kimi", deepseek: "deepseek", siliconflow: "siliconcloud" };
const modelTypeNames = { generation: "生成", embedding: "向量", rerank: "重排" };
let configuredModels = [];
let modelFilter = "all";
let editingModelId = null;
let editingModelRevision = null;
let pendingModelDelete = null;
let modelFormBusy = false;
const modelDialog = document.getElementById("model-dialog");
const modelConfigForm = document.getElementById("model-config-form");
const modelKeyInput = document.getElementById("model-api-key");

function providerLogoMarkup(provider, className = "provider-logo") {
  const name = modelProviderLogos[provider];
  return name ? `<img class="${className}" src="./assets/providers/${name}.svg" alt="" width="32" height="32">` : '<span class="provider-custom-icon"><svg class="icon"><use href="#i-sliders"/></svg></span>';
}
function renderAvailableProviders() {
  document.getElementById("available-provider-list").innerHTML = Object.entries(modelProviders).map(([id, name]) => `<button type="button" data-add-model="${id}">${providerLogoMarkup(id)}<span>${escapeHTML(name)}</span><small>${id === 'bailian' ? '已实测' : '未实测'}</small><svg class="icon"><use href="#i-plus"/></svg></button>`).join("");
  document.getElementById("model-provider").innerHTML = Object.entries(modelProviders).map(([id, name]) => `<option value="${id}">${escapeHTML(name)}</option>`).join("");
}
function modelStatus(message = "", error = false) {
  const status = document.getElementById("model-connection-status");
  status.hidden = !message; status.textContent = message; status.classList.toggle("is-error", error);
}
function modelsBanner(message = "", error = false) {
  const banner = document.getElementById("models-service-message");
  banner.hidden = !message; banner.querySelector("span").textContent = message; banner.classList.toggle("is-error", error);
}
function renderModelSettings() {
  const term = document.getElementById("model-search").value.trim().toLocaleLowerCase();
  const models = configuredModels.filter(model => (modelFilter === "all" || model.type === modelFilter) && `${model.name} ${model.modelId} ${modelProviders[model.provider]}`.toLocaleLowerCase().includes(term));
  document.getElementById("configured-models-count").textContent = `${configuredModels.length} 个模型`;
  document.querySelectorAll("[data-model-filter]").forEach(tab => {
    const active = tab.dataset.modelFilter === modelFilter;
    tab.classList.toggle("selected", active); tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
    tab.querySelector("span").textContent = configuredModels.filter(model => tab.dataset.modelFilter === "all" || model.type === tab.dataset.modelFilter).length;
  });
  document.getElementById("configured-models").innerHTML = models.map(model => `<tr>
    <td data-label="模型"><div class="configured-model-name"><strong>${escapeHTML(model.name)}</strong>${model.isDefault ? '<span class="default-badge">默认</span>' : ""}</div><p class="model-identifier">${escapeHTML(model.modelId)}</p><span class="model-verification ${model.lastTest?.success === false ? "is-error" : ""}">${escapeHTML(model.lastTest?.message || "未测试")}${model.lastTest?.success ? ` · ${model.lastTest.latencyMs} ms${model.lastTest.dimensions ? ` · ${model.lastTest.dimensions} 维` : ""}` : ""}</span></td>
    <td data-label="服务商"><span class="configured-provider">${providerLogoMarkup(model.provider, "provider-logo-small")}${escapeHTML(modelProviders[model.provider])}</span></td><td data-label="类型"><span class="model-type-badge type-${model.type}">${modelTypeNames[model.type]}</span></td>
    <td data-label="API Key"><span class="key-preview-state">${model.hasKey ? "已加密保存" : model.provider === "custom" && /\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(model.baseUrl) ? "本机免密" : "未设置"}</span></td>
    <td data-label="操作"><div class="model-row-actions"><button type="button" class="text-button" data-edit-model="${model.id}">编辑</button><button type="button" class="text-button" data-test-model="${model.id}">测试</button><button type="button" class="text-button danger-text" data-remove-model="${model.id}">删除</button></div>${!model.isDefault ? `<button type="button" class="text-button set-default-button" data-default-model="${model.id}">设为默认</button>` : ""}</td></tr>`).join("");
  document.getElementById("models-empty").hidden = models.length !== 0;
  document.querySelector(".model-table-scroll").hidden = models.length === 0;
}
function refreshModelLinks() {
  renderModelSettings();
  document.dispatchEvent(new CustomEvent("models-change"));
}
async function loadModels() {
  try { const data = await knowledgeApi("/api/models"); configuredModels = data.models; refreshModelLinks(); }
  catch (error) { modelsBanner(error.message, true); }
}
function resetKeyVisibility() {
  modelKeyInput.value = ""; modelKeyInput.type = "password";
  document.getElementById("toggle-model-key").setAttribute("aria-label", "显示 API Key"); document.getElementById("toggle-model-key").setAttribute("aria-pressed", "false");
}
function applyModelPreset() {
  const type = document.getElementById("model-type").value;
  const provider = document.getElementById("model-provider").value;
  document.getElementById("model-dimensions-field").hidden = type !== "embedding";
  if (editingModelId || provider !== "bailian") return;
  const url = document.getElementById("model-base-url");
  const id = document.getElementById("model-id");
  if (!url.value) url.value = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (!id.value || ["qwen-plus", "text-embedding-v4", "qwen3-rerank"].includes(id.value)) id.value = { generation: "qwen-plus", embedding: "text-embedding-v4", rerank: "qwen3-rerank" }[type];
  if (!document.getElementById("model-dimensions").value && type === "embedding") document.getElementById("model-dimensions").value = "1024";
}
function openModelDialog(provider = "bailian", modelId = null, type = "generation") {
  closeSidebar(); modelConfigForm.reset(); resetKeyVisibility(); modelStatus();
  editingModelId = modelId;
  const model = configuredModels.find(item => item.id === modelId);
  editingModelRevision = model?.revision ?? null;
  document.getElementById("model-dialog-title").textContent = model ? "编辑模型" : "添加模型";
  document.getElementById("model-provider").value = model?.provider || provider;
  document.getElementById("model-type").value = model?.type || type;
  document.getElementById("model-display-name").value = model?.name || "";
  document.getElementById("model-id").value = model?.modelId || "";
  document.getElementById("model-base-url").value = model?.baseUrl || "";
  document.getElementById("model-dimensions").value = model?.dimensions ?? "";
  document.getElementById("model-is-default").checked = model?.isDefault || false;
  modelKeyInput.placeholder = model?.hasKey ? "留空保留已保存密钥" : "仅在本机输入，使用 Windows 用户加密保存";
  document.getElementById("model-clear-key-field").hidden = !model?.hasKey;
  applyModelPreset(); if (!modelDialog.open) modelDialog.showModal();
}
function modelFormData() {
  const key = modelKeyInput.value.trim();
  return { name: document.getElementById("model-display-name").value.trim(), modelId: document.getElementById("model-id").value.trim(), provider: document.getElementById("model-provider").value, type: document.getElementById("model-type").value, baseUrl: document.getElementById("model-base-url").value.trim(), dimensions: document.getElementById("model-dimensions").value || null, isDefault: document.getElementById("model-is-default").checked, clearKey: document.getElementById("model-clear-key").checked, expectedRevision: editingModelRevision, ...(editingModelId ? { id: editingModelId } : {}), ...(key ? { apiKey: key } : {}) };
}
function setModelBusy(busy) {
  modelFormBusy = busy;
  modelConfigForm.querySelectorAll("button,input,select").forEach(element => { element.disabled = busy; });
}
modelConfigForm.addEventListener("submit", async event => {
  event.preventDefault(); if (modelFormBusy || !modelConfigForm.reportValidity()) return;
  const input = modelFormData(); setModelBusy(true); modelStatus("正在保存配置…");
  try {
    await knowledgeApi(editingModelId ? `/api/models/${editingModelId}` : "/api/models", jsonRequest(editingModelId ? "PUT" : "POST", input));
    resetKeyVisibility(); modelFilter = "all"; document.getElementById("model-search").value = "";
    await loadModels(); modelDialog.close(); modelsBanner("配置已保存，请点击“测试”验证当前配置。");
  } catch (error) { modelStatus(error.message, true); }
  finally { setModelBusy(false); }
});
document.getElementById("test-model-connection").addEventListener("click", async () => {
  if (modelFormBusy || !modelConfigForm.reportValidity()) return;
  const data = modelFormData(); setModelBusy(true); modelStatus("正在测试当前输入…");
  try { const response = await knowledgeApi("/api/models/test", jsonRequest("POST", data)); modelStatus(`${response.result.message} · ${response.result.latencyMs} ms（当前输入，尚未保存）`); }
  catch (error) { modelStatus(error.message, true); }
  finally { setModelBusy(false); }
});
document.addEventListener("click", async event => {
  const add = event.target.closest("[data-add-model]"); if (add) { openModelDialog(add.dataset.addModel); return; }
  const configure = event.target.closest("[data-configure-model]"); if (configure) { navigate("model-settings"); openModelDialog("bailian", null, configure.dataset.configureModel); return; }
  const edit = event.target.closest("[data-edit-model]"); if (edit) { openModelDialog("bailian", edit.dataset.editModel); return; }
  if (event.target.closest("[data-close-model-dialog]") && !modelFormBusy) { modelDialog.close(); return; }
  const remove = event.target.closest("[data-remove-model]");
  if (remove) { pendingModelDelete = configuredModels.find(model => model.id === remove.dataset.removeModel); document.getElementById("delete-model-name").textContent = pendingModelDelete?.name || ""; document.getElementById("delete-model-dialog").showModal(); return; }
  const test = event.target.closest("[data-test-model]");
  const makeDefault = event.target.closest("[data-default-model]");
  if (test || makeDefault) {
    const button = test || makeDefault; button.disabled = true;
    const id = test?.dataset.testModel || makeDefault.dataset.defaultModel;
    try {
      const model = configuredModels.find(item => item.id === id);
      modelsBanner(test ? "正在测试模型连接…" : "正在设置默认模型…");
      const data = await knowledgeApi(`/api/models/${id}/${test ? "test" : "default"}`, jsonRequest("POST", test ? { expectedRevision: model.revision } : {}));
      modelsBanner(test ? `${model.name}：${data.result.message}` : "默认模型已更新", test && !data.result.success);
      await loadModels();
    } catch (error) { modelsBanner(error.message, true); }
    finally { button.disabled = false; }
    return;
  }
  const filter = event.target.closest("[data-model-filter]"); if (filter) { modelFilter = filter.dataset.modelFilter; renderModelSettings(); }
});
document.getElementById("confirm-model-delete").addEventListener("click", async event => {
  if (!pendingModelDelete) return;
  event.currentTarget.disabled = true;
  try { await knowledgeApi(`/api/models/${pendingModelDelete.id}`, jsonRequest("DELETE", { expectedRevision: pendingModelDelete.revision })); document.getElementById("delete-model-dialog").close(); await loadModels(); modelsBanner("模型配置已删除。"); }
  catch (error) { document.getElementById("delete-model-dialog").close(); modelsBanner(error.message, true); }
  finally { document.getElementById("confirm-model-delete").disabled = false; }
});
document.getElementById("delete-model-dialog").addEventListener("close", () => { pendingModelDelete = null; });
document.getElementById("reload-models").addEventListener("click", loadModels);
document.getElementById("model-provider").addEventListener("change", applyModelPreset);
document.getElementById("model-type").addEventListener("change", applyModelPreset);
document.getElementById("toggle-model-key").addEventListener("click", () => { const show = modelKeyInput.type === "password"; modelKeyInput.type = show ? "text" : "password"; document.getElementById("toggle-model-key").setAttribute("aria-label", show ? "隐藏 API Key" : "显示 API Key"); document.getElementById("toggle-model-key").setAttribute("aria-pressed", String(show)); });
modelDialog.addEventListener("close", resetKeyVisibility);
modelDialog.addEventListener("cancel", event => { if (modelFormBusy) event.preventDefault(); else resetKeyVisibility(); });
document.getElementById("model-search").addEventListener("input", renderModelSettings);
document.querySelector(".model-type-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
  const tabs = [...document.querySelectorAll("[data-model-filter]")], index = tabs.indexOf(event.target);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  modelFilter = tabs[next].dataset.modelFilter; renderModelSettings(); tabs[next].focus();
});
renderAvailableProviders(); renderModelSettings(); loadModels();
