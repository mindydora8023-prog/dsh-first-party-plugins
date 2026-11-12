/**
 * Where the app password is allowed to live.
 *
 * THIS TEST EXISTS BECAUSE THE FILE LANDED SOMEWHERE THE PLUGIN COULD NOT READ.
 *
 * On 2026-10-26 the credentials were moved out of the plugin directory -- correctly, that
 * directory is mirrored to a git repository and a plaintext password must not go there --
 * and put in `<profile>/gmail-credentials.json`, which IS a supported candidate. The change
 * was reported as verified.
 *
 * On 2026-10-27 the tool answered "Gmail credentials are not ready" and listed exactly one
 * path. Both profile candidates are guarded by environment variables:
 *
 *   profileDir: process.env['DSH_PROFILE_DIR'] ?? ''
 *   home:       process.env['DSH_HOME'] ?? ''
 *
 * and the running Electron host sets NEITHER. So `credentialsCandidates()` returned only the
 * plugin directory, and a file that existed on disk was invisible to the plugin. The earlier
 * "verified" check must have run somewhere those variables were set (a test harness or the
 * isolated-profile probe), which is exactly the kind of verification that proves nothing.
 *
 * The fix is a candidate that needs no host cooperation: the plugin state directory, which
 * resolves from LOCALAPPDATA (see lib/state-dir.js) and is still outside the mirrored tree.
 *
 * The tests below pin the two properties that failed:
 *   1. a credential file must be found with NO environment help at all;
 *   2. the mirrored plugin directory must never take precedence over it.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { credentialsCandidates, loadCredentials, readConfig } from '../lib/config.js'

/** The `dirs` the host actually produces: no DSH_PROFILE_DIR, no DSH_HOME. */
const HOST_DIRS = { pluginDir: '/plugins/gmail', profileDir: '', home: '' }

const VALID = { address: 'someone@example.com', app_password: 'abcdefghijklmnop' }

/** Run `fn` with DSH_PLUGIN_STATE_DIR pointed at a fresh temp directory. */
function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-creds-'))
  const previous = process.env['DSH_PLUGIN_STATE_DIR']
  process.env['DSH_PLUGIN_STATE_DIR'] = dir
  try {
    return fn(dir)
  } finally {
    if (previous === undefined) delete process.env['DSH_PLUGIN_STATE_DIR']
    else process.env['DSH_PLUGIN_STATE_DIR'] = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the credentials are found with no DSH_PROFILE_DIR and no DSH_HOME', () => {
  withStateDir(() => {
    const config = readConfig({}, HOST_DIRS)
    const candidates = credentialsCandidates(config)
    const statePath = join(process.env['DSH_PLUGIN_STATE_DIR'], 'gmail', 'credentials.json')

    assert.ok(
      candidates.includes(statePath),
      `no candidate can be resolved without host env vars; got:\n${candidates.join('\n')}`,
    )
    assert.equal(candidates.length >= 2, true, 'expected more than the legacy plugin-directory entry')
  })
})

test('a file in the state directory is actually loaded', () => {
  withStateDir((dir) => {
    const config = readConfig({}, HOST_DIRS)
    const target = join(dir, 'gmail', 'credentials.json')
    mkdirSync(join(dir, 'gmail'), { recursive: true })
    writeFileSync(target, JSON.stringify(VALID), 'utf8')

    const resolved = loadCredentials(config)
    assert.equal(resolved.address, VALID.address)
    assert.equal(resolved.password, VALID.app_password)
    assert.equal(resolved.source, target, 'the reported source must name the file that was used')
  })
})

test('the mirrored plugin directory is the LAST resort, so it cannot shadow the canonical one', () => {
  withStateDir(() => {
    const candidates = credentialsCandidates(readConfig({}, HOST_DIRS))
    const pluginCandidate = join(HOST_DIRS.pluginDir, 'credentials.json')
    assert.equal(
      candidates[candidates.length - 1],
      pluginCandidate,
      'the plugin directory is inside the mirrored git tree; it must only be a fallback',
    )
  })
})

test('an explicit credentialsPath still wins over everything', () => {
  withStateDir(() => {
    const config = readConfig({ credentialsPath: 'D:/explicit/creds.json' }, HOST_DIRS)
    assert.equal(credentialsCandidates(config)[0], 'D:/explicit/creds.json')
  })
})

test('the profile location stays supported when the host does provide the variable', () => {
  withStateDir(() => {
    const config = readConfig({}, { pluginDir: '/plugins/gmail', profileDir: '/home/u/.dsh/profiles/desktop', home: '' })
    assert.ok(
      credentialsCandidates(config).includes(join('/home/u/.dsh/profiles/desktop', 'gmail-credentials.json')),
      'removing the env-dependent candidates would break hosts that do set DSH_PROFILE_DIR',
    )
  })
})
