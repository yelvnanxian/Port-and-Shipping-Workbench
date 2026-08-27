import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultWorkbookPath = path.join(projectDirectory, 'outputs', '01a014e4-2b3b-7f43-9fa3-d1086c95abc9', '船期自动抓取模板.xlsx');
const workbookPath = path.resolve(process.argv[2] || defaultWorkbookPath);
const outputDirectory = path.dirname(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));

const summary = await workbook.inspect({ kind: 'sheet,table', maxChars: 5000, tableMaxRows: 4, tableMaxCols: 10 });
console.log(summary.ndjson);
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: 'final formula error scan' });
console.log(errors.ndjson);

for (const sheetName of ['船期追踪', '船司规则']) {
  const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1.5, format: 'png' });
  await fs.writeFile(`${outputDirectory}/${sheetName}-verification.png`, new Uint8Array(await preview.arrayBuffer()));
}
