/**
 * Bounded directory tree for `ops_tree`.
 *
 * Answers "what is in this folder" in one call without a shell and without the
 * glob-then-read round trip. Directories end with `/`; vendor and VCS folders
 * are skipped; credential paths (files and directories) are hidden without
 * leaking counts; depth, entry count and output bytes are capped.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

import path from 'node:path'
import { credentialDenied, isCredentialPath, resolvePath } from './access.js'
import { capText, DEFAULT_TEXT_BUDGET } from './escape.js'

/** Directory names the walk never enters (same set select.js uses). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.svn', '.hg'])

const TREE_RECOVERY = 'Narrow the path, lower depth, or lower max_entries.'

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

function normKey(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value)
}

/**
 * Build an indented tree for one directory.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {{depth:number, maxDepth:number, maxEntries:number, denyCredentialReads?:boolean, textBudget?:number}} opts
 * @param {string} requested
 * @returns {Promise<{text:string, entries:number, truncated:boolean, notes:string[]}>}
 */
export async function buildTree(ctx, exec, opts, requested) {
  if (typeof ctx.fs.listDir !== 'function') {
    throw Object.assign(
      new Error('this host does not expose fs.listDir, so ops_tree cannot list a directory'),
      { code: 'FS_NO_LISTDIR' },
    )
  }
  const denyCred = opts.denyCredentialReads !== false
  const budget = opts.textBudget ?? DEFAULT_TEXT_BUDGET
  const root = await resolvePath(ctx, exec, requested)
  if (denyCred && isCredentialPath(root.displayPath)) {
    throw credentialDenied('ops-lite')
  }
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
    const text = capText(`${root.displayPath}\n(one file)`, {
      budget,
      reason: 'output-budget',
      recovery: TREE_RECOVERY,
    })
    return { text, entries: 1, truncated: text !== `${root.displayPath}\n(one file)`, notes }
  }
  if (info.type !== 'directory') {
    throw Object.assign(
      new Error(`cannot list "${root.displayPath}": not a directory (${info.type})`),
      { code: 'FS_NOT_DIRECTORY' },
    )
  }

  const lines = [`${root.displayPath}/`]
  const seen = new Set([normKey(root.displayPath)])

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
      // Check credential fence for BOTH files and directories before printing or recursing.
      if (denyCred && isCredentialPath(childDisplay)) { skippedCred += 1; continue }
      lines.push(prefix + name + (isDir ? '/' : ''))
      entries += 1
      if (isDir && level < depth) {
        let childTarget = child.target
        if (childTarget === undefined) {
          try { childTarget = (await resolvePath(ctx, exec, childDisplay)).target } catch { childTarget = undefined }
        }
        const key = normKey(typeof childTarget?.displayPath === 'string' ? childTarget.displayPath : childDisplay)
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
  const rawText = `${lines.join('\n')}\n\n${footer}${notes.length > 0 ? `\n(${notes.join('; ')})` : ''}`
  const text = capText(rawText, { budget, reason: 'output-budget', recovery: TREE_RECOVERY })
  return { text, entries, truncated: truncated || text !== rawText, notes }
}
