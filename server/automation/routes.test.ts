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

test('海洋网联路线只读取完整时间线并保持多式联运顺序', () => {
  const lines = [
    'Latest Place',
    'NASHVILLE, TN',
    'Place of Receipt',
    'YANTIAN, GUANGDONG, CHINA',
    'Place of Delivery',
    'NASHVILLE, TN, UNITED STATES',
    'Show Latest Event',
    'Actual Schedule',
    'YANTIAN, GUANGDONG, CHINA',
    'YICT (YANTIAN INTL CONTAINER TERMINAL)',
    'LOS ANGELES, CA, UNITED STATES',
    'WBCT (WEST BASIN CONTAINER TERMINAL)',
    'MEMPHIS, TN, UNITED STATES',
    'UP RAIL - MARION',
    'NASHVILLE, TN, UNITED STATES',
    'Customize Columns',
    'This website saves cookies in your computer. For more information, access the Cookies Notice page and Privacy Policy.',
  ];
  assert.equal(
    parseCarrierRoute({ carrierCode: 'ONE', text: lines.join('\n'), lines }),
    'YANTIAN, GUANGDONG, CHINA → LOS ANGELES, CA, UNITED STATES → MEMPHIS, TN, UNITED STATES → NASHVILLE, TN, UNITED STATES',
  );
});

test('路线解析器不把中远场站名称当成额外港口', () => {
  const lines = [
    '起始地: Xingang, CN',
    '目的港: Houston, US',
    '目的地: Houston, US-Barbours CutTerminal',
  ];
  assert.equal(
    parseCarrierRoute({ carrierCode: 'COSCO', text: lines.join('\n'), lines }),
    'Xingang, CN → Houston, US',
  );
});

test('地中海路线优先保留转运港顺序', () => {
  const lines = [
    'Shipped From',
    'Phnom Penh, KH',
    'Port of Load',
    'Phnom Penh, KH',
    'Port of Discharge',
    'New York, US',
    'Shipped To',
    'New York, US',
    'Transshipment',
    'Vung Tau, VN',
    'CONTAINERS',
  ];
  assert.equal(
    parseCarrierRoute({ carrierCode: 'MSC', text: lines.join('\n'), lines }),
    'Phnom Penh, KH → Vung Tau, VN → New York, US',
  );
});
