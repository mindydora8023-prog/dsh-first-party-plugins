/**
 * Turn one requested entry into the concrete files a read will open.
 *
 * A path may name a file, a directory, or a glob (`*`, `?`, `**`). This is the
 * part of dsh-ops file batching that removes the "glob, then read the hits one
 * by one" round trip, without a discovery loop or a second tool.
 *
 * Deliberately small: no brace expansion, no character classes, no symlink
 * following beyond what `ctx.fs` already resolves. Vendor directories are not
 * walked. Credential paths are dropped during traversal so a wide pattern
 * cannot pull them into the read or consume budget slots.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import path from 'node:path'
import { isCredentialPath, resolvePath } from './access.js'

/** Directory names a recursive walk never enters. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.svn', '.hg'])

/** Extensions that are never useful as a text read. */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.doc', '.docx',
  '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.gz', '.tgz', '.7z', '.wasm',
  '.exe', '.dll', '.pdb', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.eot',
  '.bin', '.pyc', '.class', '.jar',
])

const MAX_DEPTH = 12
const MAX_VISITS = 2000
const OVERFLOW_PEEK = 16

/** True when a path uses glob metacharacters this module understands. */
export function hasGlob(value) {
  return /[*?]/.test(String(value))
}

/** A file a directory listing should offer to a text reader. */
export function isTextCandidate(name) {
  const ext = path.extname(String(name)).toLowerCase()
  if (ext === '') return true
  return !BINARY_EXT.has(ext)
}

/**
 * Split a pattern into a concrete prefix and the glob segments after it.
 * Handles relative paths, POSIX absolute `/...`, Windows drive roots `C:\...`,
 * and UNC paths `\\server\share\...`.
 *
 * @param {string} pattern
 * @returns {{ base: string, segments: string[] }}
 */
export function splitPattern(pattern) {
  const raw = String(pattern)
  let prefix = ''
  let rest = raw

  const unc = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)(?:[\\/](.*))?$/.exec(raw)
  if (unc) {
    const serverShare = unc[1].replace(/^[\\/]+/, '').split(/[\\/]+/).join(path.sep)
    prefix = `${path.sep}${path.sep}${serverShare}`
    rest = unc[2] ?? ''
  } else if (/^[A-Za-z]:[\\/]/.test(raw)) {
    prefix = `${raw.slice(0, 2)}${path.sep}`
    rest = raw.slice(3)
  } else if (/^[A-Za-z]:/.test(raw)) {
    prefix = raw.slice(0, 2)
    rest = raw.slice(2)
  } else if (raw.startsWith('/') || raw.startsWith('\\')) {
    prefix = raw.startsWith('/') ? '/' : path.sep
    rest = raw.replace(/^[\\/]+/, '')
  }

  const parts = rest.split(/[\\/]+/).filter((part) => part !== '')
  const baseParts = []
  let index = 0
  while (index < parts.length && !/[*?]/.test(parts[index])) {
    baseParts.push(parts[index])
    index += 1
  }
  const segments = parts.slice(index).filter((part) => part !== '' && part !== '.')

  let base
  if (prefix === '') {
    base = baseParts.length > 0 ? baseParts.join(path.sep) : '.'
  } else if (prefix === '/') {
    base = baseParts.length > 0 ? `/${baseParts.join('/')}` : '/'
  } else if (prefix.endsWith(path.sep)) {
    base = baseParts.length > 0 ? `${prefix}${baseParts.join(path.sep)}` : prefix
  } else if (/^[A-Za-z]:$/.test(prefix)) {
    base = baseParts.length > 0 ? `${prefix}${baseParts.join(path.sep)}` : prefix
  } else {
    base = baseParts.length > 0 ? `${prefix}${path.sep}${baseParts.join(path.sep)}` : prefix
  }
  return { base, segments }
}

/**
 * Compile one glob segment (`*` and `?` only) into a RegExp once.
 * @param {string} segment
 * @returns {RegExp}
 */
