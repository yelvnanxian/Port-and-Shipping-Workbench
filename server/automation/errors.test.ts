import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTrackingError, isReferenceMissFailure, trackingError } from './errors.js';

test('结构化官网异常保留分类和原始原因', () => {
  const failure = classifyTrackingError(trackingError('官网接口异常', '美森官方接口 HTTP 422：errorCode=CS.0004'));
  assert.deepEqual(failure, { category: '官网接口异常', reason: '美森官方接口 HTTP 422：errorCode=CS.0004' });
});

test('Cloudflare 响应自动归类为验证码或风控', () => {
  const failure = classifyTrackingError(new Error('ZIM 官网返回 Cloudflare HTTP 403'));
  assert.equal(failure.category, '验证码或风控');
});

test('OOCL 业务错误码归类为官网接口异常而非订单号失败', () => {
  const failure = classifyTrackingError(new Error('OOCL 官方查询暂不可用（responseCode=SVC_ERR_001）'));
  assert.equal(failure.category, '官网接口异常');
});

test('只有明确无结果才允许从提单切换到柜号', () => {
  assert.equal(isReferenceMissFailure({ category: '订单号验证失败', reason: '官网明确未找到该提单号' }), true);
  assert.equal(isReferenceMissFailure({ category: '解析失败', reason: '官网未返回对应货物记录' }), true);
  assert.equal(isReferenceMissFailure({ category: '订单号验证失败', reason: '提单号格式不正确' }), false);
  assert.equal(isReferenceMissFailure({ category: '订单号验证失败', reason: '官网返回柜号与输入不一致' }), false);
  assert.equal(isReferenceMissFailure({ category: '解析失败', reason: '页面未显示查询号码，拒绝写入' }), false);
  assert.equal(isReferenceMissFailure({ category: '订单号验证失败', reason: '结果未包含输入柜号，将改用柜号查询核验' }), true);
  assert.equal(isReferenceMissFailure({ category: '验证码或风控', reason: '需要人工验证' }), false);
});
