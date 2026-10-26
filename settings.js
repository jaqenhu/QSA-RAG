"use strict";

// The update-mode help remains readable with hover, keyboard focus or a tap.
const updateHelp = document.getElementById("update-mode-help");
const updateHelpButton = document.getElementById("update-mode-help-button");
const updateHelpTooltip = document.getElementById("update-mode-tooltip");
let updateHelpCloseTimer;
function closeUpdateHelp() {
  clearTimeout(updateHelpCloseTimer);
  updateHelpTooltip.hidden = true;
}
function positionUpdateHelp() {
  const viewportWidth = document.documentElement.clientWidth;
  updateHelpTooltip.style.maxWidth = `${viewportWidth - 24}px`;
  const anchor = updateHelpButton.getBoundingClientRect();
  const bounds = updateHelpTooltip.getBoundingClientRect();
  const margin = 12;
  const left = Math.max(margin, Math.min(anchor.left, viewportWidth - bounds.width - margin));
  const below = anchor.bottom + 8;
  const top = below + bounds.height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - bounds.height - 8);
  updateHelpTooltip.style.left = `${left}px`;
  updateHelpTooltip.style.top = `${top}px`;
}
function openUpdateHelp() {
  clearTimeout(updateHelpCloseTimer);
  updateHelpTooltip.hidden = false;
  positionUpdateHelp();
}
updateHelp.addEventListener("pointerenter", openUpdateHelp);
updateHelp.addEventListener("pointerleave", () => {
  updateHelpCloseTimer = setTimeout(() => { if (!updateHelp.contains(document.activeElement)) closeUpdateHelp(); }, 150);
});
updateHelpButton.addEventListener("focus", openUpdateHelp);
updateHelpButton.addEventListener("click", openUpdateHelp);
updateHelp.addEventListener("focusout", (event) => { if (!updateHelp.contains(event.relatedTarget) && !updateHelp.matches(":hover")) closeUpdateHelp(); });
document.addEventListener("pointerdown", (event) => { if (!updateHelp.contains(event.target)) closeUpdateHelp(); });
document.addEventListener("click", (event) => { if (!updateHelp.contains(event.target)) closeUpdateHelp(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeUpdateHelp(); });
window.addEventListener("resize", () => { if (!updateHelpTooltip.hidden) positionUpdateHelp(); });
window.addEventListener("scroll", (event) => {
  if (updateHelpTooltip.hidden || event.target === updateHelpTooltip) return;
  const anchor = updateHelpButton.getBoundingClientRect();
  if (anchor.bottom < 0 || anchor.top > window.innerHeight) closeUpdateHelp(); else positionUpdateHelp();
}, true);
window.addEventListener("hashchange", closeUpdateHelp);
