/**
 * Configuration and credential resolution.
 *
 * Credentials are re-read from disk on every call and never cached in memory,
 * so rotating the app password takes effect immediately without restarting the
 * host -- the same idea as the computer-use kill-switch sentinel. The cost is a
 * little extra file I/O per call, which is negligible.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { statePath } from './state-dir.js'

const PLACEHOLDERS = new Set(['', 'you@gmail.com', 'your_app_password_16_chars', 'REPLACE_ME'])

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asPositiveInt(value, fallback) {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}

export const DEFAULT_KILL_SWITCH = 'dsh-gmail.disabled'
export const KILL_SWITCH_ENV = 'DSH_GMAIL_OFF'

/**
 * @param raw Plugin config (the config section in cordis.patch.yml).
 * @param dirs { pluginDir, profileDir, home }
 */
export function readConfig(raw, dirs) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const defaultCredentials = join(dirs.pluginDir, 'credentials.json')
  return {
    credentialsPath: asString(source.credentialsPath, ''),
    defaultCredentials,
    address: asString(source.address, ''),
    appPassword: asString(source.appPassword, ''),

    imapHost: asString(source.imapHost, 'imap.gmail.com'),
    imapPort: asPositiveInt(source.imapPort, 993),
    smtpHost: asString(source.smtpHost, 'smtp.gmail.com'),
    smtpPort: asPositiveInt(source.smtpPort, 465),
    timeoutMs: asPositiveInt(source.timeoutMs, 30000),

    attachmentsDir: asString(source.attachmentsDir, join(dirs.pluginDir, 'attachments')),
    // The IMAP cursor and the self-report go to the per-user state directory, not
    // the source tree: that tree is mirrored to git and may be read-only (see
    // lib/state-dir.js). `credentials.json` still defaults next to the plugin for
    // backwards compatibility, and is listed in the sync tool's excludes.
    stateFile: asString(source.stateFile, statePath('gmail', 'gmail-state.json')),
    // Self-report status file; set to false to disable it (for example when the plugin should not write to disk).
    statusFile: source.statusFile === false ? false : asString(source.statusFile, statePath('gmail', 'gmail-plugin-status.json')),

    maxResults: Math.min(asPositiveInt(source.maxResults, 25), 200),
    maxResultsLimit: 200,

    allowSend: asBoolean(source.allowSend, true),
    // Labels / archive / mark-as-read all "change state", so they share one switch.
    allowWrite: asBoolean(source.allowWrite, true),

    killSwitch: asString(source.killSwitch, join(dirs.pluginDir, DEFAULT_KILL_SWITCH)),
    dirs,
  }
}

function readJsonCredentials(path) {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Candidate credential files, in priority order. */
export function credentialsCandidates(config) {
  const list = []
  if (config.credentialsPath !== '') list.push(config.credentialsPath)

  // The canonical location: the plugin state directory (see shared/state-dir.js).
  //
  // Measured 2026-10-27, and the reason this entry exists: the credentials had been
  // moved to `<profile>/gmail-credentials.json` on the assumption that `DSH_PROFILE_DIR`
  // would be present. In the running Electron host it is NOT, and neither is DSH_HOME, so
  // both of those candidates disappeared and the plugin reported the credentials missing
  // while the file sat on disk. The state directory resolves from LOCALAPPDATA with no
  // host cooperation, and it is still outside the source tree (which is the property that
  // matters: that tree is mirrored to a git repository).
  list.push(statePath('gmail', 'credentials.json'))

  const profileDir = config.dirs.profileDir
  if (profileDir) list.push(join(profileDir, 'gmail-credentials.json'))
  if (config.dirs.home) list.push(join(config.dirs.home, 'gmail-credentials.json'))

  // Last, and deliberately last: the plugin directory is mirrored to a git repository, so
  // a credential file there is a leak waiting to happen. It stays supported for old
  // checkouts, but it must never shadow the canonical location above.
  list.push(config.defaultCredentials)
  return list
}

/**
 * Resolve credentials. The password is **never written into the returned source
 * field**, so it cannot leak into tool output.
 * @returns {{address:string,password:string,source:string}}
 */
export function loadCredentials(config) {
  const envAddress = process.env['GMAIL_ADDRESS'] ?? ''
  const envPassword = process.env['GMAIL_APP_PASSWORD'] ?? ''

  let address = config.address || envAddress
  let password = config.appPassword || envPassword
  let source = config.appPassword !== '' ? 'plugin-config' : envPassword !== '' ? 'environment' : ''

  if (password === '') {
    for (const candidate of credentialsCandidates(config)) {
      const parsed = readJsonCredentials(candidate)
      if (parsed === null) continue
      if (address === '' && typeof parsed.address === 'string') address = parsed.address
      if (typeof parsed.app_password === 'string') password = parsed.app_password
      if (typeof parsed.appPassword === 'string' && password === '') password = parsed.appPassword
      source = candidate
      break
    }
  }

  address = address.trim()
  // Google shows it with spaces (abcd efgh ijkl mnop); actual authentication must strip them.
  password = password.replace(/\s+/g, '')

  const problems = []
  if (PLACEHOLDERS.has(address) || !address.includes('@')) problems.push(`invalid email address (current: ${address || 'empty'})`)
  if (PLACEHOLDERS.has(password) || password.length !== 16) {
    problems.push(`app password must be 16 characters (got ${password.length})`)
  }
  if (problems.length > 0) {
    throw new Error(
      `Gmail credentials are not ready: ${problems.join('; ')}. ` +
        `Place a credentials.json ({"address":"...","app_password":"16-character password"}) in any of these locations: ` +
        credentialsCandidates(config).join(' or ') +
        '; alternatively set the GMAIL_ADDRESS / GMAIL_APP_PASSWORD environment variables. ' +
        'App password page: https://myaccount.google.com/apppasswords (two-step verification must be enabled first).',
    )
  }
  return { address, password, source: source === '' ? 'unknown' : source }
}

/**
 * Kill switch: while the sentinel file exists or the environment variable is
 * non-empty, every tool refuses to run. Re-checked on each call, so the host
 * does not have to be restarted to stop the bleeding.
 */
export function assertNotStopped(config) {
  const flag = process.env[KILL_SWITCH_ENV]
  if (typeof flag === 'string' && flag.trim() !== '') {
    throw new Error(`Gmail tools are stopped: environment variable ${KILL_SWITCH_ENV} is set. Clear it and restart the host to resume.`)
  }
  if (existsSync(config.killSwitch)) {
    throw new Error(`Gmail tools are stopped: kill-switch file at ${config.killSwitch}. Delete it to resume immediately, no restart needed.`)
  }
}

export function readState(config) {
  if (!existsSync(config.stateFile)) return {}
  try {
    const parsed = JSON.parse(readFileSync(config.stateFile, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeState(config, state) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2), 'utf8')
}
