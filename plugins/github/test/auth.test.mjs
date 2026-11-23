/**
 * Credential resolution tests.
 *
 * The gh CLI path is the one users hit first, and it depends on process
 * environment and an executable that may be missing, so it is tested with a
 * fake gh script rather than the real one.
 *
 *   node --test test/auth.test.mjs
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { clearTokenCache, invalidateToken, resolveToken, scrub } from '../lib/auth.js'
import { readConfig } from '../lib/config.js'

const PLUGIN_DIR = 'E:/tmp/github-auth-test'
const TOKEN = 'ghp_fromfaketool00000000000000000000000'
const tempDirs = []

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

test.afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort cleanup */
    }
  }
})

function configFor(overrides = {}) {
  return readConfig(
    { useGitCredential: false, useGhCli: true, credentialsFile: join(PLUGIN_DIR, 'missing.json'), ...overrides },
    { pluginDir: PLUGIN_DIR, profileDir: '', home: '' },
  )
}

function withCleanEnv(fn) {
  return async () => {
    const saved = {
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
      GH_TOKEN: process.env['GH_TOKEN'],
      GH_ENTERPRISE_TOKEN: process.env['GH_ENTERPRISE_TOKEN'],
    }
    delete process.env['GITHUB_TOKEN']
    delete process.env['GH_TOKEN']
    delete process.env['GH_ENTERPRISE_TOKEN']
    clearTokenCache()
    try {
      await fn()
    } finally {
      clearTokenCache()
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value
        else delete process.env[key]
      }
    }
  }
}

/**
 * Create a fast stand-in for gh.exe that answers `--version` and `auth token`
 * without spawning a nested Node process on every call.
 */
function fakeGhFast({ token = '', byHost = null, failAuth = false } = {}) {
  const directory = makeTempDir('dsh-fake-gh-')
  const wrapper = join(directory, process.platform === 'win32' ? 'gh.cmd' : 'gh')
  if (process.platform === 'win32') {
    const lines = [
      '@echo off',
      'if "%~1"=="--version" (echo gh version 9.9.9 & exit /b 0)',
    ]
    if (!failAuth) {
      if (byHost) {
        for (const [host, value] of Object.entries(byHost)) {
          lines.push(`if "%~1"=="auth" if "%~2"=="token" if "%~3"=="--hostname" if "%~4"=="${host}" (echo ${value} & exit /b 0)`)
        }
      } else if (token !== '') {
        lines.push(`if "%~1"=="auth" if "%~2"=="token" (echo ${token} & exit /b 0)`)
      }
    }
    lines.push('exit /b 1')
    writeFileSync(wrapper, lines.join('\r\n') + '\r\n', 'utf8')
  } else {
    const lines = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "gh version 9.9.9"; exit 0; fi',
    ]
    if (!failAuth) {
      if (byHost) {
        for (const [host, value] of Object.entries(byHost)) {
          lines.push(`if [ "$1" = "auth" ] && [ "$2" = "token" ] && [ "$3" = "--hostname" ] && [ "$4" = "${host}" ]; then echo "${value}"; exit 0; fi`)
        }
      } else if (token !== '') {
        lines.push(`if [ "$1" = "auth" ] && [ "$2" = "token" ]; then echo "${token}"; exit 0; fi`)
      }
    }
    lines.push('exit 1')
    writeFileSync(wrapper, lines.join('\n') + '\n', 'utf8')
    chmodSync(wrapper, 0o700)
  }
  return wrapper
}

function fakeGhHang() {
  const directory = makeTempDir('dsh-fake-gh-')
  const wrapper = join(directory, process.platform === 'win32' ? 'gh.cmd' : 'gh')
  if (process.platform === 'win32') {
    writeFileSync(
      wrapper,
      `@echo off\r\nif "%~1"=="--version" (echo gh version 9.9.9 & exit /b 0)\r\n"${process.execPath}" -e "setTimeout(()=>{}, 5000)"\r\n`,
      'utf8',
    )
  } else {
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 9.9.9"; exit 0; fi\nexec "${process.execPath}" -e "setTimeout(()=>{}, 5000)"\n`,
      'utf8',
    )
    chmodSync(wrapper, 0o700)
  }
  return wrapper
}

test('with gh disabled there is no fallback, so a missing file means no token', withCleanEnv(async () => {
  const config = configFor({ ghExecutable: 'C:/definitely/not/here/gh.exe', useGhCli: false })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.token, '')
  assert.equal(resolved.source, 'none')
}))

test('a token is read from the gh CLI and reported with its source', withCleanEnv(async () => {
  const gh = fakeGhFast({ token: TOKEN })
  const config = configFor({ ghExecutable: gh })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.token, TOKEN)
  assert.equal(resolved.source, 'gh-cli')
  assert.equal(resolved.detail, 'gh auth token')
}))

