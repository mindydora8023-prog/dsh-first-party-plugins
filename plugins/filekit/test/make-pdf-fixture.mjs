// Build a small real PDF fixture on disk (classic xref, Flate-compressed streams)
// so the e2e suite can exercise filekit_read_pdf end-to-end.
import fs from 'node:fs'
import { deflateSync } from 'node:zlib'

const objects = []
function add(body) { objects.push(body); return objects.length }

const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

function contentStream(text) {
  return `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`
}

const pagesObjNum = 3 // placeholder, filled below

const streams = [
  contentStream('FileKit PDF page one'),
  contentStream('FileKit PDF page two'),
]

const pageObjNums = []
const contentObjNums = []

// Reserve: obj 1 font (added), obj 2 pages, then per page: page obj + content obj
// Rebuild deterministically instead of guessing.
let next = 1
const objs = {}
const fontNum = next++
objs[fontNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const pagesNum = next++
const pageNums = []
const contentNums = []
for (let i = 0; i < streams.length; i += 1) { pageNums.push(next++) }
for (let i = 0; i < streams.length; i += 1) { contentNums.push(next++) }

objs[pagesNum] = `<< /Type /Pages /Count ${streams.length} /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] >>`
for (let i = 0; i < streams.length; i += 1) {
  objs[pageNums[i]] = `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`
  const z = deflateSync(Buffer.from(streams[i], 'latin1'))
  objs[contentNums[i]] = { stream: z }
}
const catalogNum = next++
objs[catalogNum] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`

// Serialize with exact byte offsets.
const chunks = []
let length = 0
const push = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); chunks.push(b); length += b.length }
push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
const offsets = {}
for (let n = 1; n < next; n += 1) {
  offsets[n] = length
  const o = objs[n]
  if (typeof o === 'string') {
    push(`${n} 0 obj\n${o}\nendobj\n`)
  } else {
    push(`${n} 0 obj\n<< /Length ${o.stream.length} /Filter /FlateDecode >>\nstream\n`)
    push(o.stream)
    push('\nendstream\nendobj\n')
  }
}
const xrefStart = length
push(`xref\n0 ${next}\n`)
push('0000000000 65535 f \n')
for (let n = 1; n < next; n += 1) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
push(`trailer\n<< /Size ${next} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)

fs.writeFileSync(process.argv[2], Buffer.concat(chunks))
console.log('wrote', process.argv[2], Buffer.concat(chunks).length, 'bytes')
