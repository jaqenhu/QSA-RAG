import { ApiError } from './store.mjs';

const clean = value => String(value).replace(/\s+/gu, ' ').trim();
// Flat wire format avoids the nested citation arrays that qwen-max repeatedly corrupts.
// The canonical parts format remains internal and is still accepted for compatibility.
export const assessmentSchema = {
  type: 'object', additionalProperties: false, required: ['requirements', 'citations'], properties: {
    requirements: { type: 'array', minItems: 1, maxItems: 30, items: {
      type: 'object', additionalProperties: false, required: ['id', 'requirement', 'status'], properties: {
        id: { type: 'string', minLength: 1, maxLength: 80 },
        requirement: { type: 'string', minLength: 1, maxLength: 1000 },
        status: { type: 'string', enum: ['supported', 'missing'] },
      },
    } },
    citations: { type: 'array', maxItems: 360, items: {
      type: 'object', additionalProperties: false, required: ['requirementId', 'evidenceId', 'quote'], properties: {
        requirementId: { type: 'string', minLength: 1, maxLength: 80 },
        evidenceId: { type: 'string', minLength: 1, maxLength: 200 },
        quote: { type: 'string', minLength: 2, maxLength: 25000 },
      },
    } },
  },
};
export function decodeAssessmentOutput(output) {
  if (!object(output) || ('parts' in output && !('requirements' in output))) return normalizeAssessmentOutput(output);
  if (!Array.isArray(output.requirements) || !output.requirements.length || output.requirements.length > 30)
    throw outputError('生成结果格式无效：requirements 必须是含1–30项的判断数组。', 'requirements', '需要含1–30项的数组');
  if (!Array.isArray(output.citations) || output.citations.length > 360)
    throw outputError('生成结果格式无效：citations 必须是引用数组。', 'citations', '需要数组，最多360条');
  const parts = new Map();
  for (const [i, row] of output.requirements.entries()) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 80 || parts.has(row.id))
      throw outputError(`生成结果格式无效：requirements[${i}].id 必须唯一且非空。`, `requirements[${i}].id`, '需要唯一非空编号');
    parts.set(row.id, { requirement: row.requirement, status: row.status, citations: [] });
  }
  for (const [i, citation] of output.citations.entries()) {
    if (!object(citation) || typeof citation.requirementId !== 'string' || !parts.has(citation.requirementId))
      throw outputError(`生成结果格式无效：citations[${i}].requirementId 没有对应判断项。`, `citations[${i}].requirementId`, '必须对应requirements中的真实编号');
    parts.get(citation.requirementId).citations.push({ evidenceId: citation.evidenceId, quote: citation.quote });
  }
  return normalizeAssessmentOutput({ parts: [...parts.values()] });
}
export function outputError(message, path, reason, code = 'MODEL_OUTPUT_FORMAT') {
  return Object.assign(new ApiError(422, message), { code, stage: 'validating', issues: [{ path, reason }] });
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Only lossless container conversions are allowed. Never infer facts or invent citations.
export function normalizeAssessmentOutput(output) {
  if (!object(output) || !Array.isArray(output.parts) || !output.parts.length || output.parts.length > 30)
    throw outputError('生成结果格式无效：parts 必须是含 1–30 项的数组。', 'parts', '需要非空数组，最多30项');
  return { parts: output.parts.map((part, index) => {
    const path = `parts[${index}]`;
    if (!object(part)) throw outputError(`生成结果格式无效：${path} 必须是对象。`, path, '需要对象');
    if (typeof part.requirement !== 'string' || !part.requirement.trim() || part.requirement.length > 1000)
      throw outputError(`生成结果格式无效：${path}.requirement 必须是非空文本（最多1000字）。`, `${path}.requirement`, '需要非空文本，最多1000字');
    if (!['supported', 'missing'].includes(part.status))
      throw outputError(`生成结果格式无效：${path}.status 只能是 supported 或 missing。`, `${path}.status`, '只能是supported或missing');
    let citations = part.citations;
    if (part.status === 'missing' && citations == null) citations = [];
    if (part.status === 'supported' && citations === undefined && typeof part.evidenceId === 'string' && typeof part.quote === 'string')
      citations = [{ evidenceId: part.evidenceId, quote: part.quote }];
    if (object(citations)) citations = [citations];
    if (!Array.isArray(citations) || citations.length > 12)
      throw outputError(`生成结果格式无效：${path}.citations 必须是引用数组（最多12条）。`, `${path}.citations`, '需要数组，最多12条');
    return { requirement: part.requirement, status: part.status, citations: citations.map((citation, i) => {
      const location = `${path}.citations[${i}]`;
      if (!object(citation) || typeof citation.evidenceId !== 'string' || !citation.evidenceId.trim() || citation.evidenceId.length > 200 || typeof citation.quote !== 'string' || clean(citation.quote).length < 2 || citation.quote.length > 25000)
        throw outputError(`生成结果格式无效：${location} 缺少有效的 evidenceId 或 quote。`, location, '需要有效evidenceId和至少2字的原文quote');
      return { evidenceId: citation.evidenceId, quote: citation.quote };
    }) };
  }) };
}

export function groundedResult(output, candidates) {
  output = normalizeAssessmentOutput(output);
  const sources = new Map(), quotes = new Set();
  const coverage = output.parts.map((part, partIndex) => {
    const supported = part.status === 'supported';
    if (supported !== Boolean(part.citations.length)) throw outputError('依据状态与引用不一致，请重试该题。', `parts[${partIndex}].citations`, 'supported必须有引用，missing必须无引用', 'MODEL_EVIDENCE_INVALID');
    for (const [citationIndex, citation] of part.citations.entries()) {
      const record = candidates.find(row => row.id === citation.evidenceId);
      if (!record || typeof citation.quote !== 'string' || clean(citation.quote).length < 2 || !clean(record.answer).includes(clean(citation.quote))) throw outputError(`第${partIndex + 1}项判断的第${citationIndex + 1}条引用不属于候选 C 列原文，已拒绝保存，请重试该题。`, `parts[${partIndex}].citations[${citationIndex}]`, '引用ID不存在或quote不是该候选C列连续原文', 'MODEL_EVIDENCE_INVALID');
      const quote = clean(citation.quote);
      // Only verified verbatim C-column extracts become answers. No model-authored facts.
      quotes.add(quote);
      const current = sources.get(record.id) || { recordId: record.id, ...(record.fileName ? { fileName: record.fileName, documentId: record.documentId } : {}), sheet: record.sheet, line: record.line, questionCell: record.questionCell, answerCell: record.answerCell, question: record.question, excerpt: record.answer, quotes: [] };
      if (!current.quotes.includes(quote)) current.quotes.push(quote);
      sources.set(record.id, current);
    }
    return { text: part.requirement.trim(), supported };
  });
  const supported = coverage.filter(part => part.supported).length;
  const status = !supported ? 'missing' : supported === coverage.length ? 'direct' : 'partial';
  const answer = quotes.size ? [...quotes].join('\n') : '没有相关信息。';
  const gap = status === 'partial' ? coverage.filter(part => !part.supported).map(part => part.text).join('；') : '';
  if (answer.length + gap.length > 25000) throw new ApiError(422, '该题引用过长，请精简问题后重试。');
  return { status, answer, gap, coverage, sources: [...sources.values()] };
}
