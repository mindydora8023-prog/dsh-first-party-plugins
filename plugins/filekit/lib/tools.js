/**
 * Tool definitions for filekit.
 *
 * Seven read-only document tools:
 *   filekit_read_table  bounded CSV/TSV rows (delimiter + BOM aware)
 *   filekit_read_docx   bounded DOCX body as Markdown (headings, links, tables)
 *   filekit_read_xlsx   bounded XLSX sheets as Markdown tables (dates as ISO)
 *   filekit_read_pptx   bounded PPTX slides as Markdown (text, tables, notes)
 *   filekit_read_pdf    bounded PDF page text
 *   filekit_outline     headings/sheets/slides/pages without dumping the body
 *   filekit_search      literal substring search with unit locations
 *
 * Every tool neutralizes wrapper tags (`</content>`, `</path>`, `</query>`,
 * `<type>`) so untrusted document text or paths cannot close the envelope.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { resolvePath, statTarget, readBytes } from './access.js'
import { isCredentialPath, credentialDenied } from './guard.js'
import { neutralizeWrapperTags } from './escape.js'
import { truncateUtf8 } from './ooxml.js'
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

/** Wrap a tool output envelope while neutralizing wrapper tags in untrusted text. */
function wrapEnvelope(displayPath, type, content, query = undefined) {
  const safePath = neutralizeWrapperTags(displayPath)
  const safeContent = neutralizeWrapperTags(content)
  if (query !== undefined) {
    const safeQuery = neutralizeWrapperTags(query)
    return `<path>${safePath}</path>\n<type>${type}</type>\n<query>${safeQuery}</query>\n<content>\n${safeContent}\n</content>`
  }
  return `<path>${safePath}</path>\n<type>${type}</type>\n<content>\n${safeContent}\n</content>`
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
    description: 'Read a page of CSV or TSV rows. Delimiter and BOM encoding are detected; continue with offset.',
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
        text: wrapEnvelope(resolved.displayPath, 'table', `${table.text}\n\n${note}`),
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
    description: 'Read a page of a .docx body as Markdown: headings, links and tables. Not headers, notes, or legacy .doc.',
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
      const doc = readDocx(buffer, {
        offset,
        limit,
        maxCellLength: config.maxCellLength,
        maxBytes: config.maxOutputBytes,
        scanMaxBytes: config.scanMaxBytes,
      })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: wrapEnvelope(resolved.displayPath, 'docx', `${doc.text}${warn}`),
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
    description: 'Read a .xlsx workbook as Markdown tables. Omit sheet to read the first sheet and preview the others; formulas stay cached values. Legacy .xls is rejected.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the .xlsx file.' },
      sheet: {
        type: 'string',
        description: 'Worksheet name or 1-based index. Omit it to read the first sheet in full and list the other sheets by their header row.',
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
      // Pass string verbatim so readXlsx matches an exact sheet name (e.g. "2")
      // before falling back to a 1-based sheet index.
      const sheetArg = typeof args?.sheet === 'string' && args.sheet.trim() !== ''
        ? args.sheet.trim()
        : undefined
      const doc = readXlsx(buffer, {
        offset,
        limit,
        sheet: sheetArg,
        hasHeader: bool(args?.has_header, true),
        maxCellLength: config.maxCellLength,
        maxBytes: config.maxOutputBytes,
        scanMaxBytes: config.scanMaxBytes,
      })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: wrapEnvelope(resolved.displayPath, 'xlsx', `${doc.text}${warn}`),
        sheet: doc.sheetName,
        sheets: doc.sheets,
        returned: doc.returned,
        totalRows: doc.totalRows,
      }
    },
  }
}

/** filekit_read_pptx: bounded slide window. */
function buildPptxTool(config, ctx) {
  return {
    name: 'filekit_read_pptx',
    description: 'Read a page of a .pptx as Markdown slides, including tables and speaker notes. Not pictures or legacy .ppt.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the .pptx file.' },
      offset: { type: 'integer', description: '1-based first slide to return. Default 1.' },
      limit: { type: 'integer', description: `Maximum slides. Default ${config.pdfDefaultPages}, max ${config.pdfMaxPages}.` },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const { readPptx } = await import('./pptx.js')
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const offset = positiveInt(args?.offset, 1, 1, Number.MAX_SAFE_INTEGER)
      const limit = positiveInt(args?.limit, config.pdfDefaultPages, 1, config.pdfMaxPages)
      const doc = readPptx(buffer, {
        offset,
        limit,
        maxCellLength: config.maxCellLength,
        maxBytes: config.maxOutputBytes,
        scanMaxBytes: config.scanMaxBytes,
      })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: wrapEnvelope(resolved.displayPath, 'pptx', `${doc.text}${warn}`),
        returned: doc.returned,
        slideCount: doc.slideCount,
      }
    },
  }
}

