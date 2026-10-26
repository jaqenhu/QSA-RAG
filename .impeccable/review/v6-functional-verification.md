# V6 provider logos and supplier-assessment history

The existing design-only scope is retained. Task history is an explicit fixture view, not a real generation run or persistent task database.

## Provider directory

- OpenAI, 阿里云百炼, 火山引擎方舟, 腾讯云混元, 智谱 GLM and Kimi are first, followed by DeepSeek, 硅基流动 and a neutral custom-service entry.
- Eight original SVG assets are pinned to LobeHub icons-static-svg 1.95.1. All eight match their recorded SHA-256 and return HTTP 200 from the local preview. Every brand image loaded successfully in the browser.
- The Kimi monochrome mark is used for the light surface; the color variant's white K was unsuitable for this background and was replaced with the library's unmodified monochrome file.
- Clicking Ark and Kimi opened the model form with the matching service selected. Native provider options and configured-model provider cells use the same catalog.

## Task records

- Three clearly labeled supplier-assessment specimens: pending review, reviewed and failed. Every successful specimen shows six sample checks, not an invented complete result for 183 input checks.
- Failure filtering returned one row without a result link. Date filtering for 2026-10-18 returned two rows. Absent search terms showed the empty state; clear filters restored three rows.
- Detail displayed input, knowledge version, model, timestamps, sample result counts and source-reference policy. The failed specimen displayed its explicit example error.
- View result navigated to supplier assessment, restored the six fixed rows and showed the source task ID. Return to history worked.
- Export and retry remain unconnected prototype actions. Actual result/source snapshot storage remains a future business implementation requirement.

## Layout and checks

- Both affected views were checked at 1440×1000, 1024×900 and 390×844 without document horizontal overflow. Sampled controls had no clipped content. Mobile detail fits within a scrollable 780px dialog on an 844px viewport.
- Local syntax checks passed; browser errors were empty. No API Key is read, persisted or transmitted.
- The detector ran once on the final UI sources: 93 advisory findings with DEGRADED parsing. It cannot substitute for browser geometry and visual review.
- Viewport captures are used. The mobile provider screenshot intentionally shows the complete provider directory below the document top, rather than claiming to be a whole-page capture.
