import http from 'node:http';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export function createTestVault() {
  const key = randomBytes(32);
  return {
    async encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'); },
    async decrypt(value) { const raw = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); cipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8'); },
  };
}
export async function startMockProvider() {
  const requests = [];
  const behavior = { failEmbeddings: false, slowMs: 0, wrongDimensions: false, failAssessment: false, invalidCitation: false, assessmentDelay: 0 };
  function vector(text, size = 8) {
    const result = Array(size).fill(0.001);
    const index = /手册|负责人批准/.test(text) ? 0 : /质量目标|统计目标/.test(text) ? 1 : /隐藏/.test(text) ? 2 : /记录/.test(text) ? 3 : 4;
    result[index % size] += 1;
    return result;
  }
  const server = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}'); const path = request.url;
    requests.push({ path, body });
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.headers.authorization === 'Bearer mock-rejected' || body.model?.includes('unauthorized')) return send(401, { error: { message: 'mock-rejected should never be exposed', type: 'invalid_api_key' } });
    if (body.model?.includes('missing-model')) return send(404, { error: { message: 'missing' } });
    if (path.endsWith('/embeddings')) {
      if (behavior.failEmbeddings || body.model?.includes('fail-embedding')) return send(400, { error: { message: 'bad input' } });
      if (behavior.slowMs || body.model?.includes('timeout')) await new Promise(done => setTimeout(done, behavior.slowMs || 300));
      const values = Array.isArray(body.input) ? body.input : [body.input];
      const size = behavior.wrongDimensions || body.model?.includes('bad-dimension') ? 7 : body.dimensions || 8;
      const data = values.map((value, index) => ({ index, object: 'embedding', embedding: vector(value, size) }));
      if (body.model?.includes('reverse')) data.reverse();
      if (body.model?.includes('duplicate-index') && data.length > 1) data[1].index = data[0].index;
      return send(200, { object: 'list', data, model: body.model, usage: { prompt_tokens: values.length * 10, total_tokens: values.length * 10 } });
    }
    if (path.endsWith('/chat/completions')) {
      const assessment = body.messages?.some(message => String(message.content).includes('供应商审核证据选择器'));
      let content = 'OK';
      if (assessment) {
        if (behavior.assessmentDelay) await new Promise(done => setTimeout(done, behavior.assessmentDelay));
        const data = JSON.parse(body.messages.find(message => message.role === 'user').content);
        if (behavior.failAssessment || (behavior.failAssessmentMatch && data.question.includes(behavior.failAssessmentMatch))) return send(429, { error: { message: 'mock-secret-fixture private failure' } });
        const candidate = data.evidence[0];
        const unrelated = /火星/.test(data.question);
        content = JSON.stringify({ requirements: [{ id: 'r1', requirement: data.question, status: unrelated ? 'missing' : 'supported' }, ...(/今年/.test(data.question) ? [{ id: 'r2', requirement: '今年具体达成值', status: 'missing' }] : [])], citations: unrelated ? [] : [{ requirementId: 'r1', evidenceId: behavior.invalidCitation ? 'invented' : candidate.evidenceId, quote: candidate.answer }] });
      }
      return send(200, { id: 'mock-chat', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } });
    }
    if (path.endsWith('/rerank') || path.endsWith('/text-rerank')) {
      const documents = body.documents || body.input.documents;
      const results = documents.map((text, index) => ({ index, relevance_score: /手册|质量目标/.test(text) ? 0.96 : 0.1 })).sort((a, b) => b.relevance_score - a.relevance_score).slice(0, body.top_n || body.parameters?.top_n || documents.length);
      return send(200, path.endsWith('/text-rerank') ? { output: { results }, usage: { total_tokens: 1 } } : { results });
    }
    send(404, { error: { message: 'unknown endpoint' } });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, behavior, close: () => new Promise(done => server.close(done)) };
}
