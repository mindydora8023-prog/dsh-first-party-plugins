/**
 * Credential fence for filekit.
 *
 * The host filesystem sandbox already gates *writes* by session mode, so this
 * module only adds one independent fence: filekit never reads credential
 * material even in danger-full-access. This mirrors the intent of the official
 * DSH credential policy: reading secrets is refused regardless of write mode,
 * and the refusal never echoes the denied path back to the model.
 *
 * The fence is a lexical check over the RESOLVED absolute path. It is not a
 * security boundary; it exists so a model cannot casually pull `id_rsa` or a
 * token store into context.
 */

import { basename } from 'node:path'

/** Directory names that hold key material or cloud credentials. */
const DENY_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.password-store',
])

/** Exact file names that are credential stores. */
const DENY_FILES = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.gitconfig',
  'credentials',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.env',
])

/** Suffix patterns for private key / keystore files. */
const DENY_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks']

/** Split a resolved path into lower-cased segments, handling both separators. */
function segments(absPath) {
  return String(absPath)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
}

/**
 * Whether a resolved absolute path is credential material that filekit refuses.
 * @param absPath the backend-resolved display path.
 * @returns true when the path must be refused.
 */
export function isCredentialPath(absPath) {
  const parts = segments(absPath)
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (DENY_DIRS.has(lower)) return true
  }
  const name = basename(String(absPath)).toLowerCase()
  if (DENY_FILES.has(name)) return true
  if (name.startsWith('.env.') || name.endsWith('.env')) return true
  for (const suffix of DENY_SUFFIXES) {
    if (name.endsWith(suffix)) return true
  }
  // Generic `*credential*` / `*secret*` stores, but not ordinary prose files.
  if (/credential|secret/i.test(name) && /\.(json|ya?ml|ini|conf|txt|env)$/i.test(name)) return true
  return false
}

/**
 * A model-facing refusal that deliberately omits the denied path.
 * @returns the Error to throw.
 */
export function credentialDenied() {
  return new Error(
    'filekit: that path is credential material and is refused by policy '
      + '(credential files and key directories are never read by this plugin, in any sandbox mode). '
      + 'Use the host read tool instead if the operator explicitly wants it opened.',
  )
}
