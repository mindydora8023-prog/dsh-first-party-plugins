/**
 * Cordis host entry point for dsh-plugin-archived-sessions.
 * Re-exports the complete public API from cohesive internal modules.
 *
 * ASCII only: user-facing refusal strings live in lib/reasons.js.
 */

export const name = 'archived-sessions'
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions']

export {
  DEFAULT_DELETE_TIMEOUT_MS,
  withDeadline,
  deleteArchived,
  deleteOrphans,
  inspectArchived,
  inspectOrphans,
  listArchivedInventory,
} from './transaction.js'

export {
  listRecycle,
  restoreRecycle,
  purgeExpiredRecycle,
} from './recycle.js'

export { apply } from './routes.js'
