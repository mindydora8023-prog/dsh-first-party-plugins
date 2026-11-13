/**
 * Access layer over the host filesystem service (`ctx.fs`).
 *
 * Two reasons not to use `node:fs` directly:
 *
 * 1. The host owns path identity, containment and the sandbox swap. Reading
 *    through its service means identical behaviour in read-only,
 *    workspace-write and danger-full-access sessions instead of a second,
 *    weaker implementation of the same fence.
 * 2. `ctx.emit('fs/observed', ...)` records the read in the host's
 *    read-before-edit table, so a file read here can be edited with the host
 *    `edit`/`write` tools immediately. Skipping it is what produces "the file
 *    has not been read" on the next host edit.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import { Buffer } from 'node:buffer'
import { basename } from 'node:path'

/** The session workspace cwd for a call, or undefined for a non-agent caller. */
export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

/** Directory names that hold key material or cloud credentials. */
const DENY_DIRS = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.password-store',
])

/** Exact file names that are credential stores. */
const DENY_FILES = new Set([
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.gitconfig',
  'credentials', 'credentials.json', 'credentials.yaml', 'credentials.yml',
  'secrets.json', 'secrets.yaml', 'secrets.yml',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.env',
])

/** Suffix patterns for private key and keystore files. */
const DENY_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks']

/**
 * Whether a resolved path is credential material this plugin refuses.
 *
 * This is a lexical check over the resolved path, not a security boundary: it
 * exists so a model cannot casually pull a private key into context even in
 * danger-full-access, where the host would otherwise permit the read.
 *
 * @param {string} absPath - the backend-resolved display path.
 * @returns {boolean} true when the path must be refused.
 */
export function isCredentialPath(absPath) {
  const parts = String(absPath).split(/[\\/]+/).filter((part) => part.length > 0)
  for (const part of parts) if (DENY_DIRS.has(part.toLowerCase())) return true
  const name = basename(String(absPath)).toLowerCase()
  if (DENY_FILES.has(name)) return true
  if (name.startsWith('.env.') || name.endsWith('.env')) return true
  for (const suffix of DENY_SUFFIXES) if (name.endsWith(suffix)) return true
  if (/credential|secret/i.test(name) && /\.(json|ya?ml|ini|conf|txt|env)$/i.test(name)) return true
  return false
}

/**
 * Resolve a model-supplied path in the caller's workspace.
 * @param {object} ctx - plugin context holding the `fs` service.
 * @param {object} exec - tool execution context.
 * @param {string} requested - the path as supplied by the model.
 * @returns {Promise<{target: object, displayPath: string, cwd: string|undefined}>}
 */
export async function resolvePath(ctx, exec, requested) {
  const cwd = sessionCwd(exec)
  const target = await ctx.fs.resolve(requested, {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec?.signal,
  })
  return { target, displayPath: target.displayPath, cwd }
}

/**
 * Stat a resolved target, requiring a regular file.
 * @param {object} ctx - plugin context.
 * @param {object} exec - tool execution context.
 * @param {object} resolved - `{target, displayPath}`.
 * @returns {Promise<{type: string, size?: number, version: string}>}
 */
export async function statTarget(ctx, exec, resolved) {
  const info = await ctx.fs.stat(resolved.target, exec?.signal)
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
 * Read a resolved target's bytes, recording the observation for the host.
 * @param {object} ctx - plugin context.
 * @param {object} exec - tool execution context.
 * @param {object} resolved - `{target, displayPath}`.
 * @param {object} info - the stat result.
 * @param {number} maxBytes - refuse anything larger before reading.
 * @returns {Promise<Buffer>}
 */
export async function readBytes(ctx, exec, resolved, info, maxBytes) {
  if (typeof info.size === 'number' && info.size > maxBytes) {
    const error = new Error(
      `cannot read "${resolved.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`,
    )
    error.code = 'FS_TOO_LARGE'
    throw error
  }
  const bytes = await ctx.fs.readBytes(resolved.target, exec?.signal, maxBytes)
  ctx.emit('fs/observed', resolved.target, { kind: 'present', version: info.version }, exec)
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

/**
 * Decode UTF-8 strictly; a BOM is stripped, invalid bytes are an explicit error.
 *
 * Lossy decoding would silently corrupt the model's view of a file and invite a
 * write that destroys the real bytes, so a binary or non-UTF-8 file is refused
 * with a pointer at the reader that can handle it.
 *
 * @param {Buffer} buffer - the file bytes.
 * @param {string} displayPath - path shown in the error.
 * @returns {string} the decoded text.
 */
export function decodeUtf8(buffer, displayPath) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  // Scan the WHOLE buffer, not just the first 8 KiB: a file whose text head is
  // followed by binary content would otherwise slip through and be decoded with
  // embedded U+0000. The one O(n) scan is negligible next to the decode below.
  if (bytes.includes(0)) {
    const error = new Error(
      `cannot read "${displayPath}": binary content (NUL byte found). `
        + 'Use a document reader or the host hex reader instead of a text read.',
    )
    error.code = 'FS_NOT_TEXT'
    throw error
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    const error = new Error(
      `cannot read "${displayPath}": the file is not valid UTF-8. `
        + 'Open it with a document reader or the host hex view instead of lossy text replacement.',
    )
    error.code = 'FS_NOT_TEXT'
    throw error
  }
}
