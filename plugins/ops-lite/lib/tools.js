/**
 * The ops_read_files and ops_tree tools.
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

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { decodeUtf8, isCredentialPath, readBytes, resolvePath, statTarget } from './access.js'
import { capText } from './escape.js'
import { buildWindow, lineOfLiteral } from './text.js'
import { failure, fromThrown } from './outcome.js'
import { renderFailure, renderReadFiles } from './render.js'
import { expandEntry, hasGlob } from './select.js'

/** How many file bodies may be in flight at once. dsh-ops uses the same bound. */
const READ_CONCURRENCY = 2

const TREE_RECOVERY = 'Narrow the path, lower depth, or lower max_entries.'

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
 * @param {number} size - the file's byte size, when known.
 * @returns {number} an upper-bound byte estimate.
 */
function estimatedCost(size) {
  const bytes = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0
  return bytes * 3 + 4096
}

/**
 * Upper bound on the bytes a WINDOWED read can render, capped by the per-file
 * `maxOutputBytes` limit so large files are not over-charged relative to what
 * `buildWindow` can actually emit.
 */
function estimatedReadCost(size, limit, maxLineLength, maxOutputBytes) {
  let cost = estimatedCost(size)
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(maxLineLength) && maxLineLength > 0) {
    const window = limit * (maxLineLength * 3 + 16) + 4096
    cost = Math.min(cost, window)
  }
  if (Number.isFinite(maxOutputBytes) && maxOutputBytes > 0) {
    cost = Math.min(cost, maxOutputBytes)
  }
  return cost
}

/**
 * Actual rendered byte cost of a completed per-file record, subtracted from the
 * call budget between waves so subsequent waves account for real output rather
 * than worst-case estimates.
 */
function renderedCost(record) {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.items)) return 512
  let total = 512
  for (const item of record.items) total += Buffer.byteLength(String(item?.text ?? ''), 'utf8') + 12
  return total
}

/**
 * Validate a pre-fetched `ctx.fs.stat` result with the exact same semantics as
 * `statTarget` (emitting `absent` only once the entry is actually admitted).
 */
