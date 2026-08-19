import fs from 'node:fs/promises';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const outputDirectory = '/Users/dc-ext-09/personal/work_table/outputs/01a014e4-2b3b-7f43-9fa3-d1086c95abc9';
const outputPath = `${outputDirectory}/船期自动抓取模板.xlsx`;
const previewPath = `${outputDirectory}/template-preview.png`;

await fs.mkdir(outputDirectory, { recursive: true });

const workbook = Workbook.create();
const tracking = workbook.worksheets.add('船期追踪');
const rules = workbook.worksheets.add('船司规则');

tracking.showGridLines = false;
tracking.freezePanes.freezeRows(1);
tracking.getRange('A1:I4').values = [
  ['船司', '到港时间', '提单号', '柜号', '卸船时间', '船只状态', '最后更新时间', '备注', '进度'],
  ['', '', 'ONEY1234567890', 'ONEU1234567', '未卸船', '未到港未卸船', '', '示例数据，请替换为真实单号', '待查询'],
  ['地中海', '', 'MAEU1234567890', 'MSCU1234567', '未卸船', '未到港未卸船', '', 'MAEU + 地中海备注将使用 MSC 规则', '待查询'],
  ['', '', 'ZIMU1234567890', 'ZCSU1234567', '未卸船', '未到港未卸船', '', 'ZIM 将分别查询提单号和柜号', '待查询'],
];

tracking.getRange('A1:I1').format = {
  fill: '#0B3347',
  font: { bold: true, color: '#FFFFFF', size: 11 },
  verticalAlignment: 'center',
  horizontalAlignment: 'center',
  borders: { preset: 'outside', style: 'thin', color: '#0B3347' },
};
tracking.getRange('A1:I1').format.rowHeight = 30;
tracking.getRange('A2:I4').format = {
  font: { color: '#243D48', size: 10 },
  verticalAlignment: 'center',
  borders: { insideHorizontal: { style: 'thin', color: '#DCE5E5' } },
};
tracking.getRange('A2:I4').format.rowHeight = 28;
tracking.getRange('A2:I2').format.fill = '#F3F8F7';
tracking.getRange('A4:I4').format.fill = '#F3F8F7';
tracking.getRange('B2:B200').format.numberFormat = 'yyyy-mm-dd hh:mm';
tracking.getRange('G2:G200').format.numberFormat = 'yyyy-mm-dd hh:mm';
tracking.getRange('C2:D200').format.font = { name: 'DM Mono', color: '#24414E', size: 10 };
tracking.getRange('F2:F200').dataValidation = { rule: { type: 'list', values: ['未到港未卸船', '已到港未卸船', '已到港已卸船'] } };
tracking.getRange('I2:I200').dataValidation = { rule: { type: 'list', values: ['待查询', '查询中', '已完成', '失败'] } };
tracking.getRange('F2:F200').conditionalFormats.add('containsText', { text: '已到港已卸船', format: { fill: '#E7F4EC', font: { color: '#27724C' } } });
tracking.getRange('F2:F200').conditionalFormats.add('containsText', { text: '已到港未卸船', format: { fill: '#E9F5F8', font: { color: '#21789A' } } });
tracking.getRange('I2:I200').conditionalFormats.add('containsText', { text: '失败', format: { fill: '#FFF0E8', font: { color: '#BD6232', bold: true } } });
tracking.getRange('I2:I200').conditionalFormats.add('containsText', { text: '已完成', format: { fill: '#E8F4ED', font: { color: '#347653' } } });
tracking.getRange('A:A').format.columnWidth = 16;
tracking.getRange('B:B').format.columnWidth = 20;
tracking.getRange('C:D').format.columnWidth = 20;
tracking.getRange('E:E').format.columnWidth = 20;
tracking.getRange('F:F').format.columnWidth = 18;
tracking.getRange('G:G').format.columnWidth = 20;
tracking.getRange('H:H').format.columnWidth = 38;
tracking.getRange('I:I').format.columnWidth = 12;
tracking.getRange('H2:H200').format.wrapText = true;
tracking.tables.add('A1:I4', true, 'ShipmentTrackingTable').style = 'TableStyleMedium2';

rules.showGridLines = false;
rules.freezePanes.freezeRows(1);
rules.getRange('A1:F16').values = [
  ['提单前缀', '船司', '查询时去除前缀', '查询方式', '接入状态', '说明'],
  ['ONEY', '海洋网联 ONE', '是', '提单号', '待联调', ''],
  ['MAEU', '马士基 Maersk', '是', '提单号', '待联调', '船司列未标 MSC/地中海'],
  ['MAEU', '地中海 MSC', '否', '提单号', '待联调', '船司列注明 MSC/地中海'],
  ['EGLV', '长荣 Evergreen', '是', '提单号', '待联调', ''],
  ['OOLU', '东方海外 OOCL', '否', '提单号', '待联调', ''],
  ['WHLC', '万海 Wan Hai', '是', '提单号', '待联调', ''],
  ['ZIMU', '以星 ZIM', '否', '提单号 + 柜号', '待联调', '双查并合并，优先卸船时间'],
  ['MATS', '美森 Matson', '否', '提单号', '待联调', ''],
  ['YMJA', '阳明 Yang Ming', '否', '提单号', '待联调', ''],
  ['SML', '森罗 SM Line', '是', '提单号', '待联调', '按 3 位前缀识别'],
  ['CMDU', '达飞 CMA CGM', '是', '提单号', '待联调', ''],
  ['COSU', '中远海运 COSCO', '是', '提单号', '待联调', ''],
  ['HLCU', '赫伯罗特 Hapag-Lloyd', '是', '提单号', '待联调', ''],
  ['HDUJ', '合德', '否', '提单号', '待联调', ''],
  ['HDMU', '韩新海运 HMM', '是', '提单号', '待联调', ''],
];
rules.getRange('A1:F1').format = {
  fill: '#0B3347',
  font: { bold: true, color: '#FFFFFF', size: 11 },
  verticalAlignment: 'center',
  horizontalAlignment: 'center',
};
rules.getRange('A1:F1').format.rowHeight = 30;
rules.getRange('A2:F16').format = { font: { color: '#314B56', size: 10 }, verticalAlignment: 'center', borders: { insideHorizontal: { style: 'thin', color: '#E1E8E7' } } };
rules.getRange('A2:F16').format.rowHeight = 26;
rules.getRange('A2:F16').conditionalFormats.add('containsText', { text: '待联调', format: { fill: '#FFF4E8', font: { color: '#AD6639' } } });
rules.getRange('A:A').format.columnWidth = 13;
rules.getRange('B:B').format.columnWidth = 23;
rules.getRange('C:C').format.columnWidth = 18;
rules.getRange('D:D').format.columnWidth = 18;
rules.getRange('E:E').format.columnWidth = 13;
rules.getRange('F:F').format.columnWidth = 34;
rules.tables.add('A1:F16', true, 'CarrierRuleTable').style = 'TableStyleMedium2';

const check = await workbook.inspect({ kind: 'table', range: '船期追踪!A1:I4', include: 'values,formulas', tableMaxRows: 10, tableMaxCols: 10 });
console.log(check.ndjson);
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan' });
console.log(errors.ndjson);

const preview = await workbook.render({ sheetName: '船期追踪', range: 'A1:I4', scale: 2, format: 'png' });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewPath }));
