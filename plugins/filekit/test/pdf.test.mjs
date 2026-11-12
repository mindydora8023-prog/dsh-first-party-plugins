import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfText } from '../lib/pdf.js';

// ---------------------------------------------------------------------------
// In-memory PDF builder (no external fixture files).
// Builds a classic-xref PDF with N pages sharing one Helvetica font resource.
// ---------------------------------------------------------------------------

function str(s) {
  return Buffer.from(s, 'latin1');
}

function buildContentObject(content, compress) {
  let data = Buffer.from(content, 'latin1');
  let dict;
  if (compress) {
    data = deflateSync(data);
    dict = '<< /Length ' + data.length + ' /Filter /FlateDecode >>';
  } else {
    dict = '<< /Length ' + data.length + ' >>';
  }
  return Buffer.concat([
    str(dict + '\nstream\n'),
    data,
    str('\nendstream')
  ]);
}

function buildPdf(pageContents, compress) {
  const n = pageContents.length;
  const fontNum = 3 + n * 2;
  const objects = [];

  // 1: Catalog
  objects.push(str('<< /Type /Catalog /Pages 2 0 R >>'));

  // 2: Pages
  const pageNums = [];
  for (let i = 0; i < n; i++) pageNums.push(3 + i * 2);
  const kids = pageNums.map((x) => x + ' 0 R').join(' ');
  objects.push(
    str(
      '<< /Type /Pages /Kids [' + kids + '] /Count ' + n +
      ' /Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> >>'
    )
  );

  // 3,4 / 5,6 / ...: pages and their content streams
  for (let i = 0; i < n; i++) {
    const contentNum = 4 + i * 2;
    objects.push(
      str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + contentNum + ' 0 R >>')
    );
    objects.push(buildContentObject(pageContents[i], compress));
  }

  // font
  objects.push(
    str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  );

  return assemble(objects);
}

function assemble(objects) {
  const parts = [];
  let len = 0;
  const offsets = [];
  const push = (b) => {
    parts.push(b);
    len += b.length;
  };

  push(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));

  for (let i = 0; i < objects.length; i++) {
    offsets[i] = len;
    push(str((i + 1) + ' 0 obj\n'));
    push(objects[i]);
    push(str('\nendobj\n'));
  }

  const xrefStart = len;
  const size = objects.length + 1;
  let xref = 'xref\n0 ' + size + '\n';
  xref += '0000000000 65535 f\r\n';
  for (let i = 0; i < objects.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n\r\n';
  }
  xref +=
    'trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
  push(str(xref));

  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PAGE1 = 'BT /F1 12 Tf 72 720 Td (Hello FileKit) Tj ET';
const PAGE2 = 'BT /F1 12 Tf 72 720 Td [(Second) -300 (page)] TJ ET';

test('extracts text from an uncompressed classic-xref PDF', () => {
  const pdf = buildPdf([PAGE1, PAGE2], false);
  const out = extractPdfText(pdf);
  assert.equal(out.pageCount, 2);
  assert.equal(out.pages.length, 2);
  assert.equal(out.pages[0].page, 1);
  assert.match(out.pages[0].text, /Hello FileKit/);
  assert.equal(out.pages[1].page, 2);
  assert.match(out.pages[1].text, /Second\s+page/);
  assert.ok(Array.isArray(out.warnings));
});

test('extracts text from a FlateDecode-compressed PDF', () => {
  const pdf = buildPdf([PAGE1, PAGE2], true);
  const out = extractPdfText(pdf);
  assert.equal(out.pageCount, 2);
  assert.match(out.pages[0].text, /Hello FileKit/);
  assert.match(out.pages[1].text, /Second\s+page/);
});

test('offset/limit window returns only the requested page', () => {
  const pdf = buildPdf([PAGE1, PAGE2], false);
  const out = extractPdfText(pdf, { offset: 2, limit: 1 });
  assert.equal(out.pageCount, 2);
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].page, 2);
  assert.match(out.pages[0].text, /Second\s+page/);
});

test('throws a readable error for non-PDF input', () => {
  const bad = Buffer.from('not a pdf at all', 'latin1');
  assert.throws(
    () => extractPdfText(bad),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /pdf|cross-reference/i);
      return true;
    }
  );
});

test('empty content stream yields empty text without throwing', () => {
  const pdf = buildPdf(['', ''], false);
  const out = extractPdfText(pdf);
  assert.equal(out.pageCount, 2);
  assert.equal(out.pages[0].text, '');
  assert.equal(out.pages[1].text, '');
});

test('limit is clamped to a maximum of 100', () => {
  const pdf = buildPdf([PAGE1], false);
  const out = extractPdfText(pdf, { limit: 1000 });
  assert.equal(out.pages.length, 1);
  assert.equal(out.pageCount, 1);
});
