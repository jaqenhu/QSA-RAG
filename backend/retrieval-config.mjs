import { ApiError } from './store.mjs';

export const RETRIEVAL_DEFAULTS = Object.freeze({ retrievalVersion: 2, retrieval: 'hybrid', fusion: 'rrf', rrfK: 60, vectorTopK: 20, bm25TopK: 20, rerankCandidateLimit: 40, rerankTopN: 8, rerankThreshold: 0.5, topK: 8, threshold: 0.5, rerankModelId: null });
const fields = Object.keys(RETRIEVAL_DEFAULTS);
export function retrievalConfig(input = {}, base = RETRIEVAL_DEFAULTS) {
  const config = { ...RETRIEVAL_DEFAULTS, ...Object.fromEntries(fields.filter(key => base[key] !== undefined).map(key => [key, base[key]])), ...Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
  if (input.method !== undefined) config.retrieval = input.method;
  if (config.rerankModelId === '') config.rerankModelId = null;
  if (![1, 2].includes(config.retrievalVersion) || !['hybrid', 'vector', 'keyword'].includes(config.retrieval) || !['rrf', 'weighted'].includes(config.fusion)) throw new ApiError(400, '检索方式或融合策略无效。');
  for (const [key, max] of [['rrfK',1000],['vectorTopK',100],['bm25TopK',100],['rerankCandidateLimit',200],['rerankTopN',50],['topK',50]]) if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new ApiError(400, '召回条数、RRF 常数或重排条数超出允许范围。');
  for (const key of ['threshold','rerankThreshold']) if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) throw new ApiError(400, '得分阈值必须在 0–1 之间。');
  if (config.rerankTopN > config.rerankCandidateLimit) throw new ApiError(400, '重排返回条数不能大于重排候选上限。');
  if (config.rerankModelId !== null && (typeof config.rerankModelId !== 'string' || !/^[a-f0-9-]+$/.test(config.rerankModelId))) throw new ApiError(400, '请选择有效的重排模型。');
  return config;
}

// Replaying a pre-v0.6 task must retain its original retrieval behavior.
export function legacyAssessmentRetrieval(snapshot) {
  return retrievalConfig({ retrievalVersion: 1, retrieval: 'hybrid', fusion: 'weighted', topK: 8, threshold: 0.5, rerankModelId: snapshot.rerank?.id || null });
}