/** filekit_read_pdf: bounded PDF page text window. */
function buildPdfTool(config, ctx) {
  return {
    name: 'filekit_read_pdf',
    description: 'Read text from a PDF page range. Not OCR: scanned pages come back empty.',
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
      const doc = extractPdfText(buffer, { offset, limit, maxStreamBytes: config.scanMaxBytes })
      const parts = []
      let bytes = 0
      let lastPage = offset - 1
      let capped = false
      for (const page of doc.pages) {
        const chunk = `--- page ${page.page} ---\n${page.text.trim() === '' ? '(no extractable text)' : page.text.trim()}`
        const size = Buffer.byteLength(chunk, 'utf8') + 2
        if (bytes + size > config.maxOutputBytes) {
          if (parts.length === 0) {
            // Never return 0 pages when a page exists (prevents infinite pagination loops).
            const notice = '\n... (page truncated to fit output cap)'
            const budget = Math.max(64, config.maxOutputBytes - Buffer.byteLength(notice, 'utf8') - 16)
            parts.push(`${truncateUtf8(chunk, budget)}${notice}`)
            lastPage = page.page
          }
          capped = true
          break
        }
        bytes += size
        parts.push(chunk)
        lastPage = page.page
      }
      const endPage = Math.min(offset + limit - 1, doc.pageCount)
      let footer
      if (capped || lastPage < endPage) {
        footer = lastPage < doc.pageCount
          ? `(Output capped. Showing pages ${offset}-${lastPage} of ${doc.pageCount}. Use offset=${lastPage + 1} to continue.)`
          : `(Output capped. Showing pages ${offset}-${lastPage} of ${doc.pageCount}.)`
      } else if (endPage < doc.pageCount) {
        footer = `(Showing pages ${offset}-${endPage} of ${doc.pageCount}. Use offset=${endPage + 1} to continue.)`
      } else {
        footer = `(End of document - ${doc.pageCount} pages)`
      }
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: wrapEnvelope(resolved.displayPath, 'pdf', `${parts.join('\n\n')}\n\n${footer}${warn}`),
        pageCount: doc.pageCount,
        pagesReturned: parts.length,
      }
    },
  }
}

/** Detect a document format from a path's extension, or '' when unknown. */
function formatFromPath(path) {
  const match = /\.([a-z0-9]+)$/i.exec(String(path ?? ''))
  if (match === null) return ''
  const ext = match[1].toLowerCase()
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'pdf') return 'pdf'
  return ''
}

/** filekit_outline: headings/sheets/slides/pages without reading the body. */
function buildOutlineTool(config, ctx) {
  return {
    name: 'filekit_outline',
    description: 'List a document\'s outline without reading the body: DOCX headings, XLSX sheets plus their header row, PPTX slide titles, or PDF page count with the first line of each page. Use it to choose which range to read next.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to a .docx, .xlsx, .pptx or .pdf file.' },
      limit: { type: 'integer', description: `Maximum outline entries to return. Default ${config.docDefaultLimit}.` },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const format = formatFromPath(args?.path)
      if (format === '') {
        throw new Error('filekit_outline supports .docx, .xlsx, .pptx and .pdf only; plain text belongs to ops_read_files')
      }
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const limit = positiveInt(args?.limit, config.docDefaultLimit, 1, config.docMaxLimit)
      const { buildOutline } = await import('./outline.js')
      const doc = buildOutline(buffer, format, {
        maxEntries: limit,
        maxBytes: config.maxOutputBytes,
        maxPdfPages: config.pdfMaxPages,
        scanMaxBytes: config.scanMaxBytes,
      })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: wrapEnvelope(resolved.displayPath, `outline:${format}`, `${doc.text}${warn}`),
        entryCount: doc.entryCount,
        totalEntries: doc.totalEntries,
        truncated: doc.truncated,
      }
    },
  }
}

/** filekit_search: find text inside one document without dumping its body. */
function buildSearchTool(config, ctx) {
  return {
    name: 'filekit_search',
    description: 'Search the text of one document (DOCX, XLSX, PPTX or PDF) and return the matching units with their location (paragraph, table cell, sheet row, slide or page). Plain substring match, case-insensitive by default.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to a .docx, .xlsx, .pptx or .pdf file.' },
      query: { type: 'string', required: true, description: 'Text to find (literal substring).' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match. Default true.' },
      limit: { type: 'integer', description: 'Maximum matches to return. Default 50.' },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const format = formatFromPath(args?.path)
      if (format === '') {
        throw new Error('filekit_search supports .docx, .xlsx, .pptx and .pdf only; plain text belongs to ops_read_files')
      }
      const query = typeof args?.query === 'string' ? args.query : ''
      if (query.trim() === '') throw new Error('query must be a non-empty string')
      const { resolved, info } = await prepare(ctx, exec, config, args?.path)
      const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
      const limit = positiveInt(args?.limit, 50, 1, config.docMaxLimit)
      const ignoreCase = bool(args?.ignore_case, true)
      const { searchDocument } = await import('./search.js')
      const doc = searchDocument(buffer, format, query, {
        limit,
        ignoreCase,
        maxBytes: config.maxOutputBytes,
        maxPdfPages: config.pdfMaxPages,
        scanMaxBytes: config.scanMaxBytes,
      })
      const warn = doc.warnings.length > 0 ? `\n(warnings: ${doc.warnings.join('; ')})` : ''
      return {
        text: wrapEnvelope(resolved.displayPath, `search:${format}`, `${doc.text}${warn}`, query),
        hits: doc.hits,
        scanned: doc.scanned,
        truncated: doc.truncated,
      }
    },
  }
}

/** Build all tool definitions for the resolved config. */
export function buildTools(config, ctx) {
  return [
    buildTableTool(config, ctx),
    buildDocxTool(config, ctx),
    buildXlsxTool(config, ctx),
    buildPptxTool(config, ctx),
    buildPdfTool(config, ctx),
    buildOutlineTool(config, ctx),
    buildSearchTool(config, ctx),
  ]
}
