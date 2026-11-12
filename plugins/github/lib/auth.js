/**
 * Token resolution.
 *
 * Order (first hit wins):
 *   1. plugin config `token`
 *   2. GITHUB_TOKEN / GH_TOKEN environment variables
 *   3. credentials.json  ({"token": "...", "login": "..."} or {"token": "..."})
 *   4. `git credential fill` for github.com -- this is what makes the browser
 *      login already stored by Git Credential Manager work with no pasting
 *   5. `gh auth token`, when the GitHub CLI is installed and logged in
 *
 * The token is never returned to the caller by accident: every function here
 * returns metadata plus the secret only on the `token` field, and error
 * messages are scrubbed with `scrub()`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CACHE = new Map()

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function readCredentialsFile(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function safeEnv() {
  // Both variables are what make this call non-interactive: GCM_INTERACTIVE
  // stops Git Credential Manager from opening a sign-in window, and
  // GIT_TERMINAL_PROMPT=0 stops git from asking on the terminal. Without them
  // a missing credential pops a dialog on every call.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  delete env['GITHUB_TOKEN']
  delete env['GH_TOKEN']
  return env
}

/**
 * Run an external command non-interactively.
 *
 * On Windows, Node refuses to spawn a `.cmd`/`.bat` directly without a shell
 * (the BatBadBut mitigation), yet a lot of tools -- npm shims, portable gh
 * wrappers -- are exactly that. `shell: true` plus a quoted command line is
 * the portable way to run one, so this helper does the quoting itself instead
 * of leaving each caller to get it wrong.
 *
 * @param executable absolute path or a bare command name
 * @param args arguments, already split
 * @param options spawn options
 */
function run(executable, args, options) {
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  const command = needsShell ? `"${executable}" ${args.map(quoteArg).join(' ')}` : executable
  const actualArgs = needsShell ? [] : args
  return spawnSync(command, actualArgs, {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
    shell: needsShell,
  })
}

