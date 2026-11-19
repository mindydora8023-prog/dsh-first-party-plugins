/**
 * The ops_read_files tool.
 *
 * One call reads 1..N files, each with its own offset and limit. The point is
 * to replace a burst of single-file reads with one call whose output is compact
 * enough that the batch is actually cheaper than the burst.
 *
 * Bounded in four independent ways:
 *   - files per call          (`maxFiles`)
 *   - lines per file          (`limit`, itself capped by `maxLimit`)
 *   - characters per line     (`maxLineLength`, clips and marks)
 *   - bytes per call          (`callMaxBytes`, stops adding files)
 *
 * A failure inside one file never destroys its neighbours: each file produces
 * its own result record, and the aggregate reports both completeness levels.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import { decodeUtf8, isCredentialPath, readBytes, resolvePath, statTarget } from './access.js'
import { buildWindow, lineOfLiteral } from './text.js'
import { failure, fromThrown } from './outcome.js'
import { renderReadFiles } from './render.js'
import { expandEntry } from './select.js'

/** How many file bodies may be in flight at once. dsh-ops uses the same bound. */
const READ_CONCURRENCY = 2

/**
 * A stable content revision for the read-before-write guard.
 *
 * The host's `FsVersion` is an opaque token that consumers must not interpret
 * or display as content identity, so it cannot serve as the compact receipt's
 * `revision`. A SHA-256 over the decoded bytes is self-describing, lets a later
 * write prove it is based on exactly what was read, and is what the real dsh-ops
 * receipt prints.
 *
 * @param {Buffer} buffer - the file bytes.
 * @returns {string} 64 lowercase hex characters.
 */
export function revisionOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Coerce a model-supplied integer into [min, max], falling back when absent. */
function boundedInt(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const integer = Math.trunc(number)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

/**
 * Estimate what a file will cost in the rendered body from its size alone.
 *
 * Used to decide whether an entry still fits the call budget BEFORE reading it.
 * Deciding after the read would mean a file reported as `pending` had already
 * been read and recorded in the host observation table, which would tell the
 * model it had seen content it never received.
 *
 * The estimate is deliberately an upper bound: escaping can at most double a
 * character, and each row adds a line-number prefix.
 *
 * @param {number} size - the file's byte size, when known.
 * @returns {number} an upper-bound byte estimate.
 */
function estimatedCost(size) {
  const bytes = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0
  return bytes * 3 + 4096
}

/**
 * Upper bound on the bytes a WINDOWED read can render, so reading the top of a
 * large log at a small `limit` is not charged as if the whole file were copied.
 * Falls back to the whole-file estimate when the window is unknown.
 */
function estimatedReadCost(size, limit, maxLineLength) {
  const whole = estimatedCost(size)
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(maxLineLength) && maxLineLength > 0) {
    const window = limit * (maxLineLength * 3 + 16) + 4096
    return Math.min(whole, window)
  }
  return whole
}

/**
 * Actual rendered byte cost of a per-file record: every row's escaped text plus
 * its line-number prefix, plus the shared header/footer. This is what a call
 * should subtract from its budget, so `spent` tracks real output rather than the
 * whole file size.
 */
function renderedCost(record) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.items)) return 512
  let total = 512
  for (const item of record.items) total += Buffer.byteLength(String(item?.text ?? ''), 'utf8') + 12
  return total
}

/**
 * Read one file entry and return its per-file result record.
 *
 * Failures are returned, not thrown: one unreadable file must not hide the
 * successful neighbours, and the caller needs per-file failure facts to decide
 * which entries to retry.
 *
 * @param {object} ctx - plugin context.
 * @param {object} exec - tool execution context.
 * @param {object} config - resolved plugin config.
 * @param {object} entry - `{path, offset?, limit?}`.
 * @param {object} [overrides] - per-call overrides such as `maxLineLength`.
 * @param {number} [overrides.remainingBytes] - budget left in this call; when the
 *   file's estimated cost exceeds it the entry is left unread.
 * @returns {Promise<object>} the per-file record, or `{skipped: true}` when the
 *   entry does not fit and must stay pending.
 */
