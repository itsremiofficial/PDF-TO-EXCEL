import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cell } from './extract.ts';
import {
  buildExportFileName,
  buildRequiredExport,
  prepareRequiredSourceTable,
  REQUIRED_EXPORT_HEADERS,
} from './xlsx.ts';

const cell = (text: string): Cell => ({
  text,
  unsure: false,
  confidence: -1,
});

test('builds the required installer-payment column order and values', () => {
  const headers = [
    'TRAN. ID',
    'CUSTOMER ACCOUNT',
    'CUSTOMER A.C TITLE',
    'SERIAL NUMBER',
    'INSTALLER CODE',
  ];
  const rows = [[
    cell('231878'),
    cell('03075221707'),
    cell('RABNAWAZ KHAN'),
    cell('HL1060K6634086'),
    cell('MDNANK5YR3'),
  ]];

  const result = buildRequiredExport(headers, rows, [0, 1, 2, 3, 4]);

  assert.deepEqual(result.head, [...REQUIRED_EXPORT_HEADERS]);
  assert.deepEqual(result.body, [[
    'MDNANK5YR3',
    'RABNAWAZ KHAN',
    '03075221707',
    'HL1060K6634086',
    '231878',
    '',
    'UBANK',
  ]]);
});

test('matches punctuation variants and leaves deselected source fields empty', () => {
  const headers = [
    'TRAN ID',
    'REWARD ACCOUNT NUMBER',
    'CUSTOMER AC TITLE',
    'SERIAL NUMBER',
    'INSTALLER CODE',
  ];
  const rows = [[
    cell('231879'),
    cell('03074114332'),
    cell('ADIL NAZEER'),
    cell('HL1060K5280120'),
    cell('TTS3JETHHQ'),
  ]];

  const result = buildRequiredExport(headers, rows, [0, 1, 3, 4]);

  assert.deepEqual(result.body[0], [
    'TTS3JETHHQ',
    '',
    '03074114332',
    'HL1060K5280120',
    '231879',
    '',
    'UBANK',
  ]);
});

test('recognizes the expected 22-column report when its OCR headers are garbled', () => {
  const headers = Array.from({ length: 22 }, (_, i) => `Column ${i + 1}`);
  headers[2] = 'JIE';
  headers[8] = 'CUS CHER ACCOUNT';
  headers[9] = 'PN. TONER AC TITLE';
  headers[18] = 'NS EAL NUMER';
  headers[19] = 'NS TALLER LOD';

  const makeRow = (transactionId: string, account: string, title: string) => {
    const row = Array.from({ length: 22 }, () => cell(''));
    row[2] = cell(transactionId);
    row[8] = cell(account);
    row[9] = cell(title);
    row[18] = cell('HL1060K6634086');
    row[19] = cell('MDNANK5YR3');
    return row;
  };
  const table = prepareRequiredSourceTable({
    headers,
    rows: [
      makeRow('231878', '03075221707', 'RABNAWAZ KHAN'),
      makeRow('231879', 'PK90MEZN0061010115795363', 'MUHAMMAD UMAR SULTAN'),
      makeRow('231880', '03272728506', 'ABDUL SAMI'),
    ],
    source: 'ocr',
  });

  assert.deepEqual(table.headers, [
    'INSTALLER CODE',
    'CUSTOMER A.C TITLE',
    'CUSTOMER ACCOUNT',
    'SERIAL NUMBER',
    'TRAN. ID',
  ]);
  assert.deepEqual(table.rows[0].map(({ text }) => text), [
    'MDNANK5YR3',
    'RABNAWAZ KHAN',
    '03075221707',
    'HL1060K6634086',
    '231878',
  ]);
});

test('adds local date, time, and record count to the exported filename', () => {
  const generatedAt = new Date(2026, 8, 8, 14, 5, 9);

  assert.equal(
    buildExportFileName('test.pdf', 18, generatedAt),
    'test_2026-09-08_14-05-09_18-records.xlsx',
  );
  assert.equal(
    buildExportFileName('scan.PNG', 1, generatedAt),
    'scan_2026-09-08_14-05-09_1-record.xlsx',
  );
});
