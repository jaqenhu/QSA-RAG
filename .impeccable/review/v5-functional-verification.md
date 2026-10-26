# V5 prototype verification

Scope: model settings and knowledge-base training UI only. No provider request, credential storage, document processing, index construction or training result is implemented.

Observed through the browser:

- Model settings sits immediately above task history. Knowledge training is named consistently across page title, tabs and sidebar; the old hash remains a navigation alias.
- Added a custom embedding model (`demo-embedding`, example.com endpoint) through the form. It appeared in the embedding selector and did not appear in the rerank selector.
- A synthetic test string could be revealed/masked; the key input was empty after saving. Model metadata includes no key property. Source inspection found no persistence or request API in settings.js.
- Connection test displays that no connection request was sent. Training displays a design-preview message without changing its status to completed.
- Selecting the newly added model updated the training task summary. Removing QSA from the selected sheets left 995 records.
- Deselecting all sheets disabled start. Removing both available embedding models disabled start and showed a configuration prompt.
- Searching for an absent model displayed the empty state. Reload restored the three explicit fixture models and removed the temporary metadata.
- Both new routes: no document horizontal overflow at 1440×1000, 1024×900 and 390×844. New inputs/buttons showed no clipped content in sampled geometry checks. Mobile model dialog fit the viewport and exposed all actions.
- All JavaScript syntax checks passed. Page, settings.js and both font files returned HTTP 200. Browser error log was empty.

Capture notes: the IAB full-page stitch can shift fixed elements. Review uses paired viewport top/bottom images. Two initial top captures started too far down and were replaced after the independent reviewer requested recapture. No layout change was made to compensate for a capture artifact.

Mechanical scan ran once on the completed source. It reported 87 advisory findings under DEGRADED parsing (missing optional HTML/CSS parser dependencies). It does not verify computed contrast or complete selector matching. Existing contrast roles and visible geometry were checked in the browser.
