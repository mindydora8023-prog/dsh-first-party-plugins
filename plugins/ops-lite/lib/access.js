/**
 * Access layer over the host filesystem service (`ctx.fs`) and credential fence.
 *
 * Re-exports the canonical shared modules (`./credential-guard.js` and
 * `./fs-access.js`) so callers keep one stable import surface.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

export {
  DENY_DIRS,
  DENY_FILES,
  DENY_SUFFIXES,
  isCredentialPath,
  credentialDenied,
} from './credential-guard.js'

export {
  sessionCwd,
  resolvePath,
  statTarget,
  readBytes,
  decodeUtf8,
} from './fs-access.js'
