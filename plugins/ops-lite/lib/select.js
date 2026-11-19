/**
 * Turn one requested entry into the concrete files a read will open.
 *
 * A path may name a file, a directory, or a glob (`*`, `?`, `**`). This is the
 * part of dsh-ops file batching that removes the "glob, then read the hits one
 * by one" round trip, without a discovery loop or a second tool.
 *
 * Deliberately small: no brace expansion, no character classes, no symlink
 * following beyond what `ctx.fs` already resolves. Vendor directories are not
 * walked. Credential paths are dropped here so a wide pattern cannot pull them
 * into the read.
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
 *
 * @param {string} pattern
 * @returns {{ base: string, segments: string[] }}
 */
export function splitPattern(pattern) {
  const parts = String(pattern).split(/[\\/]+/)
  const base = []
  let index = 0
  if (parts[0] === '') {
    base.push('')
    index = 1
  }
  if (/^[A-Za-z]:$/.test(parts[0] ?? '')) {
    base.push(parts[0])
    index = 1
  }
  while (index < parts.length && !/[*?]/.test(parts[index])) {
    base.push(parts[index])
    index += 1
  }
  const segments = parts.slice(index).filter((part) => part !== '' && part !== '.')
  const joined = base.filter((part) => part !== '').join(path.sep)
  return { base: joined === '' ? '.' : joined, segments }
}

/**
 * Whether one path segment matches a glob segment (`*` and `?` only).
 *
 * @param {string} segment
 * @param {string} name
 * @returns {boolean}
 */
export function segmentMatch(segment, name) {
  let expression = '^'
  for (const char of segment) {
    if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  expression += '$'
  const flags = process.platform === 'win32' ? 'i' : ''
  return new RegExp(expression, flags).test(name)
}

function compareName(left, right) {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

async function listChildren(ctx, exec, directoryPath) {
  const resolved = await resolvePath(ctx, exec, directoryPath)
  const info = await ctx.fs.stat(resolved.target, exec?.signal)
  if (info === undefined || info.type !== 'directory') return []
  if (typeof ctx.fs.listDir !== 'function') return []
  const entries = await ctx.fs.listDir(resolved.target, exec?.signal)
  return (Array.isArray(entries) ? entries : []).slice().sort(compareName)
}

/**
 * Walk `directory` for files matching `segments`, appending display paths.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {string} directory
 * @param {string[]} segments
 * @param {string[]} out
 * @param {{ visits: number, capped: boolean, depth: number }} state
 * @returns {Promise<void>}
 */
async function walk(ctx, exec, directory, segments, out, state) {
  if (state.capped || out.length >= state.cap || segments.length === 0) return
  if (state.depth > MAX_DEPTH || state.visits >= MAX_VISITS) {
    state.capped = true
    return
  }
  state.visits += 1
  const [head, ...rest] = segments
  let children
  try {
    children = await listChildren(ctx, exec, directory)
  } catch {
    return
  }
  if (head === '**') {
    await walk(ctx, exec, directory, rest, out, state)
    const dirKey = process.platform === 'win32' ? directory.toLowerCase() : directory
    if (state.seen.has(dirKey)) return
    state.seen.add(dirKey)
    for (const child of children) {
      if (child.type !== 'directory') continue
      if (SKIP_DIRS.has(String(child.name).toLowerCase())) continue
      state.depth += 1
      await walk(ctx, exec, childPath(directory, child), segments, out, state)
      state.depth -= 1
    }
    return
  }
  for (const child of children) {
    if (!segmentMatch(head, String(child.name))) continue
    const next = childPath(directory, child)
    if (rest.length === 0) {
      if (child.type === 'file' && isTextCandidate(child.name)) out.push(displayOf(child, next))
      continue
    }
    if (child.type !== 'directory') continue
    if (SKIP_DIRS.has(String(child.name).toLowerCase())) continue
    state.depth += 1
    await walk(ctx, exec, next, rest, out, state)
    state.depth -= 1
  }
}

function childPath(directory, child) {
  if (child?.target?.displayPath) return child.target.displayPath
  return path.join(directory, String(child.name))
}

function displayOf(child, fallback) {
  return typeof child?.target?.displayPath === 'string' ? child.target.displayPath : fallback
}

function copyEntry(entry, filePath) {
  const next = { path: filePath }
  if (entry.offset !== undefined) next.offset = entry.offset
  if (entry.limit !== undefined) next.limit = entry.limit
  if (entry.literal !== undefined) next.literal = entry.literal
  if (entry.around !== undefined) next.around = entry.around
  return next
}

function dropCredentials(paths) {
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
 * @returns {Promise<{ entries: object[], notes: string[] }>}
 */
export async function expandEntry(ctx, exec, entry, cap) {
  const notes = []
  const requested = typeof entry?.path === 'string' ? entry.path : ''
  if (requested === '' || cap <= 0) return { entries: [], notes }

  if (!hasGlob(requested)) {
    try {
      const resolved = await resolvePath(ctx, exec, requested)
      const info = await ctx.fs.stat(resolved.target, exec?.signal)
      if (info?.type === 'directory') {
        const children = await listChildren(ctx, exec, resolved.displayPath)
        const files = children
          .filter((child) => child.type === 'file' && isTextCandidate(child.name))
          .map((child) => displayOf(child, path.join(resolved.displayPath, child.name)))
        const { kept, skipped } = dropCredentials(files)
        if (skipped > 0) notes.push(`skipped ${skipped} credential path(s)`)
        if (kept.length === 0) {
          notes.push(`directory ${JSON.stringify(requested)} has no text files`)
          return { entries: [], notes }
        }
        const taken = kept.slice(0, cap)
        if (kept.length > taken.length) {
          notes.push(`directory ${JSON.stringify(requested)} has ${kept.length} text files; returned ${taken.length}`)
        }
        return { entries: taken.map((filePath) => copyEntry(entry, filePath)), notes }
      }
    } catch {
      /* a missing file stays one entry so the read reports a structured failure */
    }
    return { entries: [copyEntry(entry, requested)], notes }
  }

  const { base, segments } = splitPattern(requested)
  if (segments.length === 0) return { entries: [copyEntry(entry, requested)], notes }
  const found = []
  const state = { visits: 0, capped: false, depth: 0, cap: cap + 1, seen: new Set() }
  try {
    const resolved = await resolvePath(ctx, exec, base)
    await walk(ctx, exec, resolved.displayPath, segments, found, state)
  } catch {
    notes.push(`pattern ${JSON.stringify(requested)} matched 0 files`)
    return { entries: [], notes }
  }
  const { kept, skipped } = dropCredentials(found)
  if (skipped > 0) notes.push(`skipped ${skipped} credential path(s)`)
  if (state.capped) notes.push(`walk stopped early for ${JSON.stringify(requested)}; narrow the pattern`)
  if (kept.length === 0) {
    notes.push(`pattern ${JSON.stringify(requested)} matched 0 files`)
    return { entries: [], notes }
  }
  const taken = kept.slice(0, cap)
  if (kept.length > taken.length) {
    const rest = kept.slice(taken.length).map((filePath) => path.basename(filePath))
    notes.push(
      `pattern ${JSON.stringify(requested)} matched ${kept.length}; not returned: ${rest.slice(0, 16).join(', ')}`,
    )
  }
  return { entries: taken.map((filePath) => copyEntry(entry, filePath)), notes }
}
