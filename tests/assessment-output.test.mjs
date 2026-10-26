import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderClient } from '../backend/providers.mjs';
import { groundedResult, normalizeAssessmentOutput, decodeAssessmentOutput } from '../backend/assessment-output.mjs';

const config = { provider: 'bailian', modelId: 'qwen-max', name: 'qwen3.8-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
const candidates = [{ id: 'real-id', answer: '已建立质量手册，由负责人批准。', sheet: 'QSA', line: 4, questionCell: 'B4', answerCell: 'C4' }];
const good = { parts: [{ requirement: '制定手册', status: 'supported', citations: [{ evidenceId: 'real-id', quote: '已建立质量手册，由负责人批准。' }] }] };
function fixture(responses) {
  const calls = [];
  const client = createProviderClient({ fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next.http) return Response.json({ error: { message: 'PRIVATE_TOKEN_AND_RESPONSE', type: 'invalid_request_error' } }, { status: next.http });
    return Response.json({ id: 'response', object: 'chat.completion', created: 1, model: 'qwen-max', choices: [{ index: 0, message: { role: 'assistant', content: typeof next.content === 'string' ? next.content : JSON.stringify(next.content) }, finish_reason: next.finish || 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  } });
  return { calls, client };
}
test('旧qwen-max按实际ID使用JSON Object，字段异常后仅纠正一次并校验原文', async () => {
  const { client, calls } = fixture([{ content: { parts: [{ requirement: '手册', status: 'supported', citations: 'PRIVATE_TOKEN_AND_RESPONSE' }] } }, { content: good }]);
  const result = await client.assess(config, 'fixture-only', '是否制定手册', candidates);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.match(calls[0].messages[0].content, /JSON结构规则/);
  assert.match(calls[1].messages[0].content, /parts\[0\].citations/);
  assert.equal(JSON.stringify(calls[1].messages).includes('PRIVATE_TOKEN_AND_RESPONSE'), false);
  assert.equal(result.assessmentMeta.attempts, 2);
  assert.equal(groundedResult(result, candidates).status, 'direct');
});
test('支持结构输出的实际型号发送严格Schema', async () => {
  const { client, calls } = fixture([{ content: good }]);
  await client.assess({ ...config, modelId: 'qwen3.7-max' }, '', '手册', candidates);
  const format = calls[0].response_format;
  assert.equal(format.type, 'json_schema'); assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.properties.requirements.items.required, ['id','requirement','status']);
});
test('非法JSON、截断和持续字段错误保留准确原因，不输出服务私有内容', async () => {
  for (const response of [{ content: 'PRIVATE_TOKEN_AND_RESPONSE' }, { content: '{', finish: 'length' }, { content: { parts: [null] } }]) {
    const { client, calls } = fixture([response]);
    await assert.rejects(client.assess(config, '', '手册', candidates), error => {
      assert.match(error.code, /^MODEL_OUTPUT_/); assert.equal(error.attempts, 2);
      assert.equal(error.message.includes('PRIVATE_TOKEN_AND_RESPONSE'), false);
      assert.ok(error.issues.length); return true;
    });
    assert.equal(calls.length, 2); assert.equal(calls[1].max_tokens, 7000);
  }
});
test('伪造引用与非原文纠正后仍不合格时必须失败，缺少依据正常返回missing', async () => {
  const bad = structuredClone(good); bad.parts[0].citations[0].quote = '通过ISO认证';
  const { client, calls } = fixture([{ content: bad }]);
  await assert.rejects(client.assess(config, '', '手册', candidates), error => error.code === 'MODEL_EVIDENCE_INVALID' && error.attempts === 2);
  assert.equal(calls.length, 2);
  const missing = fixture([{ content: { parts: [{ requirement: '认证', status: 'missing', citations: [] }] } }]);
  assert.equal(groundedResult(await missing.client.assess(config, '', '认证', candidates), candidates).status, 'missing');
  assert.equal(missing.calls.length, 1);
});
test('鉴权、限流与请求错误不进入格式重试，取消后不发新请求', async () => {
  for (const [http, code] of [[401,'MODEL_AUTH_FAILED'],[429,'MODEL_RATE_LIMIT'],[400,'MODEL_REQUEST_INVALID']]) {
    const {client,calls} = fixture([{http}]);
    await assert.rejects(client.assess(config, '', '手册', candidates), error => error.code === code && !error.message.includes('PRIVATE_TOKEN_AND_RESPONSE'));
    assert.equal(calls.length,1);
  }
  const f=fixture([{content:good}]);
  await assert.rejects(f.client.assess(config, '', '手册', candidates, AbortSignal.abort())); assert.equal(f.calls.length,0);
});
test('仅容器形状可无损兼容，无法确定的引用和缺失字段不猜测', () => {
  const single = structuredClone(good); single.parts[0].citations=single.parts[0].citations[0];
  assert.equal(groundedResult(single,candidates).status,'direct');
  for (const part of [null, { requirement:'手册',status:'supported',citations:'1' }, { requirement:'手册',status:'支持',citations:[] }, { requirement:'手册',status:'supported',citations:[null] }])
    assert.throws(()=>normalizeAssessmentOutput({parts:[part]}),error=>error.code==='MODEL_OUTPUT_FORMAT');
  assert.throws(()=>groundedResult({parts:[{requirement:'手册',status:'missing',citations:good.parts[0].citations}]},candidates),error=>error.code==='MODEL_EVIDENCE_INVALID');
});

test('平行判断与引用列表严格按编号关联；孤立引用和重复编号拒绝', async () => {
  const wire = { requirements: [{id:'r1',requirement:'手册',status:'supported'},{id:'r2',requirement:'认证',status:'missing'}], citations:[{requirementId:'r1',evidenceId:'real-id',quote:candidates[0].answer}] };
  const f=fixture([{content:wire}]);
  assert.equal(groundedResult(await f.client.assess(config,'','手册及认证',candidates),candidates).status,'partial');
  const bad=structuredClone(wire);bad.citations[0].requirementId='unknown';
  assert.throws(()=>decodeAssessmentOutput(bad),error=>error.code==='MODEL_OUTPUT_FORMAT');
  const duplicate=structuredClone(wire);duplicate.requirements[1].id='r1';assert.throws(()=>decodeAssessmentOutput(duplicate));
});
