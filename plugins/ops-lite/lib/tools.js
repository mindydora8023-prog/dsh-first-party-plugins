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
import { decodeUtf8, isCredentialPath, readBytes, resolvePath, statTarget } from './access.js'
import { buildWindow } from './text.js'
import { failure, fromThrown } from './outcome.js'
import { renderReadFiles } from './render.js'

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
    // Budget check happens here, before the bytes are read: an entry that does
    // not fit stays pending and must not appear in the observation table.
    if (overrides.remainingBytes !== undefined && estimatedCost(info.size) > overrides.remainingBytes) {
      return { skipped: true }
    }
    const buffer = await readBytes(ctx, exec, resolved, info, config.maxFileBytes)
    const body = decodeUtf8(buffer, resolved.displayPath)

    const offset = boundedInt(entry.offset, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = boundedInt(entry.limit, config.defaultLimit, 1, config.maxLimit)
    if (offset > body.split('\n').length && body.length > 0 && offset !== 1) {
      return {
        path: resolved.displayPath,
        ...failure('OFFSET_OUT_OF_RANGE', {
          message: `offset ${offset} is past the end of a file with ${body.split('\n').length} line slots`,
          nextAction: 'Re-read with a valid offset, or omit offset to read from the first line.',
        }),
      }
    }

    const window = buildWindow(body, {
      offset,
      limit,
      maxLineLength: overrides.maxLineLength ?? config.maxLineLength,
      maxBytes: config.maxOutputBytes,
    })

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
      'Read bounded, line-numbered windows from 1 to N UTF-8 files in one call. Each file takes its '
      + 'own offset and limit, so one call can pull the tops of several files instead of several separate '
      + 'reads. Output is capped per line, per file and per call; a cut window names the offset to resume '
      + 'from, and a clipped line says so rather than silently shortening the source. Every file reports '
      + 'its own completeness plus a batch-level pending count, so a partial read never looks finished. '
      + 'Binary and non-UTF-8 files are refused instead of decoded lossily.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: `Files to read: at most ${config.maxFiles} entries, each {path, offset?, limit?}. `
          + 'offset is 1-based and defaults to 1.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path, resolved against the session workspace.' },
            offset: { type: 'integer', description: '1-based first line to return. Default 1.' },
            limit: {
              type: 'integer',
              description: `Maximum lines for this file. Default ${config.defaultLimit}, maximum ${config.maxLimit}.`,
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

      const items = []
      let failed = 0
      let spent = 0
      let processed = 0
      const overrides = {
        maxLineLength: boundedInt(args?.max_line_length, config.maxLineLength, 80, config.maxLineLength),
      }
      for (const entry of list) {
        // The first entry is always attempted, so one oversized file cannot make
        // the call return nothing and leave every entry pending forever.
        const remaining = processed === 0 ? undefined : Math.max(0, config.callMaxBytes - spent)
        const record = await readOne(ctx, exec, config, entry, { ...overrides, remainingBytes: remaining })
        if (record.skipped === true) break
        spent += estimatedCost(record.bytes)
        processed += 1
        if (record.error !== undefined) failed += 1
        items.push(record)
      }

      const pending = list.length - processed
      const aggregate = {
        items,
        total: list.length,
        pending,
        nextIndex: processed,
        failed,
        truncated: false,
      }
      const text = renderReadFiles(args, aggregate, { budget: config.textBudget })
      return {
        text,
        total: list.length,
        pending,
        nextIndex: processed,
        failed,
        complete: pending === 0 && failed === 0 && items.every((item) => item.complete === true),
      }
    },
  }
}
