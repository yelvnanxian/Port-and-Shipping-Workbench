import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCarrierRoute } from './routes/index.js';

test('各船司路线解析器按官网地点字段输出完整线路', () => {
  const lines = [
    'Port of Loading: YANTIAN, GUANGDONG, CHINA',
    'Vessel Arrival at Port of Discharge',
    'Port of Discharge: LOS ANGELES, CA, UNITED STATES',
    'Place of Delivery: MEMPHIS, TN, UNITED STATES',
  ];
  assert.equal(
    parseCarrierRoute({ carrierCode: 'OOCL', text: lines.join('\n'), lines }),
    'YANTIAN, GUANGDONG, CHINA → LOS ANGELES, CA, UNITED STATES → MEMPHIS, TN, UNITED STATES',
  );
  assert.equal(
    parseCarrierRoute({ carrierCode: 'HAPAG', text: lines.join('\n'), lines }),
    'YANTIAN, GUANGDONG, CHINA → LOS ANGELES, CA, UNITED STATES → MEMPHIS, TN, UNITED STATES',
  );
});

test('路线解析器支持中文港口并去重重复事件节点', () => {
  const lines = [
    '装货港：盐田，广东，中国',
    '盐田，广东，中国',
    '卸货港：洛杉矶，加利福尼亚，美国',
    '目的地：孟菲斯，田纳西，美国',
  ];
  assert.equal(
    parseCarrierRoute({ carrierCode: 'COSCO', text: lines.join('\n'), lines }),
    '盐田，广东，中国 → 洛杉矶，加利福尼亚，美国 → 孟菲斯，田纳西，美国',
  );
});
