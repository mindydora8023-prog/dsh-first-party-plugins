/**
 * Planning and eligibility rules for archived session deletion and orphan scans.
 *
 * Pure read-only analysis over host headers and workspace membership.
 * ASCII only: user-facing strings live in lib/reasons.js.
 */

import { reason as t } from './reasons.js'

export const fail = (message, status = 409) => Object.assign(new Error(message), { status })

// This extension deliberately fails closed for other persistence implementations.
// Never construct a deletion path from an untrusted session id or its cwd.
export const invalidSessionId = (id) => (
  typeof id !== 'string'
  || !id.trim()
  || id.length > 1024
  || /[\u0000-\u001f\u007f\\/]/.test(id)
  || id === '.'
  || id === '..'
)

export const isLive = (ctx, id) => Boolean(ctx.sessions.get(id) ?? ctx.get('agents')?.get(id))

/** Every header this process can see: stored snapshots plus live sessions, deduplicated by id. */
export async function snapshotHeaders(ctx) {
  const byId = new Map()
  for (const item of await ctx.sessionPersistence.list()) {
    const header = item?.header ?? item
    if (typeof header?.id === 'string' && !byId.has(header.id)) byId.set(header.id, header)
  }
  for (const item of ctx.sessions.list()) {
    const header = item?.header ?? item
    if (typeof header?.id === 'string' && !byId.has(header.id)) byId.set(header.id, header)
  }
  return byId
}

/** Session ids that a workspace accounts for; deleting one of those would corrupt membership. */
export function workspaceMembers(registry) {
  const members = new Set()
  if (typeof registry.list !== 'function') return members
  for (const workspace of registry.list()) {
    for (const id of workspace.sessionIds ?? []) members.add(id)
  }
  return members
}

/** Parent id to child ids, built from headers alone (a parent with no log still names its children). */
export function childIndex(headers) {
  const childrenOf = new Map()
  for (const [childId, header] of headers) {
    const parent = header.parentSession
    if (typeof parent !== 'string' || !parent) continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(childId)
  }
  return childrenOf
}

/**
 * Why one descendant may not be removed, or undefined when it is a plain hidden subagent.
 * Only hidden subagents qualify: a real branch, a workspace-accounted session, an archived
 * session of its own, or a live session is a reason to refuse instead of guessing.
 */
function refuseReason(ctx, childId, header, archived, members) {
  if (header?.origin !== 'subagent') return t('child-not-subagent')
  if (archived.has(childId)) return t('child-archived')
  if (members.has(childId)) return t('child-in-workspace')
  if (isLive(ctx, childId)) return t('child-live')
  return undefined
}

export function rules(ctx, headers) {
  return {
    archived: new Set(ctx.workspaceRegistry.archivedSessionIds),
    members: workspaceMembers(ctx.workspaceRegistry),
    headers,
    // Built once per snapshot and reused by every planDeletion call in a batch,
    // so inspecting N archived ids is O(N + headers), not O(N * headers).
    childIndex: childIndex(headers),
  }
}

/** Walk the parentSession closure below one archived session. */
export function planDeletion(ctx, id, headers, shared) {
  const { archived, members } = shared ?? rules(ctx, headers)
  const childrenOf = shared?.childIndex ?? childIndex(headers)
  const order = []
  const refused = []
  const seen = new Set([id])
  const queue = [{ id, depth: 0 }]
  // Index, not shift: shift copies the queue on every node, so a wide
  // parentSession closure was quadratic in the number of descendants.
  let head = 0
  while (head < queue.length) {
    const current = queue[head]
    head += 1
    for (const childId of childrenOf.get(current.id) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      const reason = refuseReason(ctx, childId, headers.get(childId), archived, members)
      if (reason) {
        refused.push({ id: childId, reason })
        continue
      }
      const entry = { id: childId, depth: current.depth + 1 }
      order.push(entry)
      queue.push(entry)
    }
  }
  return { order, refused }
}

/**
 * Hidden subagents whose parent session has no log at all. Nothing else in the product
 * surfaces them: they are absent from every list and no archive entry names them, so
 * without this pass they can never be removed.
 */
export function planOrphans(ctx, headers, shared) {
  const { archived, members } = shared ?? rules(ctx, headers)
  const orphans = []
  const blocked = []
  for (const [id, header] of headers) {
    if (header.origin !== 'subagent') continue
    const parent = header.parentSession
    if (typeof parent !== 'string' || !parent) continue
    if (headers.has(parent)) continue
    // An archived parent with no log is still reachable: deleting that archive record
    // cascades these children. Reporting them again would offer the same log twice.
    if (archived.has(parent)) continue
    const blockedReason = archived.has(id)
      ? t('orphan-archived')
      : members.has(id)
        ? t('orphan-in-workspace')
        : isLive(ctx, id)
          ? t('child-live')
          : undefined
    if (blockedReason) {
      blocked.push({ id, missingParent: parent, reason: blockedReason })
      continue
    }
    orphans.push({ id, missingParent: parent })
  }
  return { orphans, blocked }
}

export function refusalMessage(refused) {
  const lines = refused.map((item) => t('line-child', { id: item.id, reason: item.reason })).join('\n')
  return t('refuse-children', { lines })
}

export function referenceMessage(children) {
  const lines = children.map((child) => t('line-child-plain', { id: child.id })).join('\n')
  return t('refuse-referenced', { count: children.length, lines })
}

export function orphanRefusalMessage(blocked) {
  const lines = blocked
    .map((item) => t('line-orphan', { id: item.id, missingParent: item.missingParent, reason: item.reason }))
    .join('\n')
  return t('refuse-orphans', { lines })
}
