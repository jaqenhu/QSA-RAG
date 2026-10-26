export function tokens(value) {
  const output = [];
  for (const part of String(value).toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || []) {
    if (/^[a-z0-9_]+$/.test(part) || part.length === 1) output.push(part);
    else for (let i = 0; i < part.length - 1; i++) output.push(part.slice(i, i + 2));
  }
  return output;
}
export function normalizedVector(values) {
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('Invalid vector');
  return Float32Array.from(values, value => value / norm);
}
export function vectorBlob(values) { return Buffer.from(normalizedVector(values).buffer); }
export function readVector(blob) {
  const copy = Uint8Array.from(blob);
  return new Float32Array(copy.buffer);
}
export function rankRecords(records, query, queryVector, method) {
  const terms = tokens(query);
  const unique = [...new Set(terms)];
  const docs = records.map(record => {
    const words = tokens(`${record.chapter}\n${record.question}\n${record.answer}`);
    const frequency = new Map();
    for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
    return { record, frequency, length: words.length || 1 };
  });
  const average = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const documentFrequency = new Map(unique.map(term => [term, docs.reduce((n, d) => n + Number(d.frequency.has(term)), 0)]));
  return docs.map(({ record, frequency, length }) => {
    let bm25 = 0;
    for (const term of unique) {
      const tf = frequency.get(term) || 0;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      bm25 += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / average));
    }
    const keywordScore = bm25 / (bm25 + 3);
    let vectorScore = 0;
    if (queryVector) {
      const vector = readVector(record.vector);
      if (vector.length !== queryVector.length) throw new Error('Index dimensions changed');
      for (let i = 0; i < vector.length; i++) vectorScore += vector[i] * queryVector[i];
      vectorScore = Math.max(0, Math.min(1, vectorScore));
    }
    const score = method === 'keyword' ? keywordScore : method === 'vector' ? vectorScore : 0.65 * vectorScore + 0.35 * keywordScore;
    const { vector, ...source } = record;
    return { ...source, score, vectorScore, keywordScore };
  }).sort((a, b) => b.score - a.score || a.line - b.line);
}

export function fuseCandidates(ranked, config) {
  const tie = (a, b) => a.line - b.line || a.sheet.localeCompare(b.sheet) || a.id.localeCompare(b.id);
  const vector = config.retrieval === 'keyword' ? [] : ranked.filter(row => row.vectorScore > 0).sort((a,b) => b.vectorScore - a.vectorScore || tie(a,b)).slice(0,config.vectorTopK);
  const keyword = config.retrieval === 'vector' ? [] : ranked.filter(row => row.keywordScore > 0).sort((a,b) => b.keywordScore - a.keywordScore || tie(a,b)).slice(0,config.bm25TopK);
  const union = new Map();
  for (const [items, rankKey] of [[vector,'vectorRank'],[keyword,'bm25Rank']]) items.forEach((row,index) => {
    const value = union.get(row.id) || { ...row, vectorRank: null, bm25Rank: null, rrfScore: 0 };
    value[rankKey] = index + 1; value.rrfScore += 1 / (config.rrfK + index + 1); union.set(row.id,value);
  });
  return [...union.values()].map(row => ({ ...row, score: config.retrieval === 'vector' ? row.vectorScore : config.retrieval === 'keyword' ? row.keywordScore : config.fusion === 'rrf' ? row.rrfScore : row.score })).sort((a,b) => b.score - a.score || tie(a,b));
}
