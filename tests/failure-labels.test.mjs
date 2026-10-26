import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerError } from '../backend/providers.mjs';
import { resultPresentation, assessmentWorkbook } from '../backend/assessment.mjs';

test('网络、超时与引用校验错误在依据、详细说明和生成错误中一致显示', () => {
  for (const [errorCode, label] of [['MODEL_EVIDENCE_INVALID','引用校验失败'],['MODEL_NETWORK_ERROR','网络连接异常'],['MODEL_TIMEOUT','调用超时']]) {
    const row={status:'failed',answer:'生成失败：具体原因',error:'具体原因',errorCode};
    const shown=resultPresentation(row);
    assert.equal(shown.basis,label);assert.equal(shown.details,label);
    assert.ok(shown.error.startsWith(label));assert.ok(shown.answer.includes(label));
    assert.deepEqual(resultPresentation(shown),shown);assert.equal(row.answer,'生成失败：具体原因');
  }
  for(const code of ['MODEL_AUTH_FAILED','MODEL_RATE_LIMIT','MODEL_SERVICE_ERROR','MODEL_OUTPUT_FORMAT','ASSESSMENT_CANCELLED'])
    assert.equal(resultPresentation({status:'failed',errorCode:code,error:'具体原因'}).basis,'调用失败');
});
test('历史引用错误可识别，含糊服务异常不猜测为网络问题',()=>{
  assert.equal(resultPresentation({status:'failed',answer:'生成失败：第1项判断的第1条引用不属于候选 C 列原文，已拒绝保存，请重试该题。'}).basis,'引用校验失败');
  assert.equal(resultPresentation({status:'failed',error:'模型请求已取消或超时，请稍后重试。'}).basis,'调用超时');
  assert.equal(resultPresentation({status:'failed',errorCode:'MODEL_CANCELLED',error:'模型请求已取消。'}).basis,'调用失败');
  assert.equal(resultPresentation({status:'failed',error:'模型服务未返回有效结果，请检查网络、模型地址和服务状态。'}).basis,'调用失败');
});
test('从嵌套与聚合异常识别连接故障及超时，取消和HTTP服务异常分开',()=>{
  const cases=[
    [{cause:{cause:{code:'ECONNRESET'}}},'MODEL_NETWORK_ERROR','网络连接异常'],
    [new TypeError('fetch failed'),'MODEL_NETWORK_ERROR','网络连接异常'],
    [new AggregateError([{code:'ENOTFOUND'}]),'MODEL_NETWORK_ERROR','网络连接异常'],
    [{lastError:{cause:{code:'UND_ERR_HEADERS_TIMEOUT'}}},'MODEL_TIMEOUT','调用超时'],
    [{cause:{name:'TimeoutError'}},'MODEL_TIMEOUT','调用超时'],
    [{status:504},'MODEL_TIMEOUT','调用超时'],
    [{name:'AbortError'},'MODEL_CANCELLED','模型请求已取消'],
    [{status:429,cause:{code:'ECONNRESET'}},'MODEL_RATE_LIMIT','限流'],
    [{statusCode:500},'MODEL_SERVICE_ERROR','模型服务'],
  ];
  for(const [raw,code,text]of cases){const safe=providerError(raw);assert.equal(safe.code,code);assert.ok(safe.message.includes(text));}
});
test('导出三类失败标签与页面一致，原文件不覆盖',async()=>{
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory=await mkdtemp(resolve('.test-data/failure-labels-'));
  assert.equal(spawnSync('python',['-X','utf8','tests/create_assessment_fixtures.py',directory]).status,0);
  const input=join(directory,'input.xlsx');const output=join(directory,'export.xlsx');
  const original=await readFile(input);const parsed=await assessmentWorkbook('python',['parse',input]);
  const labels=['引用校验失败','网络连接异常','调用超时'];
  const codes=['MODEL_EVIDENCE_INVALID','MODEL_NETWORK_ERROR','MODEL_TIMEOUT'];
  const results=[3,4,5].map((line,i)=>resultPresentation({...parsed.records.find(row=>row.line===line),sheet:'审核检查单',line,status:'failed',answer:'生成失败：具体原因',error:'具体原因',errorCode:codes[i],gap:'',sources:[]}));
  await assessmentWorkbook('python',['export',input,output],{results});
  const checked=spawnSync('python',['-X','utf8','-c',`import sys,json,openpyxl
w=openpyxl.load_workbook(sys.argv[1]);s=w['审核检查单'];labels=json.loads(sys.argv[2])
for row,label in zip([3,4,5],labels):
 assert s[f'D{row}'].value==label
 assert s[f'E{row}'].value==label
 assert label in s[f'C{row}'].value
w.close()`,output,JSON.stringify(labels)],{encoding:'utf8'});
  assert.equal(checked.status,0,checked.stdout+checked.stderr);assert.deepEqual(await readFile(input),original);
});
