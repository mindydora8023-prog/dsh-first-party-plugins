/**
 * Access layer over the host filesystem service (`ctx.fs`).
 *
 * Why go through `ctx.fs` instead of `node:fs`:
 *   1. The host owns path identity, containment and the sandbox swap; reading
 *      through its service means filekit behaves the same in read-only,
 *      workspace-write and danger-full-access sessions.
 *   2. `ctx.emit('fs/observed', ...)` records the read in the host's
 *      read-before-edit table, so a file read with filekit can be edited with
 *      the host `edit`/`write` tools right away (no "has not been read").
 *
 * The service surface used here is intentionally tiny:
 *   resolve(path, {cwd, signal}) -> { targetKey, displayPath }
 *   stat(target, signal)         -> { type, size, version } | undefined
 *   readBytes(target, signal, maxBytes) -> Buffer
 */

/** Session workspace cwd for a call, or undefined for a non-agent caller. */
export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

/**
 * Resolve a model-supplied path in the caller's workspace.
 * @returns {Promise<{target:object, displayPath:string, cwd:string|undefined}>}
 */
export async function resolvePath(ctx, exec, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error('path must be a non-empty string')
  }
  const cwd = sessionCwd(exec)
  const target = await ctx.fs.resolve(requested, {
    ...(cwd !== undefined ? { cwd } : {}),
    signal: exec?.signal,
  })
  return { target, displayPath: target.displayPath, cwd }
}

/**
 * Stat a resolved target, optionally requiring a regular file.
 * @returns {Promise<{type:string, size:number, version:string}>}
 */
export async function statTarget(ctx, exec, resolved, { requireFile = true } = {}) {
  const info = await ctx.fs.stat(resolved.target, exec?.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', resolved.target, { kind: 'absent' }, exec)
    throw new Error(`cannot read "${resolved.displayPath}": not found`)
  }
  if (requireFile && info.type !== 'file') {
    throw new Error(`cannot read "${resolved.displayPath}": not a regular file (${info.type})`)
  }
  return info
}

/**
 * Read at most `maxBytes` from a resolved target and record the observation.
 * @returns {Promise<Buffer>}
 */
export async function readBytes(ctx, exec, resolved, info, maxBytes) {
  if (typeof info.size === 'number' && info.size > maxBytes) {
    throw new Error(
      `cannot read "${resolved.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`,
    )
  }
  const buffer = await ctx.fs.readBytes(resolved.target, exec?.signal, maxBytes)
  ctx.emit('fs/observed', resolved.target, { kind: 'present', version: info.version }, exec)
  return buffer
}
