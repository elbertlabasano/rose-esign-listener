'use strict';

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function parseDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error(`Invalid PO date: ${value}`);
  const [, month, day, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid PO date: ${value}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function safeFilename(title) {
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!safe || safe.length > 200) throw new Error('Extracted PO filename is empty or too long.');
  return `${safe}.pdf`;
}

// Read table cells by their position, so date/PO/expected-date columns don't mix.
function parsePurchaseOrder(items) {
  const rows = [];
  for (const item of items.filter((item) => normalize(item.text)).sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = rows.find((row) => Math.abs(row.y - item.y) <= 3);
    if (!row) rows.push(row = { y: item.y, items: [] });
    row.items.push({ ...item, text: normalize(item.text) });
  }
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  function anchor(pattern) {
    for (const row of rows) {
      for (let start = 0; start < row.items.length; start++) {
        for (let end = start; end < Math.min(start + 8, row.items.length); end++) {
          const parts = row.items.slice(start, end + 1);
          if (pattern.test(parts.map((part) => part.text).join(' '))) {
            return { x: parts[0].x, right: parts.at(-1).x + parts.at(-1).width, y: row.y };
          }
        }
      }
    }
    throw new Error(`Missing PDF field label: ${pattern}`);
  }
  const date = anchor(/^Date$/i);
  const po = anchor(/^P\s*\.?\s*O\s*\.?\s*No\s*\.?$/i);
  const pr = anchor(/^P\s*\.?\s*R\s*\.?\s*No\s*\.?$/i);
  const vendor = anchor(/^Vendor$/i);
  const ship = anchor(/^Ship\s+To$/i);
  const item = anchor(/^Item$/i);
  const center = (a) => (a.x + a.right) / 2;
  const datePoBoundary = (center(date) + center(po)) / 2;
  const poPrBoundary = (center(po) + center(pr)) / 2;
  const vendorShipBoundary = ship.x - 10;
  function cell(label, left, right, bottom, multiline = false) {
    const lines = rows.filter((row) => row.y > label.y + 3 && row.y < bottom)
      .map((row) => normalize(row.items.filter((part) => {
        const middle = part.x + part.width / 2;
        return middle >= left && middle < right;
      }).map((part) => part.text).join(' ')))
      .filter(Boolean);
    if (!lines.length) throw new Error('Empty PDF field below label.');
    return multiline ? lines.join(' ') : lines[0];
  }
  const poNo = cell(po, datePoBoundary, poPrBoundary, Math.min(vendor.y, ship.y));
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(poNo)) throw new Error(`Invalid PO number: ${poNo}`);
  const vendorName = cell(vendor, -Infinity, vendorShipBoundary, item.y, true);
  const shipTo = cell(ship, vendorShipBoundary, Infinity, item.y, true);
  const documentDate = parseDate(cell(date, date.x - 60, datePoBoundary, Math.min(vendor.y, ship.y)));
  const title = `${poNo}-${vendorName}`;
  return { po_no: poNo, vendor: vendorName, document_date: documentDate, ship_to: shipTo,
    document_title: title, filename: safeFilename(title) };
}

async function extractPdfMetadata(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    return parsePurchaseOrder(content.items.filter((item) => 'str' in item).map((item) => {
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return { text: item.str, x, y, width: item.width };
    }));
  } finally {
    await task.destroy();
  }
}

module.exports = { extractPdfMetadata, parsePurchaseOrder, parseDate, safeFilename };