test('a gh CLI that is installed but logged out yields no token and no error', withCleanEnv(async () => {
  const gh = fakeGhFast({ failAuth: true })
  const config = configFor({ ghExecutable: gh })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.token, '')
  assert.equal(resolved.source, 'none')
}))

test('a gh CLI that hangs is not allowed to block the host', withCleanEnv(async () => {
  const gh = fakeGhHang()
  const config = configFor({ ghExecutable: gh, ghTimeoutMs: 120 })
  const started = Date.now()
  const resolved = resolveToken(config, { refresh: true })
  const elapsed = Date.now() - started
  assert.equal(resolved.token, '')
  assert.ok(elapsed < 2000, `took ${elapsed}ms, expected the timeout to end it quickly`)
}))

test('GHE apiBaseUrl passes the enterprise hostname to gh CLI and isolates the cache', withCleanEnv(async () => {
  const gh = fakeGhFast({
    byHost: {
      'git.corp': 'ghp_enterprise0000000000000000000000000',
      'github.com': TOKEN,
    },
  })
  const dotcom = configFor({ ghExecutable: gh, apiBaseUrl: 'https://api.github.com' })
  const ghe = configFor({ ghExecutable: gh, apiBaseUrl: 'https://git.corp/api/v3' })
  const gheMissing = configFor({ ghExecutable: gh, apiBaseUrl: 'https://other.corp/api/v3' })

  assert.equal(resolveToken(dotcom).token, TOKEN)
  assert.equal(resolveToken(ghe).token, 'ghp_enterprise0000000000000000000000000')
  assert.equal(resolveToken(gheMissing).token, '', 'GHE must never receive a github.com token')
}))

test('credentials.json is preferred over the gh CLI', withCleanEnv(async () => {
  const gh = fakeGhFast({ token: TOKEN })
  const directory = makeTempDir('dsh-github-creds-')
  const file = join(directory, 'credentials.json')
  writeFileSync(file, JSON.stringify({ token: 'ghp_fromfile000000000000000000000000000' }), 'utf8')
  const config = configFor({ ghExecutable: gh, credentialsFile: file })
  const resolved = resolveToken(config, { refresh: true })
  assert.equal(resolved.source, 'credentials-file')
  assert.match(resolved.token, /^ghp_fromfile/)
}))

test('invalidateToken drops the cache entry so a rotated credentials file recovers immediately', withCleanEnv(async () => {
  const dir = makeTempDir('dsh-token-invalidate-')
  const file = join(dir, 'credentials.json')
  writeFileSync(file, JSON.stringify({ token: 'ghp_oldtoken000000000000000000000000' }), 'utf8')
  const config = configFor({ credentialsFile: file, useGitCredential: false, useGhCli: false, tokenCacheSeconds: 300 })

  const first = resolveToken(config)
  assert.equal(first.token, 'ghp_oldtoken000000000000000000000000')

  invalidateToken(config, '401 rejected', first.token)
  // While the old token is still on disk, it is skipped rather than replayed.
  const skipped = resolveToken(config)
  assert.equal(skipped.token, '')

  // Once the user rotates credentials.json, the very next call recovers without waiting 300s.
  writeFileSync(file, JSON.stringify({ token: 'ghp_newtoken000000000000000000000000' }), 'utf8')
  const recovered = resolveToken(config)
  assert.equal(recovered.token, 'ghp_newtoken000000000000000000000000')
  assert.equal(recovered.source, 'credentials-file')
}))

test('the token cache distinguishes config.token and source toggles', withCleanEnv(async () => {
  const a = configFor({ token: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', useGhCli: false })
  const b = configFor({ token: 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', useGhCli: false })
  assert.equal(resolveToken(a).token, 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(resolveToken(b).token, 'ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
}))

test('the token cache honours tokenCacheSeconds: 0', withCleanEnv(async () => {
  const dir = makeTempDir('dsh-token-cache-')
  const file = join(dir, 'credentials.json')
  writeFileSync(file, JSON.stringify({ token: 'ghp_first000000000000' }), 'utf8')
  const config = configFor({ credentialsFile: file, useGitCredential: false, useGhCli: false, tokenCacheSeconds: 0 })
  const first = resolveToken(config)
  assert.equal(first.token, 'ghp_first000000000000')
  writeFileSync(file, JSON.stringify({ token: 'ghp_second00000000000' }), 'utf8')
  const second = resolveToken(config)
  assert.equal(second.token, 'ghp_second00000000000', 'tokenCacheSeconds:0 must re-read the source')
}))

test('scrub removes a token from textual diagnostics', () => {
  assert.equal(scrub(`failed with ${TOKEN}`, TOKEN), 'failed with [redacted]')
  assert.equal(scrub('nothing', TOKEN), 'nothing')
})

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listJsFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('the plugin sources never contain a hard-coded token', () => {
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const files = listJsFiles(libDir)
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{30,}/, `${file} must not embed a token`)
  }
})
