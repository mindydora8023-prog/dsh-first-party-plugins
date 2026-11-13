/**
 * Tool definitions for filekit.
 *
 * Four tools, all read-only. Plain-text line windows are NOT here -- that is
 * ops-lite's `ops_read_files`, which does the same job with a structured outcome
 * contract. Keeping both made the model choose between synonyms (see the note on
 * buildTools at the bottom of this file).
 *
 *   filekit_read_table  bounded CSV/TSV rows (delimiter + BOM aware)
 *   filekit_read_docx   bounded DOCX main-body paragraphs and tables
 *   filekit_read_xlsx   bounded XLSX worksheet rows (dates as ISO)
 *   filekit_read_pdf    bounded PDF page text
 *
 * Every tool returns a single rendered text body under a bare object envelope so
 * the result reads the same as the host `read` tool.
 */

import { resolvePath, statTarget, readBytes } from './access.js'
import { isCredentialPath, credentialDenied } from './guard.js'
import {
  decodeTable,
  detectDelimiter,
  formatTable,
  parseDelimited,
} from './csv.js'
import { readDocx } from './docx.js'

const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }]

function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => asText(value?.text ?? ''),
  }
}

function positiveInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Resolve + fence + stat one path, returning everything later steps need. */
async function prepare(ctx, exec, config, requested) {
  const resolved = await resolvePath(ctx, exec, requested)
  if (config.denyCredentialReads && isCredentialPath(resolved.displayPath)) throw credentialDenied()
  const info = await statTarget(ctx, exec, resolved)
  if (info.size > config.maxFileBytes) {
    throw new Error(
      `cannot read "${resolved.displayPath}": ${info.size} bytes exceeds the ${config.maxFileBytes}-byte cap`,
    )
  }
  return { resolved, info }
}

/** filekit_read_table: bounded CSV/TSV window. */
function buildTableTool(config, ctx) {
  return {
    name: 'filekit_read_table',
    description:
      'Read rows from a CSV or TSV file with bounded, paged output. Detects the delimiter and the '
      + 'encoding from a BOM (UTF-8 default; UTF-16LE/BE accepted explicitly). Shows the header row once '
      + 'and data rows with 1-based row numbers; long cells are truncated. Use offset/limit to page a large '
      + 'export instead of loading it whole.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the delimited file.' },
      offset: { type: 'integer', description: '1-based first DATA row to return. Default 1.' },
      limit: { type: 'integer', description: `Maximum data rows. Default ${config.docDefaultLimit}.` },
      delimiter: {
        type: 'string',
        enum: ['auto', ',', '\t', ';', '|'],
        description: 'Field delimiter. Default auto (detected from the first line).',
      },
      encoding: {
        type: 'string',
        enum: ['auto', 'utf-8', 'utf-16le', 'utf-16be'],
        description: 'Text encoding. Default auto (BOM detection, then UTF-8).',
      },
      has_header: { type: 'boolean', description: 'Treat the first row as a header. Default true.' },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const { text, encoding } = decodeTable(buffer, args?.encoding === undefined ? 'auto' : args.encoding)
      const delimiter = detectDelimiter(text, args?.delimiter === undefined || args.delimiter === 'auto' ? '' : args.delimiter)
      const parsed = parseDelimited(text, delimiter, { maxRows: 200000 })
      const offset = positiveInt(args?.offset, 1, 1, Number.MAX_SAFE_INTEGER)
      const limit = positiveInt(args?.limit, config.docDefaultLimit, 1, config.docMaxLimit)
      const table = formatTable(parsed.rows, {
        offset,
        limit,
        hasHeader: bool(args?.has_header, true),
        maxCellLength: config.maxCellLength,
        maxBytes: config.maxOutputBytes,
      })
      const note = `(delimiter=${JSON.stringify(delimiter === '\t' ? '\\t' : delimiter)}, encoding=${encoding}${parsed.truncated ? ', scan stopped at the row cap' : ''})`
      return {
        text: `<path>${resolved.displayPath}</path>\n<type>table</type>\n<content>\n${table.text}\n\n${note}\n</content>`,
        returned: table.returned,
        totalDataRows: table.totalDataRows,
      }
    },
  }
}

/** filekit_read_docx: bounded DOCX main-body window. */
function buildDocxTool(config, ctx) {
  return {
    name: 'filekit_read_docx',
    description:
      'Read a .docx main body as ordered paragraphs and tables, with bounded paged output. '
      + 'Each paragraph is one numbered block; a table is one block rendered as rows of cells. '
      + 'Only the document body is read: no headers/footers, footnotes, comments, images or tracked '
      + 'changes, and legacy binary .doc is rejected (convert to .docx). Use offset/limit to page.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the .docx file.' },
      offset: { type: 'integer', description: '1-based first block to return. Default 1.' },
      limit: { type: 'integer', description: `Maximum blocks. Default ${config.docDefaultLimit}.` },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const offset = positiveInt(args?.offset, 1, 1, Number.MAX_SAFE_INTEGER)
      const limit = positiveInt(args?.limit, config.docDefaultLimit, 1, config.docMaxLimit)
      const doc = readDocx(buffer, { offset, limit, maxCellLength: config.maxCellLength, maxBytes: config.maxOutputBytes })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: `<path>${resolved.displayPath}</path>\n<type>docx</type>\n<content>\n${doc.text}${warn}\n</content>`,
        returned: doc.returned,
        totalBlocks: doc.totalBlocks,
      }
    },
  }
}