function compileSegment(segment) {
  let expression = '^'
  for (const char of segment) {
    if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  expression += '$'
  const flags = process.platform === 'win32' ? 'i' : ''
  return new RegExp(expression, flags)
}

/**
 * Whether one path segment matches a glob segment (`*` and `?` only).
 *
 * @param {string} segment
 * @param {string} name
 * @returns {boolean}
 */
export function segmentMatch(segment, name) {
  return compileSegment(segment).test(name)
}

function compareName(left, right) {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

function normKey(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value)
}

async function listChildren(ctx, exec, directoryPath) {
  const resolved = await resolvePath(ctx, exec, directoryPath)
  const info = await ctx.fs.stat(resolved.target, exec?.signal)
  if (info === undefined || info.type !== 'directory') return []
  if (typeof ctx.fs.listDir !== 'function') return []
  const entries = await ctx.fs.listDir(resolved.target, exec?.signal)
  return (Array.isArray(entries) ? entries : []).slice().sort(compareName)
}

function childPath(directory, child) {
  if (child?.target?.displayPath) return child.target.displayPath
  return path.join(directory, String(child.name))
}

function displayOf(child, fallback) {
  return typeof child?.target?.displayPath === 'string' ? child.target.displayPath : fallback
}

/**
 * Walk `directory` for files matching `segments[segIdx..]`, appending display paths.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {string} directory
 * @param {string[]} segments
 * @param {(RegExp|null)[]} matchers
 * @param {number} segIdx
 * @param {string[]} out
 * @param {object} state
 * @param {object[]|null} [prefetchedChildren]
 * @returns {Promise<void>}
 */
async function walk(ctx, exec, directory, segments, matchers, segIdx, out, state, prefetchedChildren = null) {
  if (state.capped || out.length >= state.cap || segIdx >= segments.length) return
  const visitKey = `${normKey(directory)}\0${segIdx}`
  if (state.seen.has(visitKey)) return
  state.seen.add(visitKey)
  if (state.depth > MAX_DEPTH || state.visits >= MAX_VISITS) {
    state.capped = true
    return
  }
  state.visits += 1

  let children = prefetchedChildren
  if (children === null) {
    try {
      children = await listChildren(ctx, exec, directory)
    } catch {
      return
    }
  }

  const head = segments[segIdx]
  if (head === '**') {
    if (segIdx + 1 < segments.length) {
      // Reuse `children` when matching zero directories to avoid a second listDir IPC.
      await walk(ctx, exec, directory, segments, matchers, segIdx + 1, out, state, children)
    }
    for (const child of children) {
      if (state.capped || out.length >= state.cap) return
      if (child.type !== 'directory') continue
      if (SKIP_DIRS.has(String(child.name).toLowerCase())) continue
      const next = childPath(directory, child)
      if (state.denyCredentialReads && isCredentialPath(next)) {
        state.skippedCred += 1
        continue
      }
      state.depth += 1
      await walk(ctx, exec, next, segments, matchers, segIdx, out, state, null)
      state.depth -= 1
    }
    return
  }

  const re = matchers[segIdx]
  const isLast = segIdx === segments.length - 1
  for (const child of children) {
    if (state.capped || out.length >= state.cap) return
    if (!re.test(String(child.name))) continue
    const next = childPath(directory, child)
    if (isLast) {
      if (child.type !== 'file' || !isTextCandidate(child.name)) continue
      const display = displayOf(child, next)
      if (state.denyCredentialReads && isCredentialPath(display)) {
        state.skippedCred += 1
        continue
      }
      const key = normKey(display)
      if (!state.foundSet.has(key)) {
        state.foundSet.add(key)
        out.push(display)
      }
      continue
    }
    if (child.type !== 'directory') continue
    if (SKIP_DIRS.has(String(child.name).toLowerCase())) continue
    if (state.denyCredentialReads && isCredentialPath(next)) {
      state.skippedCred += 1
      continue
    }
    state.depth += 1
    await walk(ctx, exec, next, segments, matchers, segIdx + 1, out, state, null)
    state.depth -= 1
  }
}

function copyEntry(entry, filePath) {
  const next = { path: filePath }
  if (entry.offset !== undefined) next.offset = entry.offset
  if (entry.limit !== undefined) next.limit = entry.limit
  if (entry.literal !== undefined) next.literal = entry.literal
  if (entry.around !== undefined) next.around = entry.around
  return next
}

function dropCredentials(paths, denyCredentialReads) {
  if (!denyCredentialReads) return { kept: paths, skipped: 0 }
  const kept = []
  let skipped = 0
  for (const filePath of paths) {
    if (isCredentialPath(filePath)) skipped += 1
    else kept.push(filePath)
  }
  return { kept, skipped }
}

/**
 * Expand one caller entry into concrete file entries.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {object} entry
 * @param {number} cap - maximum files this entry may contribute.
 * @param {{ denyCredentialReads?: boolean }} [options]
 * @returns {Promise<{ entries: object[], notes: string[], dropped: number }>}
 */
export async function expandEntry(ctx, exec, entry, cap, options = {}) {
  const denyCredentialReads = options.denyCredentialReads !== false
  const notes = []
  const requested = typeof entry?.path === 'string' ? entry.path : ''
  if (requested === '' || cap <= 0) return { entries: [], notes, dropped: 0 }

  if (!hasGlob(requested)) {
    try {
      const resolved = await resolvePath(ctx, exec, requested)
      if (denyCredentialReads && isCredentialPath(resolved.displayPath)) {
        return { entries: [copyEntry(entry, requested)], notes, dropped: 0 }
      }
      const info = await ctx.fs.stat(resolved.target, exec?.signal)
      if (info?.type === 'directory') {
        const children = await listChildren(ctx, exec, resolved.displayPath)
        const files = children
          .filter((child) => child.type === 'file' && isTextCandidate(child.name))
          .map((child) => displayOf(child, path.join(resolved.displayPath, child.name)))
        const { kept, skipped } = dropCredentials(files, denyCredentialReads)
        if (skipped > 0) notes.push(`skipped ${skipped} credential path(s)`)
        if (kept.length === 0) {
          notes.push(`directory ${JSON.stringify(requested)} has no text files`)
          return { entries: [], notes, dropped: 0 }
        }
        const taken = kept.slice(0, cap)
        const dropped = kept.length - taken.length
        if (dropped > 0) {
          notes.push(`directory ${JSON.stringify(requested)} has ${kept.length} text files; returned ${taken.length}`)
        }
        return { entries: taken.map((filePath) => copyEntry(entry, filePath)), notes, dropped }
      }
    } catch {
      /* a missing file stays one entry so the read reports a structured failure */
    }
    return { entries: [copyEntry(entry, requested)], notes, dropped: 0 }
  }

  const { base, segments: rawSegments } = splitPattern(requested)
  const segments = rawSegments.filter((seg, idx) => !(seg === '**' && rawSegments[idx - 1] === '**'))
  if (segments.length === 0) return { entries: [copyEntry(entry, requested)], notes, dropped: 0 }

  const matchers = segments.map((seg) => (seg === '**' ? null : compileSegment(seg)))
  const found = []
  const state = {
    visits: 0,
    capped: false,
    depth: 0,
    cap: cap + OVERFLOW_PEEK,
    seen: new Set(),
    foundSet: new Set(),
    denyCredentialReads,
    skippedCred: 0,
  }
  try {
    const resolved = await resolvePath(ctx, exec, base)
    if (denyCredentialReads && isCredentialPath(resolved.displayPath)) {
      notes.push('skipped 1 credential path(s)')
      notes.push(`pattern ${JSON.stringify(requested)} matched 0 files`)
      return { entries: [], notes, dropped: 0 }
    }
    await walk(ctx, exec, resolved.displayPath, segments, matchers, 0, found, state, null)
  } catch {
    notes.push(`pattern ${JSON.stringify(requested)} matched 0 files`)
    return { entries: [], notes, dropped: 0 }
  }
  if (state.skippedCred > 0) notes.push(`skipped ${state.skippedCred} credential path(s)`)
  if (state.capped) notes.push(`walk stopped early for ${JSON.stringify(requested)}; narrow the pattern`)
  if (found.length === 0) {
    notes.push(`pattern ${JSON.stringify(requested)} matched 0 files`)
    return { entries: [], notes, dropped: 0 }
  }
  const taken = found.slice(0, cap)
  const dropped = found.length - taken.length
  if (dropped > 0) {
    const rest = found.slice(taken.length).map((filePath) => path.basename(filePath))
    notes.push(
      `pattern ${JSON.stringify(requested)} matched ${found.length}; not returned: ${rest.slice(0, OVERFLOW_PEEK).join(', ')}`,
    )
  }
  return { entries: taken.map((filePath) => copyEntry(entry, filePath)), notes, dropped }
}
