import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfText } from '../lib/pdf.js';
import { parseToUnicodeCMap } from '../lib/pdf/cmap.js';
import { readConfig } from '../lib/config.js';
import { buildTools } from '../lib/tools.js';

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

test('ToUnicode CMap decodes Chinese UTF-16BE bfchar, bfrange (scalar + array), and surrogate pairs', () => {
  const cmapText = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '2 beginbfchar',
    '<0001> <4E2D>',
    '<0002> <6587>',
    'endbfchar',
    '2 beginbfrange',
    '<0010> <0011> <4F60>',
    '<0020> <0022> [<597D> <D83DDE00> <00660069>]',
    'endbfrange',
    'endcmap',
    'end end',
  ].join('\n');

  const cmapStream = deflateSync(Buffer.from(cmapText, 'latin1'));
  const content = 'BT /F1 12 Tf 72 720 Td <000100020010002000210022> Tj ET';
  const objects = [
    str('<< /Type /Catalog /Pages 2 0 R >>'),
    str('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    buildContentObject(content, false),
    str('<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /ToUnicode 6 0 R >>'),
    Buffer.concat([str(`<< /Length ${cmapStream.length} /Filter /FlateDecode >>\nstream\n`), cmapStream, str('\nendstream')]),
  ];
  const pdf = assemble(objects);
  const out = extractPdfText(pdf);
  // \u4E2D\u6587 = Chinese, \u4F60 = ni, \u597D = hao, \u{1F600} = grinning face, fi = ligature
  assert.equal(out.pages[0].text, '\u4E2D\u6587\u4F60\u597D\u{1F600}fi');
  assert.equal(out.warnings.length, 0, 'a font with a working ToUnicode map should not warn');

  // Verify 1-byte ToUnicode CMap directly as well.
  const oneByte = parseToUnicodeCMap('1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <0042>\nendbfchar');
  assert.ok(oneByte !== null);
});

test('Encoding /Differences remaps glyph names including Euro, fi, and uniXXXX', () => {
  const objects = [
    str('<< /Type /Catalog /Pages 2 0 R >>'),
    str('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
    buildContentObject('BT /F1 12 Tf 72 720 Td <808182> Tj ET', false),
    str('<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding 6 0 R >>'),
    str('<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 /Euro /fi /uni4E2D] >>'),
  ];
  const out = extractPdfText(assemble(objects));
  assert.equal(out.pages[0].text, '\u20ACfi\u4E2D');
});

test('cyclic indirect /Length and deep array/dict nesting do not overflow the stack', () => {
  // Object 4 has /Length 4 0 R (self-cycle) and nested arrays in content stream.
  const nestedArray = '['.repeat(120) + '(safe)' + ']'.repeat(120);
  const stream = `BT /F1 12 Tf 72 720 Td ${nestedArray} TJ (AfterNested) Tj ET`;
  const deepDict = '<< /A '.repeat(120) + '1' + ' >>'.repeat(120);
  const objects = [
    str('<< /Type /Catalog /Pages 2 0 R >>'),
    str('<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>'),
    str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Extra ${deepDict} >>`),
    str(`<< /Length 4 0 R >>\nstream\n${stream}\nendstream`),
    str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  ];
  const out = extractPdfText(assemble(objects));
  assert.equal(out.pageCount, 1);
  assert.match(out.pages[0].text, /AfterNested/);
});

test('BT/ET resets Tm position across separate text blocks', () => {
  const stream = [
    'BT /F1 12 Tf 1 0 0 1 72 720 Tm (First) Tj ET',
    'BT /F1 12 Tf 1 0 0 1 72 720 Tm (Second) Tj ET',
  ].join('\n');
  const out = extractPdfText(buildPdf([stream], false));
  assert.equal(out.pages[0].text, 'First\nSecond');
});

test('filekit_read_pdf guards against 0-returned infinite loop when page 1 exceeds maxOutputBytes', async () => {
  const bigPage = `BT /F1 12 Tf 72 720 Td (${'A'.repeat(6000)}) Tj ET`;
  const pdf = buildPdf([bigPage, PAGE2], false);
  const ctx = {
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p }; },
      async stat() { return { type: 'file', size: pdf.length, version: 'v1' }; },
      async readBytes() { return pdf; },
    },
    emit() {},
  };
  const cfg = readConfig({ maxOutputBytes: 4096, statusFile: false }, { pluginDir: '', profileDir: '', home: '' });
  const pdfTool = buildTools(cfg, ctx).find((t) => t.name === 'filekit_read_pdf');
  const out = await pdfTool.execute({ path: 'big.pdf', offset: 1, limit: 2 }, { signal: new AbortController().signal });
  assert.equal(out.pagesReturned, 1);
  assert.match(out.text, /page truncated to fit output cap/);
  assert.match(out.text, /Use offset=2 to continue/);
});

test('classic xref freed (f) entry blocks resurrection from older Prev section and cumulative page stream cap holds', () => {
  // Base PDF has object 4 = content "(OldSecret)". Incremental update frees object 4 (f)
  // and points page 3 -> new object 6 = "(NewSafe)" (or keeps ref to freed 4, which must NOT resolve).
  const base = buildPdf(['BT /F1 12 Tf 72 720 Td (OldSecret) Tj ET'], false);
  const startxrefMatch = /startxref\s+(\d+)/.exec(base.toString('latin1'));
  const prevXref = Number(startxrefMatch[1]);
  const incXrefStart = base.length;
  // Free object 4 in the incremental update; page 3 still points to 4 0 R, so it must NOT resurrect OldSecret.
  const inc = [
    'xref',
    '4 1',
    '0000000000 00001 f ',
    'trailer',
    `<< /Size 6 /Root 1 0 R /Prev ${prevXref} >>`,
    'startxref',
    String(incXrefStart),
    '%%EOF\n',
  ].join('\n');
  const updated = Buffer.concat([base, str(inc)]);
  const out = extractPdfText(updated);
  assert.equal(out.pages[0].text.includes('OldSecret'), false, 'freed object must not be resurrected from Prev');

  // Cumulative per-page decoded stream cap across multiple content streams.
  const chunk = `BT /F1 12 Tf (${'X'.repeat(600)}) Tj ET`;
  const multi = assemble([
    str('<< /Type /Catalog /Pages 2 0 R >>'),
    str('<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 6 0 R >> >> >>'),
    str('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 5 0 R] >>'),
    buildContentObject(chunk, false),
    buildContentObject(chunk, false),
    str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  ]);
  const capped = extractPdfText(multi, { maxStreamBytes: 800 });
  assert.ok(capped.warnings.some((w) => /cumulative decoded content streams exceed/i.test(w)));
});
