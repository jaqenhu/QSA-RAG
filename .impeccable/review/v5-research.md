# Model configuration and knowledge training design references

User request: independent model configuration above task history; rename model training to knowledge-base training; link configured models and uploaded knowledge; remove answer style. Existing static-prototype boundary is retained.

Primary references consulted on 2026-10-19:

- RAGFlow model provider configuration: https://github.com/infiniflow/ragflow/blob/main/docs/guides/models/llm_api_key_setup.md — provider connection settings, API Key/Base URL, model types, defaults and verification.
- Dify index/retrieval settings: https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/setting-indexing-methods — embedding-based indexing, vector/keyword/hybrid retrieval and optional reranking.
- SiliconFlow model API reference (illustrative model IDs only): https://github.com/siliconflow/siliconcloud/blob/main/openapi.yaml

Adaptation to QSA: whole question/answer pairs are the ingestion unit. Column C remains authoritative, D is ignored, and original Sheet/row references are retained. The prototype uses existing uploaded-workbook fixtures rather than a second file upload. No fine-tuning is implied by the user-facing knowledge-training name.

Three initial model entries are explicitly labeled examples and unverified. API Keys are never collected into the model metadata; the input is cleared on save or dismissal. No model requests or backend storage are implemented.