function validatePrefetchedStat(ctx, exec, resolved, info) {
  if (info === undefined) {
    ctx.emit('fs/observed', resolved.target, { kind: 'absent' }, exec)
    const error = new Error(`cannot read "${resolved.displayPath}": not found`)
    error.code = 'FS_NOT_FOUND'
    throw error
  }
  if (info.type !== 'file') {
    const error = new Error(`cannot read "${resolved.displayPath}": not a regular file (${info.type})`)
    error.code = 'FS_NOT_REGULAR_FILE'
    throw error
  }
  return info
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
 * @param {object} [prefetched] - cached `{ resolved, hasInfo, info }` from wave admission.
 * @returns {Promise<object>} the per-file record.
 */
async function readOne(ctx, exec, config, entry, overrides = {}, prefetched = undefined) {
  try {
    const resolved = prefetched?.resolved ?? await resolvePath(ctx, exec, entry.path)
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
    const info = prefetched?.hasInfo
      ? validatePrefetchedStat(ctx, exec, resolved, prefetched.info)
      : await statTarget(ctx, exec, resolved)
    let offset = boundedInt(entry.offset, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = boundedInt(entry.limit, config.defaultLimit, 1, config.maxLimit)
    const literal = typeof entry.literal === 'string' ? entry.literal : ''

    // Defer `fs/observed` until decode, literal, and offset validation all succeed.
    const { buffer, markObserved } = await readBytes(
      ctx,
      exec,
      resolved,
      info,
      config.maxFileBytes,
      { deferObserve: true },
    )
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
    // adds no phantom line) instead of `body.split('\n').length`.
    if (offset !== 1 && body.length > 0 && offset > window.lineCount) {
      return {
        path: resolved.displayPath,
        ...failure('OFFSET_OUT_OF_RANGE', {
          message: `offset ${offset} is past the end of a file with ${window.lineCount} lines`,
          nextAction: 'Re-read with a valid offset, or omit offset to read from the first line.',
        }),
      }
    }

    // All validation passed; record the read in the host observation table now.
    markObserved()

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
      // instead of re-deriving them from possibly-omitted or clamped call arguments.
      requestedOffset: offset,
      requestedLimit: limit,
    }
    if (window.truncatedByBytes) record.truncatedBy = 'output-budget'
    if (window.truncatedInLine !== undefined) {
      record.truncatedInLine = true
      record.charactersTotal = window.truncatedInLine.charactersTotal
      record.charactersOmitted = window.truncatedInLine.charactersOmitted
      record.bytesTotal = window.truncatedInLine.bytesTotal
      record.bytesOmitted = window.truncatedInLine.bytesOmitted
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
 * Expand globs and directories, deduplicate paths, and track any entries
 * dropped by `config.maxFiles` so batch completeness stays truthful.
 *
 * @returns {Promise<{concrete: object[], notes: string[], dropped: number}>}
 */
async function expandFiles(ctx, exec, config, list) {
  const notes = []
  const concrete = []
  const seen = new Set()
  const cwd = exec?.agent?.session?.header?.cwd
  let dropped = 0
  let hitCap = false

  for (let idx = 0; idx < list.length; idx += 1) {
    const entry = list[idx]
    if (concrete.length >= config.maxFiles) {
      if (!hitCap) {
        notes.push(`stopped at ${config.maxFiles} files; resend what is missing`)
        hitCap = true
      }
      const requested = typeof entry?.path === 'string' ? entry.path : ''
      if (requested === '') continue
      if (hasGlob(requested)) {
        dropped += 1
      } else {
        const key = fileKey(requested, cwd)
        if (!seen.has(key)) {
          seen.add(key)
          dropped += 1
        }
      }
      continue
    }
    const expanded = await expandEntry(ctx, exec, entry, config.maxFiles - concrete.length, {
      denyCredentialReads: config.denyCredentialReads,
    })
    for (const note of expanded.notes) notes.push(note)
    dropped += expanded.dropped ?? 0
    for (const file of expanded.entries) {
      const key = fileKey(file.path, cwd)
      if (seen.has(key)) {
        notes.push(`duplicate skipped: ${path.basename(file.path)}`)
        continue
      }
      if (concrete.length >= config.maxFiles) {
        seen.add(key)
        dropped += 1
        continue
      }
      seen.add(key)
      concrete.push(file)
    }
  }
  return { concrete, notes, dropped }
}

/**
 * Peek one entry's estimated cost from `resolvePath` + `ctx.fs.stat` only,
 * caching both so `readOne` never repeats those IPC calls.
 *
 * Must NOT emit `fs/observed`: a file rejected by the budget has not been read.
 */
async function peekEntry(ctx, exec, config, entry, overrides) {
  try {
    const resolved = await resolvePath(ctx, exec, entry.path)
    if (config.denyCredentialReads && isCredentialPath(resolved.displayPath)) {
      return { estimate: 512, resolved, hasInfo: false, info: undefined }
    }
    const info = await ctx.fs.stat(resolved.target, exec?.signal)
    if (info === undefined || info.type !== 'file') {
      return { estimate: 4096, resolved, hasInfo: true, info }
    }
    const limit = boundedInt(entry.limit, config.defaultLimit, 1, config.maxLimit)
    const estimate = estimatedReadCost(
      info.size,
      limit,
      overrides.maxLineLength ?? config.maxLineLength,
      config.maxOutputBytes,
    )
    return { estimate, resolved, hasInfo: true, info }
  } catch {
    return { estimate: 4096, resolved: undefined, hasInfo: false, info: undefined }
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
          total: { type: 'integer', description: 'Number of concrete file entries (including any capped beyond maxFiles).' },
          pending: { type: 'integer', description: 'Entries not processed because of maxFiles or call byte budget.' },
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
      const { concrete, notes, dropped } = await expandFiles(ctx, exec, config, list)

      const admitted = []
      const records = []

      if (concrete.length === 1) {
        // Single-file call: always admitted; skip pre-check IPC completely.
        admitted.push(concrete[0])
        records.push(await readOne(ctx, exec, config, concrete[0], overrides))
      } else if (concrete.length > 1) {
        // Admit and read in waves of up to READ_CONCURRENCY. Pre-check caches
        // resolve+stat so readOne never repeats them; between waves, `spent`
        // tracks real rendered bytes rather than worst-case estimates.
        let spent = 0
        let cursor = 0
        const peekCache = new Map()
        while (cursor < concrete.length) {
          const wave = []
          let waveReserved = 0
          while (cursor < concrete.length && wave.length < READ_CONCURRENCY) {
            const entry = concrete[cursor]
            let peek = peekCache.get(cursor)
            if (peek === undefined) {
              peek = await peekEntry(ctx, exec, config, entry, overrides)
            }
            if (admitted.length === 0 && wave.length === 0) {
              wave.push({ entry, peek })
              waveReserved += peek.estimate
              cursor += 1
              continue
            }
            if (spent + waveReserved + peek.estimate > config.callMaxBytes) {
              peekCache.set(cursor, peek)
              break
            }
            wave.push({ entry, peek })
            waveReserved += peek.estimate
            cursor += 1
          }
          if (wave.length === 0) break
          const waveRecords = await Promise.all(
            wave.map(({ entry, peek }) => readOne(ctx, exec, config, entry, overrides, peek)),
          )
          for (let i = 0; i < wave.length; i += 1) {
            admitted.push(wave[i].entry)
            records.push(waveRecords[i])
            spent += renderedCost(waveRecords[i])
          }
        }
      }

      const items = []
      let failed = 0
      for (const record of records) {
        if (record === undefined) continue
        if (record.error !== undefined) failed += 1
        items.push(record)
      }
      const totalConcreteCount = concrete.length + dropped
      const processed = admitted.length
      const budgetPending = concrete.length - processed
      const pending = dropped + budgetPending
      const aggregate = {
        items,
        total: totalConcreteCount,
        pending,
        nextIndex: processed,
        failed,
        truncated: false,
        notes,
      }
      const text = renderReadFiles({ ...args, files: admitted }, aggregate, { budget: config.textBudget })
      return {
        text,
        total: totalConcreteCount,
        pending,
        nextIndex: processed,
        failed,
        complete: totalConcreteCount > 0
          && pending === 0
          && failed === 0
          && items.every((item) => item.complete === true),
      }
    },
  }
}

/**
 * Build the `ops_tree` tool definition: a bounded directory listing.
 *
 * @param {object} ctx - plugin context holding the `fs` service.
 * @param {object} config - resolved plugin config.
 * @returns {object} a tool definition accepted by `tools.register()`.
 */
export function buildTreeTool(ctx, config) {
  return {
    name: 'ops_tree',
    description:
      'List a directory as an indented tree in one call. Directories end with "/". '
      + 'Vendor/VCS folders (node_modules, .git, dist, coverage, .svn, .hg) and credential paths are skipped. '
      + 'Depth and entry count are capped. This lists names only; use ops_read_files for contents.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Directory (or file) to list, resolved against the session workspace. Use "." for the workspace root.',
      },
      depth: {
        type: 'integer',
        description: `Directory depth to descend. Default ${config.treeDefaultDepth}, maximum ${config.treeMaxDepth}.`,
      },
      max_entries: {
        type: 'integer',
        description: `Maximum entries to list. Default ${config.treeMaxEntries}, hard cap ${config.treeMaxEntries}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'text', 'entries', 'truncated'],
        properties: {
          status: {
            type: 'string',
            enum: ['completed', 'error', 'rejected', 'conflict', 'unknown'],
            description: 'Structured call status.',
          },
          text: { type: 'string', description: 'The rendered directory tree or structured failure message.' },
          entries: { type: 'integer', description: 'Number of listed entries.' },
          truncated: { type: 'boolean', description: 'True when entry count or output budget truncated the tree.' },
          error: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'effectState', 'retry', 'message'],
            properties: {
              code: { type: 'string' },
              effectState: { type: 'string' },
              retry: { type: 'string' },
              message: { type: 'string' },
              phase: { type: 'string' },
              reason: { type: 'string' },
              nextAction: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : '.'
      const depth = boundedInt(args?.depth, config.treeDefaultDepth, 0, config.treeMaxDepth)
      const maxEntries = boundedInt(args?.max_entries, config.treeMaxEntries, 1, config.treeMaxEntries)
      const { buildTree } = await import('./tree.js')
      try {
        const result = await buildTree(
          ctx,
          exec,
          {
            depth,
            maxDepth: config.treeMaxDepth,
            maxEntries,
            denyCredentialReads: config.denyCredentialReads,
            textBudget: config.textBudget,
          },
          requested,
        )
        return {
          status: 'completed',
          text: result.text,
          entries: result.entries,
          truncated: result.truncated,
        }
      } catch (error) {
        const nextAction = error?.code === 'CREDENTIAL_DENIED'
          ? 'Do not retry this path. Ask the operator to open it explicitly if it is genuinely needed.'
          : 'Check the path or list its parent directory.'
        const failed = fromThrown(error, { phase: 'tree', nextAction })
        return {
          status: failed.status,
          text: capText(renderFailure(failed), {
            budget: config.textBudget,
            reason: 'result-budget',
            recovery: TREE_RECOVERY,
          }),
          entries: 0,
          truncated: false,
          error: failed.error,
        }
      }
    },
  }
}
