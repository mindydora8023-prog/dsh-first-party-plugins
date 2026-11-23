/**
 * Configuration resolution for dsh-plugin-github.
 *
 * Every connection field is resolved once, at load time, from the plugin row
 * in cordis.patch.yml; credentials are resolved per call (see auth.js) so a
 * rotated token takes effect without restarting the host.
 */

import { join } from 'node:path'

import { statePath } from './state-dir.js'

export const DEFAULT_API_BASE = 'https://api.github.com'
export const DEFAULT_PER_PAGE = 25
export const MAX_PER_PAGE = 100
export const MAX_CHARS = 200000
export const DEFAULT_MAX_CHARS = 20000

function asText(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Derive the web/git hostname from the API base URL.
 *
 * Examples:
 *   https://api.github.com          -> github.com
 *   https://api.acme.ghe.com        -> acme.ghe.com
 *   https://git.corp/api/v3         -> git.corp
 *   https://git.corp:8443/api/v3    -> git.corp:8443
 */
export function hostFromApiBase(apiBaseUrl) {
  try {
    const url = new URL(asText(apiBaseUrl, DEFAULT_API_BASE))
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'api.github.com') return 'github.com'
    if (hostname.startsWith('api.') && hostname.endsWith('.ghe.com')) return hostname.slice(4)
    return url.port ? `${hostname}:${url.port}` : hostname
  } catch {
    return 'github.com'
  }
}

/**
 * Expand `${env:NAME}` inside a config value.
 *
 * The profile patch must not contain a proxy hostname or anything secret, and
 * an empty result means "not configured", so a missing variable falls back to
 * an empty string rather than the literal placeholder.
 */
function resolveEnvPlaceholders(value) {
  if (typeof value !== 'string' || value === '') return ''
  return value.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_match, name) => process.env[name] ?? '')
}

/**
 * @param raw Plugin config from cordis.patch.yml.
 * @param dirs { pluginDir, profileDir, home }
 */
