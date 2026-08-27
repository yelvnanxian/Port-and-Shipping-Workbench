import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = process.env.PORT_OPS_OUTPUT_DIR?.trim()
  ? path.resolve(process.env.PORT_OPS_OUTPUT_DIR.trim())
  : path.join(projectDirectory, 'outputs', '01a014e4-2b3b-7f43-9fa3-d1086c95abc9');
const outputPath = path.join(outputDirectory, '船期自动抓取模板.xlsx');
const previewPath = path.join(outputDirectory, 'template-preview.png');

const records = [
  ['东方海外', '', 'OOLU2171963250', 'OOCU7496887', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求 OOCL 官方接口', '待查询'],
  ['森罗', '', 'SMLMNJBD6A755700', 'SMCU1312616', '未卸船', '未到港未卸船', '', '', '真实订单，已接入官方三段追踪查询', '待查询'],
  ['以星', '', 'ZIMUXIA8569326', 'JXLU6447207', '未卸船', '未到港未卸船', '', '', '提单号和柜号分别查询后合并', '待查询'],
  ['万海', '', 'WHLC025G709663', 'WHSU8284656', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录风控原因', '待查询'],
  ['合德', '', 'HDUJGLA26BZ04040', 'SEKU6633329', '未卸船', '未到港未卸船', '', '', '真实订单，已接入官网解析器', '待查询'],
  ['海洋网联', '', 'ONEYSZPGD2137604', 'ONEU1925399', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录真实响应', '待查询'],
  ['美森', '', 'MATS7419163000', 'MATU2362806', '未卸船', '未到港未卸船', '', '', '真实订单，已接入官方公开接口', '待查询'],
  ['赫伯罗特', '', 'HLCUSHA2607BBGH4', 'HAMU1828139', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录风控原因', '待查询'],
  ['马士基', '', 'MAEU271552824', 'CICU6040856', '未卸船', '未到港未卸船', '', '', 'MAEU 固定对应马士基', '待查询'],
  ['长荣', '', 'EGLV146600523956', 'DFSU7042655', '未卸船', '未到港未卸船', '', '', '真实订单，已接入提单与货柜动态查询', '待查询'],
  ['COSCO', '', 'COSU6503130310', 'OOCU0872637', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录真实响应', '待查询'],
  ['达飞', '', 'CMDUNGP4005669', 'TDSU8099791', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录风控原因', '待查询'],
  ['地中海', '', 'MEDUPN815212', 'MSMU4939122', '未卸船', '未到港未卸船', '', '', 'MEDU 固定对应地中海', '待查询'],
  ['阳明', '', 'YMJAW239076615', 'YMLU3562849', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录真实响应', '待查询'],
  ['韩新海运', '', 'HDMUNBOZWS646200', 'HMMU9066040', '未卸船', '未到港未卸船', '', '', '真实订单，运行时请求官网并记录真实响应', '待查询'],
];

const ruleRows = [
  ['ONEY', '海洋网联', '是', '提单号', '官网风控阻断', '已请求真实官网并记录响应'],
  ['MAEU', '马士基', '是', '提单号', '动态页面响应', '固定对应马士基'],
  ['MEDU', '地中海', '否', '提单号', '动态页面响应', '固定对应地中海'],
  ['EGLV', '长荣', '是', '提单号', '已接入', '提单查询 + 货柜动态'],
  ['OOLU', '东方海外', '否', '提单号', '已接入', '官方接口异常时记录原始错误'],
  ['WHLC', '万海', '是', '提单号', '官网风控阻断', '真实请求返回 HTTP 412'],
  ['ZIMU', '以星', '否', '提单号 + 柜号', '官网风控阻断', '双查并合并，优先卸船时间'],
  ['MATS', '美森', '否', '提单号', '已接入', '官方公开查询接口'],
  ['YMJA', '阳明', '否', '提单号', '动态页面响应', '已请求真实官网并记录响应'],
  ['SML', '森罗', '是', '提单号', '已接入', '识别 SML，官网查询移除 SMLM'],
  ['CMDU', '达飞', '是', '提单号', '官网风控阻断', '真实请求返回 HTTP 403'],
  ['COSU', '中远海运', '是', '提单号', '动态页面响应', '已请求真实官网并记录响应'],
  ['HLCU', '赫伯罗特', '是', '提单号', '官网风控阻断', '真实请求返回 HTTP 403'],
  ['HDUJ', '合德', '否', '提单号', '已接入', '官方 HTML 时间线解析'],
  ['HDMU', '韩新海运', '是', '提单号', '动态页面响应', '已请求真实官网并记录响应'],
];

await fs.mkdir(outputDirectory, { recursive: true });
const workbook = Workbook.create();
const tracking = workbook.worksheets.add('船期追踪');
const rules = workbook.worksheets.add('船司规则');

tracking.showGridLines = false;
tracking.freezePanes.freezeRows(1);
tracking.getRange('A1:J16').values = [
  ['船司', '到港时间', '提单号', '柜号', '卸船时间', '船只状态', '人工标记', '最后更新时间', '备注', '进度'],
  ...records,
];
tracking.getRange('A1:J1').format = { fill: '#0B3347', font: { bold: true, color: '#FFFFFF', size: 11 }, verticalAlignment: 'center', horizontalAlignment: 'center', borders: { preset: 'outside', style: 'thin', color: '#0B3347' } };
tracking.getRange('A1:J1').format.rowHeight = 30;
tracking.getRange('A2:J16').format = { font: { color: '#243D48', size: 10 }, verticalAlignment: 'center', borders: { insideHorizontal: { style: 'thin', color: '#DCE5E5' } } };
tracking.getRange('A2:J16').format.rowHeight = 30;
for (let row = 2; row <= 16; row += 2) tracking.getRange(`A${row}:J${row}`).format.fill = '#F3F8F7';
tracking.getRange('B2:B200').format.numberFormat = 'yyyy-mm-dd hh:mm';
tracking.getRange('E2:E200').format.numberFormat = 'yyyy-mm-dd hh:mm';
tracking.getRange('H2:H200').format.numberFormat = 'yyyy-mm-dd hh:mm';
tracking.getRange('C2:D200').format.font = { name: 'DM Mono', color: '#24414E', size: 10 };
tracking.getRange('F2:F200').dataValidation = { rule: { type: 'list', values: ['未到港未卸船', '已到港未卸船', '已到港已卸船'] } };
tracking.getRange('J2:J200').dataValidation = { rule: { type: 'list', values: ['待查询', '查询中', '已完成', '失败'] } };
tracking.getRange('F2:F200').conditionalFormats.add('containsText', { text: '已到港已卸船', format: { fill: '#E7F4EC', font: { color: '#27724C' } } });
tracking.getRange('F2:F200').conditionalFormats.add('containsText', { text: '已到港未卸船', format: { fill: '#E9F5F8', font: { color: '#21789A' } } });
tracking.getRange('J2:J200').conditionalFormats.add('containsText', { text: '失败', format: { fill: '#FFF0E8', font: { color: '#BD6232', bold: true } } });
tracking.getRange('J2:J200').conditionalFormats.add('containsText', { text: '已完成', format: { fill: '#E8F4ED', font: { color: '#347653' } } });
for (const [column, width] of Object.entries({ A: 16, B: 20, C: 20, D: 18, E: 20, F: 18, G: 14, H: 20, I: 36, J: 12 })) tracking.getRange(`${column}:${column}`).format.columnWidth = width;
tracking.getRange('I2:I200').format.wrapText = true;
tracking.tables.add('A1:J16', true, 'ShipmentTrackingTable').style = 'TableStyleMedium2';

rules.showGridLines = false;
rules.freezePanes.freezeRows(1);
rules.getRange('A1:F16').values = [['提单前缀', '船司', '查询时去除前缀', '查询方式', '接入状态', '说明'], ...ruleRows];
rules.getRange('A1:F1').format = { fill: '#0B3347', font: { bold: true, color: '#FFFFFF', size: 11 }, verticalAlignment: 'center', horizontalAlignment: 'center' };
rules.getRange('A1:F1').format.rowHeight = 30;
rules.getRange('A2:F16').format = { font: { color: '#314B56', size: 10 }, verticalAlignment: 'center', borders: { insideHorizontal: { style: 'thin', color: '#E1E8E7' } } };
rules.getRange('A2:F16').format.rowHeight = 26;
rules.getRange('E2:E16').conditionalFormats.add('containsText', { text: '已接入', format: { fill: '#E7F4EC', font: { color: '#27724C' } } });
rules.getRange('E2:E16').conditionalFormats.add('containsText', { text: '官网风控阻断', format: { fill: '#FFF0E8', font: { color: '#BD6232' } } });
rules.getRange('E2:E16').conditionalFormats.add('containsText', { text: '动态页面响应', format: { fill: '#EAF1F7', font: { color: '#47758E' } } });
for (const [column, width] of Object.entries({ A: 13, B: 19, C: 18, D: 18, E: 13, F: 34 })) rules.getRange(`${column}:${column}`).format.columnWidth = width;
rules.tables.add('A1:F16', true, 'CarrierRuleTable').style = 'TableStyleMedium2';

const preview = await workbook.render({ sheetName: '船期追踪', range: 'A1:J16', scale: 1.4, format: 'png' });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewPath }));
