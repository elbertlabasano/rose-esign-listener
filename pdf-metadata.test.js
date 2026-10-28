'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePurchaseOrder, parseDate, safeFilename, extractPdfMetadata } = require('./pdf-metadata');

function sampleItems() {
  return [
    ['Date', 285, 65, 25], ['P.O. No.', 355, 65, 40], ['P.R. No.', 425, 65, 40], ['Expected', 505, 65, 50],
    ['10/22/2026', 280, 90, 50], ['31164', 360, 90, 30], ['10/24/2026', 500, 90, 50],
    ['Vendor', 30, 120, 40], ['Ship To', 280, 120, 45],
    ['Coca-Cola Europacific Philippines, Inc.', 25, 145, 210], ['Tagum 7 Pag Asa', 280, 145, 100],
    ['Item', 40, 200, 30], ['Description', 150, 200, 60],
    ['108778', 25, 220, 40], ['290ML Coke', 120, 220, 80]
  ].map(([text, x, y, width]) => ({ text, x, y, width }));
}

test('extracts separate header cells and ignores Expected date and item rows', () => {
  const metadata = parsePurchaseOrder(sampleItems());
  assert.deepEqual(metadata, {
    po_no: '31164', vendor: 'Coca-Cola Europacific Philippines, Inc.', document_date: '2026-10-22',
    ship_to: 'Tagum 7 Pag Asa', document_title: '31164-Coca-Cola Europacific Philippines, Inc.',
    filename: '31164-Coca-Cola Europacific Philippines, Inc.pdf'
  });
});

test('handles split PO labels, multiline vendor and missing fields', () => {
  const items = sampleItems().filter((item) => item.text !== 'P.O. No.');
  items.push({ text: 'P.O.', x: 355, y: 65, width: 20 }, { text: 'No.', x: 377, y: 65, width: 18 });
  items.push({ text: 'Davao Branch', x: 25, y: 160, width: 70 });
  assert.equal(parsePurchaseOrder(items).vendor, 'Coca-Cola Europacific Philippines, Inc. Davao Branch');
  assert.throws(() => parsePurchaseOrder(items.filter((item) => item.text !== 'Ship To')), /Missing PDF field label/);
  assert.throws(() => parsePurchaseOrder([]), /Missing PDF field label/);
});

test('validates calendar dates and sanitizes Windows upload filenames', () => {
  assert.equal(parseDate('2/29/2024'), '2024-02-29');
  assert.throws(() => parseDate('2/29/2026'), /Invalid PO date/);
  assert.throws(() => parseDate('13/1/2026'), /Invalid PO date/);
  assert.equal(safeFilename('31164-Vendor / Branch'), '31164-Vendor _ Branch.pdf');
});

// A real, minimal PDF containing selectable text in the same table layout.
function samplePdf() {
  const stream = sampleItems().map((item) => {
    const escaped = item.text.replace(/[\\()]/g, '\\$&');
    return `BT /F1 10 Tf ${item.x} ${800 - item.y} Td (${escaped}) Tj ET`;
  }).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('reads actual PDF bytes through PDF.js', async () => {
  const metadata = await extractPdfMetadata(samplePdf());
  assert.equal(metadata.po_no, '31164');
  assert.equal(metadata.vendor, 'Coca-Cola Europacific Philippines, Inc.');
  assert.equal(metadata.document_date, '2026-10-22');
  assert.equal(metadata.ship_to, 'Tagum 7 Pag Asa');
});