export function readConfig(raw, dirs) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const apiBaseUrl = asText(source.apiBaseUrl, DEFAULT_API_BASE).replace(/\/+$/, '')
  return {
    apiBaseUrl,
    host: hostFromApiBase(apiBaseUrl),
    // A token written straight into the config works, but a credentials file
    // (or the browser login already stored by Git Credential Manager) is the
    // path that keeps the secret out of the profile patch.
    token: asText(source.token, ''),
    // Default goes to the per-user state directory, NOT the source tree: that
    // tree is mirrored to git and may be read-only, exactly like statusFile.
    credentialsFile: asText(source.credentialsFile, statePath('github', 'credentials.json')),
    // `git credential fill` reads the token Git Credential Manager stored when
    // the user signed in from a browser. GCM_INTERACTIVE=never is forced in
    // auth.js, so this can never open a sign-in window; when nothing is stored
    // the call just fails and the next source is tried.
    useGitCredential: asBoolean(source.useGitCredential, true),
    gitExecutable: asText(source.gitExecutable, 'git'),
    gitTimeoutMs: asInteger(source.gitTimeoutMs, 15000, 50, 60000),
    // Last resort for machines where the GitHub CLI is installed and logged in.
    useGhCli: asBoolean(source.useGhCli, true),
    ghExecutable: asText(source.ghExecutable, 'gh'),
    ghTimeoutMs: asInteger(source.ghTimeoutMs, 10000, 50, 60000),
    // With no token at all, public reads still work against the anonymous
    // quota (60 requests per hour per address). Writes always need a token.
    allowAnonymous: asBoolean(source.allowAnonymous, true),
    tokenCacheSeconds: asInteger(source.tokenCacheSeconds, 300, 0, 86400),
    // Used when a tool argument omits `repo`.
    defaultRepo: asText(source.defaultRepo, ''),
    // Write tools exist only when this is true.
    allowWrite: asBoolean(source.allowWrite, true),
    perPage: asInteger(source.perPage, DEFAULT_PER_PAGE, 1, MAX_PER_PAGE),
    maxChars: asInteger(source.maxChars, DEFAULT_MAX_CHARS, 500, MAX_CHARS),
    maxFiles: asInteger(source.maxFiles, 30, 1, 100),
    timeoutMs: asInteger(source.timeoutMs, 30000, 1000, 180000),
    retries: asInteger(source.retries, 1, 0, 3),
    retryBaseDelayMs: asInteger(source.retryBaseDelayMs, 400, 0, 10000),
    // Node's built-in fetch ignores the Windows Internet Settings proxy, so a
    // direct connection to api.github.com can simply time out behind a
    // firewall. Sources, in order: proxyUrl below, HTTPS_PROXY/HTTP_PROXY in
    // the environment, then the Windows system proxy read from the registry
    // (what the user configured in Settings -- nothing has to be exported).
    proxyUrl: asText(resolveEnvPlaceholders(source.proxyUrl), ''),
    proxyFromEnv: asBoolean(source.proxyFromEnv, true),
    proxyFromSystem: asBoolean(source.proxyFromSystem, true),
    killSwitch: asText(source.killSwitch, join(dirs.pluginDir, 'dsh-github.disabled')),
    // Default goes to the per-user state directory, NOT the source tree: that tree
    // is mirrored to git and may be read-only (see lib/state-dir.js).
    statusFile:
      source.statusFile === false ? false : asText(source.statusFile, statePath('github', 'github-status.json')),
    dirs,
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split "owner/name" (or a full github.com / GitHub Enterprise URL) into its
 * two parts.
 */
export function parseRepo(input, fallback, allowedHost = '') {
  const raw = asText(input, asText(fallback, ''))
  if (raw === '') {
    throw new Error('No repository. Pass repo as "owner/name", or set defaultRepo in the plugin config.')
  }
  const normalizedHost = asText(allowedHost, '').toLowerCase()
  if (/^https?:\/\//i.test(raw)) {
    let url
    try {
      url = new URL(raw)
    } catch {
      throw new Error(`Invalid repository "${raw}": expected "owner/name".`)
    }
    const urlHost = (url.port ? `${url.hostname}:${url.port}` : url.hostname).toLowerCase()
    const acceptedHosts = new Set(['github.com', 'www.github.com'])
    if (normalizedHost !== '') {
      acceptedHosts.add(normalizedHost)
      acceptedHosts.add(`www.${normalizedHost}`)
      if (normalizedHost.includes(':')) acceptedHosts.add(normalizedHost.split(':')[0])
    }
    if (normalizedHost !== '' && !acceptedHosts.has(urlHost)) {
      throw new Error(`Invalid repository "${raw}": host "${urlHost}" does not match ${normalizedHost} or github.com.`)
    }
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    if (segments.length < 2) throw new Error(`Invalid repository "${raw}": expected "owner/name".`)
    return checkRepo(segments[0], segments[1], raw)
  }

  const hosts = ['github.com']
  if (normalizedHost !== '' && normalizedHost !== 'github.com') hosts.push(normalizedHost)
  for (const host of hosts) {
    const pattern = new RegExp(`^(?:www\\.)?${escapeRegExp(host)}\\/([^/]+)\\/([^/]+?)(?:\\.git)?(?:[/?#].*)?$`, 'i')
    const match = pattern.exec(raw)
    if (match !== null) return checkRepo(match[1], match[2], raw)
  }

  const value = raw.replace(/^\/+|\/+$/g, '')
  const parts = value.split('/')
  if (parts.length !== 2) throw new Error(`Invalid repository "${raw}": expected "owner/name".`)
  return checkRepo(parts[0], parts[1], raw)
}

function checkRepo(owner, name, raw) {
  const safe = /^[A-Za-z0-9._-]{1,100}$/
  const cleanName = name.replace(/\.git$/, '')
  if (!safe.test(owner) || !safe.test(cleanName)) {
    throw new Error(`Invalid repository "${raw}": expected "owner/name" with letters, digits, dot, dash or underscore.`)
  }
  return { owner, repo: cleanName, full: `${owner}/${cleanName}` }
}

/** Validate a git ref / sha / path fragment that will be placed in a URL path. */
export function encodeRef(value) {
  return encodeURIComponent(String(value))
}
