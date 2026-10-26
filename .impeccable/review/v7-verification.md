# Update-mode help and task status refinement

Narrow refinement of the established design prototype; no backend behavior was added.

- Update-mode label has a 17px circled-question icon with a 24px hit target. The tooltip covers incremental versus complete processing, appropriate use cases, relative processing time/model calls and the need to rebuild when changing embedding models.
- Browser confirmed the tooltip remained visible with pointer hover while keyboard focus was elsewhere, opened on keyboard focus, and closed with Escape or an outside click. Touch-style click also opened it. The fixed tooltip clamps its position to the usable viewport and remains hoverable for reading.
- Mobile 390×844: tooltip bounds left 12 / right 363 / top 452.8 / bottom 763.2 on a 375px usable viewport; document scroll width stayed 375. No text was clipped.
- Task list, status filters and detail use only generation success/failure. Browser counts: two success records, one failed record. Successful detail displayed 生成成功.
- Syntax checks and design JSON parsing passed. Final detector ran once: 94 advisory with the existing DEGRADED parser limitation; this is not a full automated contrast/selector audit.
- Screenshots: v7-update-mode-tooltip-desktop.jpg, v7-update-mode-tooltip-mobile.jpg and v7-task-status-desktop.jpg.

Terminology checked against primary framework documentation: https://developers.llamaindex.ai/python/framework-api-reference/indices/ (refresh_ref_docs updates changed/new documents and reuses unchanged content); https://marketplace.dify.ai/plugin/langgenius/voyage (changing embedding dimensions requires complete re-indexing). Tooltip copy describes intended configuration semantics, not an implemented indexing engine.
