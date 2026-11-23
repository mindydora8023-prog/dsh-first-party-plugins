/**
 * Access layer over the host filesystem service (`ctx.fs`).
 *
 * Re-exports the canonical shared filesystem adapter (`./fs-access.js`).
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

export {
  sessionCwd,
  resolvePath,
  statTarget,
  readBytes,
  decodeUtf8,
} from './fs-access.js'
