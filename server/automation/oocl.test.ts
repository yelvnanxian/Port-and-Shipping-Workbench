import assert from 'node:assert/strict';
import test from 'node:test';
import { OoclTrackingProvider, parseOoclDate, parseOoclTrackingResponse } from './oocl.js';
import { resolveCarrierRule } from './carriers.js';

test('OOCL 无时区日期按北京时间解析', () => {
  assert.equal(parseOoclDate('18 Aug 2026 14:30')?.toISOString(), '2026-08-18T06:30:00.000Z');
  assert.equal(parseOoclDate('20260818143000.000')?.toISOString(), '2026-08-18T06:30:00.000Z');
});

test('OOCL 响应优先 ATA 并识别卸船事件', () => {
  const result = parseOoclTrackingResponse({
    result: {
      responseCode: 'SVC_OK_001',
      searchResultRecord: {
        billOfLadingNumber: 'OOLU2171963250',
        containers: [{
          containerNumber: 'OOCU7496887',
          latestEvent: { event: 'Container discharged from vessel', time: '18 Aug 2026 18:20', location: 'Shanghai' },
          routing: {
            lastPOD: 'Shanghai',
            lastPODTime: '18 Aug 2026 12:00',
            lastPODTimeIndicator: '(ACTUAL)',
          },
        }],
      },
    },
  }, 'OOCU7496887');

  assert.equal(result.arrivalKind, 'ATA');
  assert.equal(result.arrivalTime?.toISOString(), '2026-08-18T04:00:00.000Z');
  assert.equal(result.dischargeTime?.toISOString(), '2026-08-18T10:20:00.000Z');
  assert.equal(result.arrived, true);
});

test('OOCL 官方错误响应不会生成假时间', () => {
  assert.throws(
    () => parseOoclTrackingResponse({ result: { responseCode: 'SVC_ERR_001', exceptionCode: 'UPSTREAM_ERROR' } }),
    /官方查询暂不可用.*responseCode=SVC_ERR_001.*exceptionCode=UPSTREAM_ERROR/,
  );
});

test('OOCL 同一提单有多个柜时只取指定柜的卸船时间', () => {
  const result = parseOoclTrackingResponse({
    result: {
      responseCode: 'SVC_OK_001',
      searchResultRecord: {
        containers: [
          { containerNumber: 'OTHER1234567', latestEvent: { event: 'Discharged', time: '18 Aug 2026 08:00' } },
          { containerNumber: 'OOCU7496887', latestEvent: { event: 'Loaded on vessel', time: '18 Aug 2026 09:00' }, routing: { eta: '20 Aug 2026 10:00' } },
        ],
      },
    },
  }, 'OOCU7496887');
  assert.equal(result.dischargeTime, null);
  assert.equal(result.arrivalKind, 'ETA');
});

test('OOCL Provider 保留 OOLU 前缀并正确编码请求', async () => {
  let requested = '';
  const fetcher: typeof fetch = async (input) => {
    requested = input.toString();
    return new Response(JSON.stringify({
      result: {
        responseCode: 'SVC_OK_001',
        searchResultRecord: {
          containers: [{ containerNumber: 'OOCU7496887', routing: { eta: '2026-08-20 09:00' } }],
        },
      },
    }), { headers: { 'content-type': 'application/json' } });
  };
  const rule = resolveCarrierRule({ billNo: 'OOLU2171963250', carrierHint: '东方海外' });
  const result = await new OoclTrackingProvider(fetcher).query({
    rule,
    originalBillNo: 'OOLU2171963250',
    queryBillNo: 'OOLU2171963250',
    containerNo: 'OOCU7496887',
    queryType: 'bill',
  });

  assert.match(decodeURIComponent(requested), /paramString=blNumber=OOLU2171963250/);
  assert.equal(result.arrivalKind, 'ETA');
});