/** Quote one argument for the Windows command line (cmd.exe sees the string). */
function quoteArg(value) {
  const text = String(value)
  if (text === '' || /[\s"&|<>^]/.test(text)) return `"${text.replace(/"/g, '\\"')}"`
  return text
}

/** Ask Git Credential Manager (or any configured helper) for github.com. */
function fromGitCredential(config) {
  const result = run(
    config.gitExecutable,
    ['-c', 'credential.interactive=false', 'credential', 'fill'],
    {
      input: 'protocol=https\nhost=github.com\n\n',
      timeout: 15000,
      env: safeEnv(),
    },
  )
  if (result.error || typeof result.stdout !== 'string') return null
  const lines = result.stdout.split(/\r?\n/)
  let username = ''
  let password = ''
  for (const line of lines) {
    if (line.startsWith('username=')) username = line.slice('username='.length).trim()
    else if (line.startsWith('password=')) password = line.slice('password='.length).trim()
  }
  if (password === '') return null
  return { token: password, login: username }
}

/**
 * Find a usable gh executable.
 *
 * The plugin runs inside the Electron host, whose PATH often does not include
 * a portable install (this machine has no winget and no installer copy), so an
 * explicit path still has to be discovered. Candidates, in order:
 *   1. the configured executable
 *   2. the well-known portable / installer locations
 *   3. `gh` on PATH
 * The first candidate that answers `--version` wins.
 */
function resolveGhExecutable(config) {
  const candidates = []
  if (typeof config.ghExecutable === 'string' && config.ghExecutable.trim() !== '') candidates.push(config.ghExecutable.trim())
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  if (home !== '') candidates.push(join(home, '.dsh', 'tools', 'gh', 'gh.exe'))
  if (localAppData !== '') candidates.push(join(localAppData, 'GitHubCLI', 'bin', 'gh.exe'))
  const programFiles = process.env['ProgramFiles'] ?? ''
  if (programFiles !== '') candidates.push(join(programFiles, 'GitHub CLI', 'gh.exe'))
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''
  if (programFilesX86 !== '') candidates.push(join(programFilesX86, 'GitHub CLI', 'gh.exe'))
  candidates.push('gh')

  for (const candidate of candidates) {
    // A bare command name is left to the shell to resolve; a path must exist.
    if (candidate !== 'gh' && !existsSync(candidate)) continue
    const probe = run(candidate, ['--version'], { timeout: 8000, env: safeEnv() })
    if (!probe.error && probe.status === 0) return candidate
  }
  return null
}

function fromGhCli(config) {
  const executable = resolveGhExecutable(config)
  if (executable === null) return null
  // GH_PROMPT_DISABLED keeps a logged-out gh from asking anything, which would
  // otherwise hang the host waiting for a terminal that does not exist.
  const result = run(executable, ['auth', 'token', '--hostname', 'github.com'], {
    timeout: 10000,
    env: { ...safeEnv(), GH_PROMPT_DISABLED: '1' },
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null
  const token = result.stdout.trim()
  return token === '' ? null : { token, login: '' }
}

/** Remove a secret from any diagnostic text before it reaches a tool result. */
export function scrub(value, token) {
  const text = String(value ?? '')
  if (typeof token !== 'string' || token.length < 8) return text
  return text.split(token).join('[redacted]')
}

function cacheKey(config) {
  return `${config.apiBaseUrl}|${config.credentialsFile}|${config.gitExecutable}|${config.ghExecutable}`
}

/**
 * Resolve the effective token and where it came from.
 * @returns {{token: string, source: string, login: string, detail: string}}
 */
export function resolveToken(config, options = {}) {
  const refresh = options.refresh === true
  const key = cacheKey(config)
  const now = Date.now()
  if (!refresh) {
    const cached = CACHE.get(key)
    if (cached !== undefined && now - cached.at < config.tokenCacheSeconds * 1000) return cached.value
  }

  const file = readCredentialsFile(config.credentialsFile) ?? {}
  const value = { token: '', source: 'none', login: '', detail: '' }

  const fromConfig = firstText(config.token)
  if (fromConfig !== '') {
    value.token = fromConfig
    value.source = 'plugin-config'
    value.detail = 'token set in the plugin config (cordis.patch.yml)'
  }

  if (value.token === '') {
    const envToken = firstText(process.env['GITHUB_TOKEN'], process.env['GH_TOKEN'])
    if (envToken !== '') {
      value.token = envToken
      value.source = 'env'
      value.detail = 'GITHUB_TOKEN / GH_TOKEN environment variable'
    }
  }

  if (value.token === '') {
    const fileToken = firstText(file.token, file.github_token, file.access_token)
    if (fileToken !== '') {
      value.token = fileToken
      value.source = 'credentials-file'
      value.login = firstText(file.login, file.user, '')
      value.detail = config.credentialsFile
    }
  }

  if (value.token === '' && config.useGitCredential) {
    const stored = fromGitCredential(config)
    if (stored !== null) {
      value.token = stored.token
      value.source = 'git-credential'
      value.login = stored.login
      value.detail = 'stored by Git Credential Manager for github.com (browser login)'
    }
  }

  if (value.token === '' && config.useGhCli) {
    const stored = fromGhCli(config)
    if (stored !== null) {
      value.token = stored.token
      value.source = 'gh-cli'
      value.detail = 'gh auth token'
      value.login = stored.login
    }
  }

  if (value.token !== '') value.token = value.token.trim()
  CACHE.set(key, { at: now, value })
  return value
}

/**
 * Mark the cached token as unusable after GitHub rejected it.
 *
 * Without this, an expired token is re-read from every source on every call and
 * fails the same way each time. With it, the next resolveToken() retries the
 * sources once (the user may have just fixed credentials.json) and then falls
 * back to anonymous mode, so reads keep working instead of every tool erroring.
 */
export function invalidateToken(config, reason = '') {
  const key = cacheKey(config)
  CACHE.set(key, { at: Date.now(), value: { token: '', source: 'invalid', login: '', detail: reason } })
}

/** Drop the cache so the next call re-reads every source. */
export function clearTokenCache() {
  CACHE.clear()
}
