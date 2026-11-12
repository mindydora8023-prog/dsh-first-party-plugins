// Deterministic, locally authored OOXML fixtures. Node built-ins only.
// No default document, theme, thumbnail, or third-party template is embedded.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const destination = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const check = process.argv.includes('--check')
const xml = (body) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + body
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(parts) {
  const local = [], central = []
  let offset = 0
  for (const [name, text] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(text), crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x21, 12)
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42)
    local.push(head, filename, data); central.push(entry, filename)
    offset += head.length + filename.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = Object.keys(parts).length
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
function relationships(items) {
  return xml(`<Relationships xmlns="${relNS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeRel}${type}" Target="${target}"/>`).join('')}</Relationships>`)
}
function contentTypes(overrides) {
  return xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('') + '</Types>')
}
const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
const table = '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' + [1, 2].map(r => '<w:tr>' + [1, 2, 3].map(c => `<w:tc><w:tcPr/>${p(`R${r}C${c}`)}</w:tc>`).join('') + '</w:tr>').join('') + '</w:tbl>'
const docx = {
  '[Content_Types].xml': contentTypes([['word/document.xml', 'wordprocessingml.document.main']]),
  '_rels/.rels': relationships([['rId1', 'officeDocument', 'word/document.xml']]),
  'word/document.xml': xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + p('FileKit Report') + p('First paragraph with an & ampersand and <angle> brackets.') + '<w:p><w:r><w:t xml:space="preserve">Second paragraph </w:t><w:tab/><w:t>after a tab</w:t></w:r></w:p>' + table + p('Paragraph after the table.') + '<w:sectPr/></w:body></w:document>'),
}
const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const cell = (ref, value) => {
  if (value === null) return ''
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${Number(value)}</v></c>`
  if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`
  if (typeof value === 'object' && value.formula) return `<c r="${ref}"><f>${esc(value.formula)}</f><v></v></c>`
  if (typeof value === 'object') return `<c r="${ref}" s="${value.style}"><v>${value.serial}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`
}
function worksheet(rows) {
  return xml(`<worksheet xmlns="${sheetNS}"><sheetData>` + rows.map((row, i) => `<row r="${i + 1}">` + row.map((v, j) => cell(String.fromCharCode(65 + j) + (i + 1), v)).join('') + '</row>').join('') + '</sheetData></worksheet>')
}
function workbook(sheets, styles) {
  const parts = {
    '[Content_Types].xml': contentTypes([['xl/workbook.xml', 'spreadsheetml.sheet.main'], ...sheets.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, 'spreadsheetml.worksheet']), ...(styles ? [['xl/styles.xml', 'spreadsheetml.styles']] : [])]),
    '_rels/.rels': relationships([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': xml(`<workbook xmlns="${sheetNS}" xmlns:r="${officeRel.slice(0, -1)}"><sheets>` + sheets.map(([name], i) => `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': relationships([...sheets.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`]), ...(styles ? [['rIdStyles', 'styles', 'styles.xml']] : [])]),
  }
  sheets.forEach(([, rows], i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = worksheet(rows) })
  if (styles) parts['xl/styles.xml'] = xml(`<styleSheet xmlns="${sheetNS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
  return parts
}
const fixtures = {
  'sample.docx': docx,
  'sample.xlsx': workbook([['Sales', [['Region', 'Units', 'Revenue', 'Note'], ['North', 120, 4800.5, 'ok'], ['South', 90, 3600, null], ['East', 150, 6000.25, 'surge']]], ['Meta', [['key', 'value'], ['generated', '2026-10-23']]]]),
  'dates.xlsx': workbook([['Sheet', [['name', 'when', 'flag', 'formula'], ['a', { serial: 46318, style: 1 }, true, null], ['b', { serial: 46024.12783564815, style: 2 }, false, { formula: '1+2' }]]]], true),
}
for (const [name, parts] of Object.entries(fixtures)) {
  const bytes = zip(parts), target = path.join(destination, name)
  if (check) {
    if (!fs.readFileSync(target).equals(bytes)) throw new Error(`${name} is stale; run node test/make-office-fixtures.mjs`)
  } else fs.writeFileSync(target, bytes)
  console.log(`${check ? 'verified' : 'wrote'} ${name}: ${bytes.length} bytes, ${Object.keys(parts).length} parts`)
}
