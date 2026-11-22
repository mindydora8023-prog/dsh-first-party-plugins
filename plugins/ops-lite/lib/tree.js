/**
 * Bounded directory tree for `ops_tree`.
 *
 * Answers "what is in this folder" in one call without a shell and without the
 * glob-then-read round trip. Directories end with `/`; vendor and VCS folders
 * are skipped; credential paths are hidden; depth and entry count are capped.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import path from 'node:path'
import { isCredentialPath, resolvePath } from './access.js'

/** Directory names the walk never enters (same set select.js uses). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.svn', '.hg'])

function compareName(left, right) {
  const a = String(left.name).toLowerCase()
  const b = String(right.name).toLowerCase()
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function displayOf(child, directory) {
  return typeof child?.target?.displayPath === 'string'
    ? child.target.displayPath
    : path.join(directory, String(child.name))
}

/**
 * Build an indented tree for one directory.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {{depth:number, maxEntries:number}} opts
 * @param {string} requested
 * @returns {Promise<{text:string, entries:number, truncated:boolean, notes:string[]}>}
 */
export async function buildTree(ctx, exec, opts, requested) {
  if (typeof ctx.fs.listDir !== 'function') {
    throw Object.assign(new Error('this host does not expose fs.listDir, so ops_tree cannot list a directory'), { code: 'FS_NO_LISTDIR' })
  }
  const root = await resolvePath(ctx, exec, requested)
  const info = await ctx.fs.stat(root.target, exec?.signal)
  if (info === undefined) {
    throw Object.assign(new Error(`cannot list "${root.displayPath}": not found`), { code: 'FS_NOT_FOUND' })
  }
  const depth = Math.max(0, Math.min(Math.trunc(opts.depth), opts.maxDepth))
  const maxEntries = Math.max(1, opts.maxEntries)
  const notes = []
  let entries = 0
  let truncated = false
  let skippedVendor = 0
  let skippedCred = 0

  if (info.type === 'file') {
    return { text: `${root.displayPath}\n(one file)`, entries: 1, truncated: false, notes }
  }
  if (info.type !== 'directory') {
    throw Object.assign(new Error(`cannot list "${root.displayPath}": not a directory (${info.type})`), { code: 'FS_NOT_DIRECTORY' })
  }

  const lines = [`${root.displayPath}/`]
  const seen = new Set()

  async function walk(target, directory, level, prefix) {
    let children
    try {
      children = await ctx.fs.listDir(target, exec?.signal)
    } catch (error) {
      notes.push(`could not list ${directory} (${error?.message ?? String(error)})`)
      return
    }
    const list = (Array.isArray(children) ? children : []).slice().sort(compareName)
    for (const child of list) {
      if (entries >= maxEntries) { truncated = true; return }
      const name = String(child.name)
      const isDir = child.type === 'directory'
      const childDisplay = displayOf(child, directory)
      if (isDir && SKIP_DIRS.has(name.toLowerCase())) { skippedVendor += 1; continue }
      if (!isDir && isCredentialPath(childDisplay)) { skippedCred += 1; continue }
      lines.push(prefix + name + (isDir ? '/' : ''))
      entries += 1
      if (isDir && level < depth) {
        let childTarget = child.target
        if (childTarget === undefined) {
          try { childTarget = (await resolvePath(ctx, exec, childDisplay)).target } catch { childTarget = undefined }
        }
        const key = typeof childTarget?.displayPath === 'string' ? childTarget.displayPath : childDisplay
        if (childTarget !== undefined && !seen.has(key)) {
          seen.add(key)
          await walk(childTarget, childDisplay, level + 1, prefix + '  ')
        }
      }
    }
  }

  await walk(root.target, root.displayPath, 0, '')
  if (skippedVendor > 0) notes.push(`skipped ${skippedVendor} vendor/VCS folder(s)`)
  if (skippedCred > 0) notes.push(`hid ${skippedCred} credential path(s)`)
  if (truncated) notes.push(`stopped at ${maxEntries} entries; raise max_entries or narrow the path`)
  const footer = truncated ? `(truncated at ${entries} entries)` : `(${entries} entries)`
  const text = `${lines.join('\n')}\n\n${footer}${notes.length > 0 ? `\n(${notes.join('; ')})` : ''}`
  return { text, entries, truncated, notes }
}