async function readOne(ctx, exec, config, entry, overrides = {}) {
  try {
    const resolved = await resolvePath(ctx, exec, entry.path)
    if (config.denyCredentialReads && isCredentialPath(resolved.displayPath)) {
      return {
        path: entry.path,
        ...failure('CREDENTIAL_DENIED', {
          message: 'that path is credential material and is refused by policy; '
            + 'credential files and key directories are never read by this plugin',
          nextAction: 'Do not retry this path. Ask the operator to open it explicitly if it is genuinely needed.',
        }),
      }
    }
    const info = await statTarget(ctx, exec, resolved)
    // Resolve the window BEFORE the budget check so a windowed read of a large
    // file is charged for the window, not for the whole file.
    let offset = boundedInt(entry.offset, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = boundedInt(entry.limit, config.defaultLimit, 1, config.maxLimit)
    const literal = typeof entry.literal === 'string' ? entry.literal : ''
    // Budget check happens here, before the bytes are read: an entry that does
    // not fit stays pending and must not appear in the observation table.
    if (overrides.remainingBytes !== undefined
      && estimatedReadCost(info.size, limit, overrides.maxLineLength ?? config.maxLineLength) > overrides.remainingBytes) {
      return { skipped: true }
    }
    const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
    const body = decodeUtf8(buffer, resolved.displayPath)

    // A literal is a location, not a filter: the window opens on the first hit
    // so a caller does not have to know the line number. `around` is context
    // counted in lines before that hit; the file limit still caps the window.
    if (literal !== '') {
      const hit = lineOfLiteral(body, literal)
      if (hit === undefined) {
        return {
          path: resolved.displayPath,
          ...failure('LITERAL_NOT_FOUND', {
            message: 'the literal does not occur in this file',
            nextAction: 'Check the exact text, or omit literal and page with offset.',
          }),
        }
      }
      const around = boundedInt(entry.around, 20, 0, limit)
      offset = Math.max(1, hit - around)
    }

    const window = buildWindow(body, {
      offset,
      limit,
      maxLineLength: overrides.maxLineLength ?? config.maxLineLength,
      maxBytes: config.maxOutputBytes,
    })

    // Compare against the window's PHYSICAL line count (1-based; a trailing LF
    // adds no phantom line) instead of `body.split('\n').length`, which counted a
    // trailing empty slot and made the out-of-range boundary drift with whether
    // the file ended in a newline.
    if (offset !== 1 && body.length > 0 && offset > window.lineCount) {
      return {
        path: resolved.displayPath,
        ...failure('OFFSET_OUT_OF_RANGE', {
          message: `offset ${offset} is past the end of a file with ${window.lineCount} lines`,
          nextAction: 'Re-read with a valid offset, or omit offset to read from the first line.',
        }),
      }
    }

    const record = {
      // `status` is what the compact renderer checks before trusting any of the
      // facts below, so it must be set on every success path.
      status: 'completed',
      path: resolved.displayPath,
      revision: revisionOf(buffer),
      bytes: buffer.length,
      lineCount: window.lineCount,
      // Each row carries its own path so the compact renderer can prove the
      // rows belong to this file rather than trusting the enclosing record.
      items: window.lines.map((line) => ({ line: line.line, path: resolved.displayPath, text: line.text })),
      complete: window.complete,
      nextOffset: window.nextOffset,
      truncated: window.truncatedByBytes,
      // The window that was actually applied. The compact renderer uses these
      // instead of re-deriving them from possibly-omitted call arguments.
      requestedOffset: offset,
      requestedLimit: limit,
    }
    if (window.truncatedByBytes) record.truncatedBy = 'output-budget'
    if (window.truncatedInLine !== undefined) {
      record.truncatedInLine = true
      record.bytesTotal = window.truncatedInLine.charactersTotal
      record.bytesOmitted = window.truncatedInLine.charactersOmitted
      record.truncatedInLineAt = window.truncatedInLine.line
    }
    return record
  } catch (error) {
    return { path: entry.path, ...fromThrown(error, { phase: 'read' }) }
  }
}

/** Stable identity so `src/a.js` and its absolute path count as one file. */
function fileKey(filePath, cwd) {
  const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd || process.cwd(), filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Expand globs and directories, then drop duplicate paths.
 *
 * @returns {Promise<{concrete: object[], notes: string[]}>}
 */
async function expandFiles(ctx, exec, config, list) {
  const notes = []
  const concrete = []
  const seen = new Set()
  const cwd = exec?.agent?.session?.header?.cwd
  for (const entry of list) {
    if (concrete.length >= config.maxFiles) {
      notes.push(`stopped at ${config.maxFiles} files; resend what is missing`)
      break
    }
    const expanded = await expandEntry(ctx, exec, entry, config.maxFiles - concrete.length)
    for (const note of expanded.notes) notes.push(note)
    for (const file of expanded.entries) {
      if (concrete.length >= config.maxFiles) break
      const key = fileKey(file.path, cwd)
      if (seen.has(key)) {
        notes.push(`duplicate skipped: ${path.basename(file.path)}`)
        continue
      }
      seen.add(key)
      concrete.push(file)
    }
  }
  return { concrete, notes }
}

/**
 * Upper bound on one file's rendered cost, from a stat only.
 *
 * This must not emit `fs/observed`: a file rejected by the budget has not been
 * read, and the host table must not say otherwise.
 */
async function peekCost(ctx, exec, config, entry, overrides) {
  try {
    const resolved = await resolvePath(ctx, exec, entry.path)
    const info = await ctx.fs.stat(resolved.target, exec?.signal)
    if (info === undefined || info.type !== 'file') return 4096
    const limit = boundedInt(entry.limit, config.defaultLimit, 1, config.maxLimit)
    return estimatedReadCost(info.size, limit, overrides.maxLineLength ?? config.maxLineLength)
  } catch {
    return 4096
  }
}

/**
 * Run `fn` over `entries` with at most `limit` calls in flight, preserving order.
 *
 * @param {object[]} entries
 * @param {number} limit
 * @param {(entry: object) => Promise<object>} fn
 * @returns {Promise<object[]>}
 */
async function mapPool(entries, limit, fn) {
  const results = new Array(entries.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(limit, entries.length))
  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= entries.length) return
      results[index] = await fn(entries[index])
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

/**
 * Build the ops_read_files tool definition.
 *
 * @param {object} ctx - plugin context holding the `fs` service.
 * @param {object} config - resolved plugin config.
 * @returns {object} a tool definition accepted by `tools.register()`.
 */
export function buildReadFilesTool(ctx, config) {
  return {
    name: 'ops_read_files',
    description:
      'Read UTF-8 text in one call. path may be a file, a directory, or a glob (* ? **). '
      + 'literal opens the window on the first exact match; around is lines of context before it (default 20). '
      + 'Each file keeps its own offset and limit. A partial result names the offset to resume from. '
      + 'Not for CSV, DOCX, XLSX, or PDF.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: `At most ${config.maxFiles} entries, each {path, offset?, limit?, literal?, around?}. `
          + 'path is a file, a directory of text files, or a glob. offset is 1-based and defaults to 1. '
          + 'literal, when set, replaces offset with the first matching line.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              required: true,
              description: 'File, directory, or glob (* ? **), resolved against the session workspace.',
            },
            offset: { type: 'integer', description: '1-based first line to return. Default 1. Ignored when literal is set.' },
            limit: {
              type: 'integer',
              description: `Maximum lines for this file. Default ${config.defaultLimit}, maximum ${config.maxLimit}.`,
            },
            literal: {
              type: 'string',
              description: 'Exact source text. The window opens on its first hit instead of offset.',
            },
            around: {
              type: 'integer',
              description: 'Lines of context to keep before a literal hit. Default 20. Ignored without literal.',
            },
          },
        },
      },
      max_line_length: {
        type: 'integer',
        description: `Clip any single line beyond this many characters and say so. Default ${config.maxLineLength}.`,
      },
    },
    output: {
      // `output.schema` is the raw JSON Schema form, so `required` is an array
      // on the object -- per-property `required: true` is only valid in the
      // authoring form used for `parameters`.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'total', 'pending', 'nextIndex', 'failed', 'complete'],
        properties: {
          text: { type: 'string', description: 'The rendered model-facing body.' },
          total: { type: 'integer', description: 'Number of input file entries.' },
          pending: { type: 'integer', description: 'Entries not processed because the call budget was spent.' },
          nextIndex: { type: 'integer', description: 'Index of the first unprocessed entry.' },
          failed: { type: 'integer', description: 'Entries that produced a structured failure.' },
          complete: { type: 'boolean', description: 'True only when every entry is fully read and none failed.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const list = Array.isArray(args?.files) ? args.files : []
      if (list.length === 0) {
        return {
          text: renderReadFiles(args, failure('INVALID_ARGUMENT', {
            message: 'files must contain at least one {path} entry',
            nextAction: 'Call again with at least one file entry.',
          }), { budget: config.textBudget }),
          total: 0, pending: 0, nextIndex: 0, failed: 1, complete: false,
        }
      }

      const overrides = {
        maxLineLength: boundedInt(args?.max_line_length, config.maxLineLength, 80, config.maxLineLength),
      }
      const { concrete, notes } = await expandFiles(ctx, exec, config, list)
      // Admit a prefix whose estimated cost fits, then read that prefix two at a
      // time. Anything past the prefix stays unread, so it cannot land in the
      // host observation table. The first file is always admitted.
      const admitted = []
      let reserved = 0
      for (const entry of concrete) {
        const estimate = admitted.length === 0
          ? 0
          : await peekCost(ctx, exec, config, entry, overrides)
        if (admitted.length > 0 && reserved + estimate > config.callMaxBytes) break
        admitted.push(entry)
        reserved += admitted.length === 1 ? await peekCost(ctx, exec, config, entry, overrides) : estimate
      }
      const records = await mapPool(admitted, READ_CONCURRENCY, (entry) => readOne(ctx, exec, config, entry, overrides))
      const items = []
      let failed = 0
      for (const record of records) {
        if (record === undefined || record.skipped === true) continue
        if (record.error !== undefined) failed += 1
        items.push(record)
      }
      const processed = admitted.length
      const pending = concrete.length - processed
      const aggregate = {
        items,
        total: concrete.length,
        pending,
        nextIndex: processed,
        failed,
        truncated: false,
        notes,
      }
      const text = renderReadFiles({ ...args, files: admitted }, aggregate, { budget: config.textBudget })
      return {
        text,
        total: concrete.length,
        pending,
        nextIndex: processed,
        failed,
        complete: concrete.length > 0 && pending === 0 && failed === 0 && items.every((item) => item.complete === true),
      }
    },
  }
}
