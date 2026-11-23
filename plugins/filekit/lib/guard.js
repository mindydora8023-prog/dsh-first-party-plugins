/**
 * Credential fence for filekit.
 *
 * Re-exports the canonical shared credential guard (`./credential-guard.js`).
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
