import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTrackingError, trackingError } from './errors.js';

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