/** filekit_read_xlsx: bounded worksheet table window. */
function buildXlsxTool(config, ctx) {
  return {
    name: 'filekit_read_xlsx',
    description:
      'Read one worksheet of an .xlsx workbook as a bounded, paged table. Shows the header row once, then '
      + 'data rows with 1-based row numbers; long cells are truncated. Dates (cells with a date number '
      + 'format) are rendered as ISO dates, booleans as TRUE/FALSE, and formula cells as their cached value '
      + '(formulas are NOT recalculated). Merged cells show the top-left value; charts/images/pivot tables '
      + 'are ignored. Legacy binary .xls is rejected (save as .xlsx). Use sheet to pick a worksheet and '
      + 'offset/limit to page large sheets.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the .xlsx file.' },
      sheet: {
        type: 'string',
        description: 'Worksheet name or 1-based index. Defaults to the first worksheet. The footer lists all sheet names.',
      },
      offset: { type: 'integer', description: '1-based first DATA row to return. Default 1.' },
      limit: { type: 'integer', description: `Maximum data rows. Default ${config.docDefaultLimit}.` },
      has_header: { type: 'boolean', description: 'Treat the first row as a header. Default true.' },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const { readXlsx } = await import('./xlsx.js')
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const offset = positiveInt(args?.offset, 1, 1, Number.MAX_SAFE_INTEGER)
      const limit = positiveInt(args?.limit, config.docDefaultLimit, 1, config.docMaxLimit)
      const sheetArg = typeof args?.sheet === 'string' && args.sheet.trim() !== ''
        ? (/^\d+$/.test(args.sheet.trim()) ? Number(args.sheet.trim()) : args.sheet.trim())
        : undefined
      const doc = readXlsx(buffer, {
        offset,
        limit,
        sheet: sheetArg,
        hasHeader: bool(args?.has_header, true),
        maxCellLength: config.maxCellLength,
        maxBytes: config.maxOutputBytes,
      })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      const sheetList = doc.sheets.length > 1 ? `\n(sheets: ${doc.sheets.join(', ')})` : ''
      return {
        text: `<path>${resolved.displayPath}</path>\n<type>xlsx</type>\n<content>\n${doc.text}${sheetList}${warn}\n</content>`,
        sheet: doc.sheetName,
        sheets: doc.sheets,
        returned: doc.returned,
        totalRows: doc.totalRows,
      }
    },
  }
}

/** filekit_read_pdf: bounded PDF page text window. */
function buildPdfTool(config, ctx) {
  return {
    name: 'filekit_read_pdf',
    description:
      'Read text from a PDF, one page range at a time, with bounded output. Handles classic PDFs with '
      + 'Flate-compressed content and simple fonts. Not OCR: scanned/image-only pages return empty text. '
      + 'Embedded/subset fonts and PDF 1.5+ cross-reference or object streams may be unsupported, and a '
      + 'warning says so. Use offset/limit for the page range, and prefer pageCount from the footer to plan pages.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the .pdf file.' },
      offset: { type: 'integer', description: '1-based first page to return. Default 1.' },
      limit: { type: 'integer', description: `Maximum pages. Default ${config.pdfDefaultPages}, max ${config.pdfMaxPages}.` },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const { extractPdfText } = await import('./pdf.js')
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const offset = positiveInt(args?.offset, 1, 1, Number.MAX_SAFE_INTEGER)
      const limit = positiveInt(args?.limit, config.pdfDefaultPages, 1, config.pdfMaxPages)
      const doc = extractPdfText(buffer, { offset, limit })
      const parts = []
      let bytes = 0
      let lastPage = offset - 1
      for (const page of doc.pages) {
        const chunk = `--- page ${page.page} ---\n${page.text.trim() === '' ? '(no extractable text)' : page.text.trim()}`
        const size = Buffer.byteLength(chunk, 'utf8') + 2
        if (bytes + size > config.maxOutputBytes) break
        bytes += size
        parts.push(chunk)
        lastPage = page.page
      }
      const endPage = Math.min(offset + limit - 1, doc.pageCount)
      let footer
      if (lastPage < endPage) footer = `(Output capped. Showing pages ${offset}-${lastPage} of ${doc.pageCount}. Use offset=${lastPage + 1} to continue.)`
      else if (endPage < doc.pageCount) footer = `(Showing pages ${offset}-${endPage} of ${doc.pageCount}. Use offset=${endPage + 1} to continue.)`
      else footer = `(End of document - ${doc.pageCount} pages)`
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: `<path>${resolved.displayPath}</path>\n<type>pdf</type>\n<content>\n${parts.join('\n\n')}\n\n${footer}${warn}\n</content>`,
        pageCount: doc.pageCount,
        pagesReturned: parts.length,
      }
    },
  }
}

/**
 * Build all tool definitions for the resolved config.
 *
 * `filekit_read` was removed on 2026-10-26: it read UTF-8 line windows from 1..N
 * files, which is exactly what ops-lite's `ops_read_files` does -- with a
 * strictly better contract (structured outcome carrying effectState/retry/
 * nextAction, escaped-byte budgets, a compact receipt, and two independent
 * completeness levels). Two tools that both mean "read several files" made the
 * model choose between synonyms with no basis for the choice, and each carried
 * its own prompt paragraph recommending itself.
 *
 * The document readers stay here: CSV/TSV/DOCX/XLSX/PDF parsing is filekit's
 * reason to exist, and ops-lite deliberately does not do it.
 */
export function buildTools(config, ctx) {
  return [
    buildTableTool(config, ctx),
    buildDocxTool(config, ctx),
    buildXlsxTool(config, ctx),
    buildPdfTool(config, ctx),
  ]
}
