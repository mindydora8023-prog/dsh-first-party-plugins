/**
 * Tool-level tests with a stubbed GitHub API.
 *
 * Verifies the shape a model actually sees: summarized fields, gated writes,
 * argument handling, and that the token never appears in a result.
 *
 *   node --test test/tools.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTools, writeFailureRecord } from '../lib/tools.js'
import { readConfig } from '../lib/config.js'

const TOKEN = 'ghp_tooltesttoken0000000000000000000000'

const silentLogger = { info() {}, warn() {} }

function makeConfig(overrides = {}) {
  return readConfig(
    {
      token: TOKEN,
      retries: 0,
      timeoutMs: 5000,
      defaultRepo: 'octo/hello',
      // These tests stub globalThis.fetch, so the client must take the plain
      // fetch path rather than the proxy tunnel (which uses node:https).
      proxyFromEnv: false,
      proxyFromSystem: false,
      ...overrides,
    },
    { pluginDir: 'E:/tmp/github', profileDir: '', home: '' },
  )
}

function toolsOf(config) {
  return new Map(buildTools(config, silentLogger).map((tool) => [tool.name, tool]))
}

function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const result = await handler(new URL(url), init)
    return new Response(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

test('the read-only tool set is built and writes can be disabled', () => {
  const full = toolsOf(makeConfig())
  for (const name of [
    'github_status',
    'github_search_repos',
    'github_search_code',
    'github_search_issues',
    'github_get_repo',
    'github_list_files',
    'github_read_file',
    'github_commits',
    'github_branches',
    'github_issues',
    'github_issue',
    'github_pulls',
    'github_pull_files',
    'github_actions',
    'github_create_issue',
    'github_comment',
  ]) {
    assert.ok(full.has(name), `missing tool ${name}`)
  }

  const readonly = toolsOf(makeConfig({ allowWrite: false }))
  assert.equal(readonly.has('github_create_issue'), false)
  assert.equal(readonly.has('github_comment'), false)
  assert.equal(readonly.has('github_read_file'), true)
})

test('every tool declares a description and an object-rooted output schema', () => {
  for (const [name, definition] of toolsOf(makeConfig())) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${name} description too short`)
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(definition.output.schema.additionalProperties, true)
    assert.equal(typeof definition.execute, 'function')
  }
})

test('github_status reports the credential source and the account without the token', async () => {
  const stub = stubFetch(() => ({
    body: { login: 'monalisa', name: 'Mona Lisa', type: 'User', public_repos: 7 },
    headers: {
      'x-oauth-scopes': 'repo, workflow',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1792767094',
      'x-ratelimit-resource': 'core',
    },
  }))
  try {
    const result = await toolsOf(makeConfig()).get('github_status').execute({})
    assert.equal(result.ok, true)
    assert.equal(result.login, 'monalisa')
    assert.equal(result.credential_source, 'plugin-config')
    assert.deepEqual(result.scopes, ['repo', 'workflow'])
    assert.equal(result.rate.remaining, 4999)
    assert.equal(JSON.stringify(result).includes(TOKEN), false)
  } finally {
    stub.restore()
  }
})

test('github_get_repo falls back to defaultRepo and flattens the payload', async () => {
  const stub = stubFetch(() => ({
    body: {
      full_name: 'octo/hello',
      private: false,
      description: 'demo',
      language: 'TypeScript',
      stargazers_count: 42,
      forks_count: 3,
      open_issues_count: 5,
      default_branch: 'main',
      topics: ['cli', 'tools'],
      license: { spdx_id: 'MIT' },
    },
  }))
  try {
    const result = await toolsOf(makeConfig()).get('github_get_repo').execute({})
    assert.equal(stub.calls[0].url, 'https://api.github.com/repos/octo/hello')
    assert.equal(result.full_name, 'octo/hello')
    assert.equal(result.stars, 42)
    assert.equal(result.license, 'MIT')
    assert.deepEqual(result.topics, ['cli', 'tools'])
  } finally {
    stub.restore()
  }
})

test('github_read_file decodes text, reports truncation, and explains a directory', async () => {
  const config = makeConfig({ maxChars: 1000 })
  let payload = 'hello world'
  let status = 200
  const stub = stubFetch(() => ({ status, body: payload, headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  try {
    const tool = toolsOf(config).get('github_read_file')
    const result = await tool.execute({ path: 'README.md', ref: 'main' })
    assert.equal(result.content, 'hello world')
    assert.equal(result.truncated, false)
    assert.equal(result.bytes, 11)
    assert.match(stub.calls[0].url, /\/repos\/octo\/hello\/contents\/README\.md\?ref=main$/)
    assert.equal(stub.calls[0].init.headers.Accept, 'application/vnd.github.raw')

    payload = 'x'.repeat(1500)
    const truncated = await tool.execute({ path: 'big.txt' })
    assert.equal(truncated.truncated, true)
    assert.match(truncated.content, /truncated 500 characters/)

    // A directory answers 404 on the raw media type; the message must say so
    // instead of leaking a bare "not found".
    status = 404
    payload = JSON.stringify({ message: 'Not Found' })
    await assert.rejects(tool.execute({ path: 'src' }), /cannot be read as a file|github_list_files/)
  } finally {
    stub.restore()
  }
})

test('github_read_file returns JSON files as text, not as a parsed API document', async () => {
  // Regression: parsing the body turned {"type": "module"} into a fake file
  // type and the call failed with "package.json is a module, not a file".
  const manifest = JSON.stringify({ name: 'code-oss-dev', type: 'module', version: '1.144.0' }, null, 2)
  const stub = stubFetch(() => ({ body: manifest, headers: { 'content-type': 'application/json' } }))
  try {
    const result = await toolsOf(makeConfig()).get('github_read_file').execute({ path: 'package.json' })
    assert.equal(result.binary, false)
    assert.equal(JSON.parse(result.content).type, 'module')
    assert.equal(result.truncated, false)
  } finally {
    stub.restore()
  }
})

test('github_read_file flags binary content instead of returning it', async () => {
  const stub = stubFetch(() => ({ body: 'PNG\u0000\u0001\u0002', headers: { 'content-type': 'image/png' } }))
  try {
    const result = await toolsOf(makeConfig()).get('github_read_file').execute({ path: 'logo.png' })
    assert.equal(result.binary, true)
    assert.equal(result.content, '')
  } finally {
    stub.restore()
  }
})

test('github_list_files returns one level, recursive respects path and limit', async () => {
  let mode = 'flat'
  const stub = stubFetch((url) => {
    if (mode === 'tree') {
      assert.match(url.pathname, /\/git\/trees\/main$/)
      return {
        body: {
          truncated: false,
          tree: [
            { type: 'blob', path: 'src/a.ts', size: 10 },
            { type: 'blob', path: 'src/b.ts', size: 20 },
            { type: 'blob', path: 'docs/c.md', size: 30 },
          ],
        },
      }
    }
    return {
      body: [
        { type: 'file', name: 'README.md', path: 'README.md', size: 100 },
        { type: 'dir', name: 'src', path: 'src', size: 0 },
      ],
    }
  })
  try {
    const tool = toolsOf(makeConfig()).get('github_list_files')
    const flat = await tool.execute({})
    assert.equal(flat.count, 2)
    assert.equal(flat.entries[1].type, 'dir')

    mode = 'tree'
    const nested = await tool.execute({ recursive: true, ref: 'main', path: 'src', limit: 10 })
    assert.equal(nested.total, 2)
    assert.deepEqual(nested.entries.map((entry) => entry.path), ['src/a.ts', 'src/b.ts'])
  } finally {
    stub.restore()
  }
})

test('github_issues filters pull requests and passes the state', async () => {
  const stub = stubFetch((url) => {
    assert.equal(url.searchParams.get('state'), 'all')
    assert.equal(url.searchParams.get('labels'), 'bug')
    return {
      body: [
        { number: 1, title: 'real issue', state: 'open', user: { login: 'a' }, labels: [{ name: 'bug' }], comments: 2 },
        { number: 2, title: 'is a pr', state: 'open', user: { login: 'b' }, labels: [], pull_request: { url: 'x' } },
      ],
    }
  })
  try {
    const tool = toolsOf(makeConfig()).get('github_issues')
    const filtered = await tool.execute({ state: 'all', labels: 'bug' })
    assert.equal(filtered.count, 1)
    assert.equal(filtered.issues[0].number, 1)
    assert.deepEqual(filtered.issues[0].labels, ['bug'])

    const all = await tool.execute({ state: 'all', labels: 'bug', include_pull_requests: true })
    assert.equal(all.count, 2)
    assert.equal(all.issues[1].pull_request, true)
  } finally {
    stub.restore()
  }
})

test('github_issues pages past a run of pull requests instead of returning nothing', async () => {
  const prOnly = Array.from({ length: 25 }, (_unused, index) => ({
    number: 100 + index,
    title: `pr ${index}`,
    state: 'open',
    user: { login: 'bot' },
    labels: [],
    pull_request: { url: 'x' },
  }))
  const withIssue = [
    { number: 7, title: 'a real issue', state: 'open', user: { login: 'human' }, labels: [] },
    ...prOnly.slice(0, 24),
  ]
  let page = 0
  const stub = stubFetch((url) => {
    page = Number(url.searchParams.get('page'))
    return { body: page === 1 ? prOnly : withIssue }
  })
  try {
    const result = await toolsOf(makeConfig({ perPage: 25 })).get('github_issues').execute({})
    assert.ok(page >= 2, `should have asked for a later page, got ${page}`)
    assert.equal(result.count, 1)
    assert.equal(result.issues[0].number, 7)
  } finally {
    stub.restore()
  }
})

test('github_issues explains an all-pull-request result', async () => {
  const prOnly = Array.from({ length: 2 }, (_unused, index) => ({
    number: 200 + index,
    title: `pr ${index}`,
    state: 'open',
    user: { login: 'bot' },
    labels: [],
    pull_request: { url: 'x' },
  }))
  let calls = 0
  const stub = stubFetch(() => {
    calls += 1
    return { body: prOnly }
  })
  try {
    const result = await toolsOf(makeConfig({ perPage: 3 })).get('github_issues').execute({})
    assert.equal(result.count, 0)
    assert.equal(result.scanned, 2)
    assert.match(result.note, /dominated by pull requests/)
    assert.equal(calls, 1, 'a short page ends the walk')
  } finally {
    stub.restore()
  }
})

test('github_issue includes comments only when asked', async () => {
  const stub = stubFetch((url) => {
    if (url.pathname.endsWith('/comments')) {
      return { body: [{ user: { login: 'commenter' }, created_at: '2026-01-01T00:00:00Z', body: 'looks good' }] }
    }
    return { body: { number: 5, title: 'bug', state: 'open', comments: 1, body: 'steps to reproduce', assignees: [{ login: 'monalisa' }] } }
  })
  try {
    const tool = toolsOf(makeConfig()).get('github_issue')
    const withComments = await tool.execute({ number: 5 })
    assert.equal(withComments.comments.length, 1)
    assert.equal(withComments.comments[0].user, 'commenter')
    assert.deepEqual(withComments.assignees, ['monalisa'])

    const without = await tool.execute({ number: 5, include_comments: false })
    assert.equal(without.comments, undefined)
    assert.equal(stub.calls.filter((call) => call.url.includes('/comments')).length, 1)
  } finally {
    stub.restore()
  }
})

test('github_search_issues prefixes the repo qualifier when repo is given', async () => {
  const stub = stubFetch((url) => {
    assert.equal(url.searchParams.get('q'), 'repo:octo/hello is:issue is:open')
    return { body: { total_count: 0, incomplete_results: false, items: [] } }
  })
  try {
    const result = await toolsOf(makeConfig()).get('github_search_issues').execute({ query: 'is:issue is:open', repo: 'octo/hello' })
    assert.equal(result.total, 0)
  } finally {
    stub.restore()
  }
})

test('github_pull_files truncates patches and can omit them', async () => {
  const stub = stubFetch(() => ({
    body: [
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '+x\n-y\n' },
    ],
  }))
  try {
    const tool = toolsOf(makeConfig()).get('github_pull_files')
    const withPatch = await tool.execute({ number: 9 })
    assert.equal(withPatch.files[0].patch, '+x\n-y\n')
    const without = await tool.execute({ number: 9, include_patch: false })
    assert.equal(without.files[0].patch, undefined)
  } finally {
    stub.restore()
  }
})

test('github_actions lists runs and fetches one by id', async () => {
  const stub = stubFetch((url) => {
    if (/\/runs\/77$/.test(url.pathname)) {
      return { body: { id: 77, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'abcdef1234567' } }
    }
    return {
      body: {
        total_count: 1,
        workflow_runs: [{ id: 77, name: 'CI', event: 'push', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'abcdef1234567', run_number: 3 }],
      },
    }
  })
  try {
    const tool = toolsOf(makeConfig()).get('github_actions')
    const list = await tool.execute({ branch: 'main' })
    assert.equal(list.count, 1)
    assert.equal(list.runs[0].conclusion, 'success')
    assert.equal(list.runs[0].sha, 'abcdef123456')

    const one = await tool.execute({ run_id: 77 })
    assert.equal(one.run.id, 77)
  } finally {
    stub.restore()
  }
})

test('github_commits maps commits to sha/author/message', async () => {
  const stub = stubFetch(() => ({
    body: [
      { sha: 'abcdef1234567890', author: { login: 'monalisa' }, commit: { author: { name: 'Mona', date: '2026-01-01T00:00:00Z' }, message: 'fix: something\n\nlong body' } },
    ],
  }))
  try {
    const result = await toolsOf(makeConfig()).get('github_commits').execute({ path: 'src' })
    assert.equal(result.commits[0].sha, 'abcdef123456')
    assert.equal(result.commits[0].message, 'fix: something')
    assert.equal(result.commits[0].author, 'monalisa')
  } finally {
    stub.restore()
  }
})

test('write tools post the payload and refuse empty input', async () => {
  const stub = stubFetch(() => ({ body: { number: 12, title: 'A new issue', state: 'open', html_url: 'https://github.com/octo/hello/issues/12' } }))
  try {
    const tool = toolsOf(makeConfig()).get('github_create_issue')
    await assert.rejects(tool.execute({ title: '  ' }), /title must not be empty/)
    const created = await tool.execute({ title: 'A new issue', body: 'details', labels: ['bug'] })
    assert.equal(created.created, true)
    assert.equal(created.number, 12)
    const call = stub.calls[0]
    assert.equal(call.init.method, 'POST')
    assert.deepEqual(JSON.parse(call.init.body), { title: 'A new issue', body: 'details', labels: ['bug'] })
    assert.equal(call.url, 'https://api.github.com/repos/octo/hello/issues')
  } finally {
    stub.restore()
  }
})

test('github_comment validates the number and posts under the issue', async () => {
  const stub = stubFetch(() => ({ body: { id: 999, user: { login: 'monalisa' }, html_url: 'https://github.com/x' } }))
  try {
    const tool = toolsOf(makeConfig()).get('github_comment')
    await assert.rejects(tool.execute({ number: 0, body: 'hi' }), /number must be a positive whole number/)
    await assert.rejects(tool.execute({ number: 3, body: '   ' }), /body must not be empty/)
    const created = await tool.execute({ number: 3, body: 'thanks!' })
    assert.equal(created.comment_id, 999)
    assert.equal(stub.calls[0].url, 'https://api.github.com/repos/octo/hello/issues/3/comments')
  } finally {
    stub.restore()
  }
})

test('with no credential, reads fall back to anonymous mode and writes still fail', async () => {
  const stub = stubFetch(() => ({ body: { full_name: 'octo/hello', default_branch: 'main' } }))
  const config = readConfig(
    { useGitCredential: false, useGhCli: false, credentialsFile: 'E:/tmp/github/definitely-missing.json', retries: 0, proxyFromEnv: false, proxyFromSystem: false },
    { pluginDir: 'E:/tmp/github', profileDir: '', home: '' },
  )
  const savedToken = process.env['GITHUB_TOKEN']
  const savedGh = process.env['GH_TOKEN']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
  try {
    const tools = toolsOf(config)
    // A public read works without a token and sends no Authorization header.
    const repo = await tools.get('github_get_repo').execute({ repo: 'octo/hello' })
    assert.equal(repo.full_name, 'octo/hello')
    assert.equal(stub.calls[0].init.headers.Authorization, undefined)

    // A write cannot be attributed to anybody, so it fails with instructions.
    await assert.rejects(tools.get('github_create_issue').execute({ repo: 'octo/hello', title: 'x' }), /needs a token/)

    // Code search is the one read that GitHub refuses anonymously.
    await assert.rejects(tools.get('github_search_code').execute({ query: 'x' }), /requires a token/)
  } finally {
    if (savedToken !== undefined) process.env['GITHUB_TOKEN'] = savedToken
    if (savedGh !== undefined) process.env['GH_TOKEN'] = savedGh
    stub.restore()
  }
})

test('anonymous reads can be turned off entirely', async () => {
  const config = readConfig(
    { useGitCredential: false, useGhCli: false, allowAnonymous: false, credentialsFile: 'E:/tmp/github/missing.json', retries: 0, proxyFromEnv: false, proxyFromSystem: false },
    { pluginDir: 'E:/tmp/github', profileDir: '', home: '' },
  )
  const savedToken = process.env['GITHUB_TOKEN']
  const savedGh = process.env['GH_TOKEN']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
  try {
    await assert.rejects(toolsOf(config).get('github_get_repo').execute({ repo: 'octo/hello' }), /anonymous access is disabled/)
  } finally {
    if (savedToken !== undefined) process.env['GITHUB_TOKEN'] = savedToken
    if (savedGh !== undefined) process.env['GH_TOKEN'] = savedGh
  }
})

test('github_status in anonymous mode reports the anonymous quota', async () => {
  const stub = stubFetch((url) => {
    assert.match(url.pathname, /\/rate_limit$/)
    return {
      body: { resources: { core: { limit: 60, remaining: 58, reset: 1792767094 }, search: { limit: 10, remaining: 10, reset: 1792763554 } } },
    }
  })
  const config = readConfig(
    { useGitCredential: false, useGhCli: false, credentialsFile: 'E:/tmp/github/missing.json', retries: 0, proxyFromEnv: false, proxyFromSystem: false },
    { pluginDir: 'E:/tmp/github', profileDir: '', home: '' },
  )
  const savedToken = process.env['GITHUB_TOKEN']
  const savedGh = process.env['GH_TOKEN']
  delete process.env['GITHUB_TOKEN']
  delete process.env['GH_TOKEN']
  try {
    const result = await toolsOf(config).get('github_status').execute({ refresh: true })
    assert.equal(result.ok, true)
    assert.equal(result.authenticated, false)
    assert.equal(result.credential_source, 'anonymous')
    assert.equal(result.rate.limit, 60)
    assert.match(result.hint, /public repositories/)
  } finally {
    if (savedToken !== undefined) process.env['GITHUB_TOKEN'] = savedToken
    if (savedGh !== undefined) process.env['GH_TOKEN'] = savedGh
    stub.restore()
  }
})

test('an expired token degrades to anonymous reads instead of failing forever', async () => {
  // Regression: a rejected token used to be re-read on every call, so every
  // read failed with 401 even though public reads need no token at all.
  const { clearTokenCache } = await import('../lib/auth.js')
  clearTokenCache()
  let mode = 'reject'
  const stub = stubFetch((url) => {
    if (url.pathname === '/user') {
      return mode === 'reject' ? { status: 401, body: { message: 'Bad credentials' } } : { body: { login: 'x' } }
    }
    return { body: { full_name: 'octo/hello', default_branch: 'main' } }
  })
  const config = makeConfig({ useGitCredential: false, useGhCli: false, token: 'ghp_expiredtoken0000000000000000000000' })
  try {
    const tools = toolsOf(config)
    // The first call reports the rejection clearly.
    await assert.rejects(tools.get('github_status').execute({ refresh: true }), /rejected the credential/)
    // The next call no longer uses the dead token: the public read succeeds.
    const repo = await tools.get('github_get_repo').execute({ repo: 'octo/hello' })
    assert.equal(repo.full_name, 'octo/hello')
    const last = stub.calls[stub.calls.length - 1]
    assert.equal(last.init.headers.Authorization, undefined)
    mode = 'accept'
  } finally {
    clearTokenCache()
    stub.restore()
  }
})

test('the kill switch disables every tool', async () => {
  const stub = stubFetch(() => ({ body: {} }))
  const { writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const switchPath = join(tmpdir(), `dsh-github-killswitch-${process.pid}`)
  writeFileSync(switchPath, 'off', 'utf8')
  try {
    const config = makeConfig({ killSwitch: switchPath })
    await assert.rejects(toolsOf(config).get('github_get_repo').execute({}), /kill-switch/)
  } finally {
    rmSync(switchPath, { force: true })
    stub.restore()
  }
})

// --------------------------------------------------- uncertain writes (P0 fix)

test('an issue whose response was lost returns a record instead of throwing', async () => {
  // A model that only sees "the call failed" will call again, and a replay
  // opens a duplicate PUBLIC issue. So the tool must answer, not throw.
  const original = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    throw new Error('socket hang up')
  }
  try {
    const tool = toolsOf(makeConfig({ retries: 3 })).get('github_create_issue')
    const result = await tool.execute({ repo: 'octo/hello', title: 'Evidence' })
    assert.equal(attempts, 1, 'a write must never be replayed')
    assert.equal(result.status, 'unknown')
    assert.equal(result.applied, false)
    assert.equal(result.action, 'create_issue')
    assert.equal(result.repo, 'octo/hello')
    assert.equal(result.error.code, 'WRITE_OUTCOME_UNKNOWN')
    assert.equal(result.error.effectState, 'unknown')
    assert.equal(result.error.retry, 'never')
    assert.match(result.error.nextAction, /github_issues/)
    // The token must not surface in the record either.
    assert.ok(!JSON.stringify(result).includes(TOKEN))
  } finally {
    globalThis.fetch = original
  }
})

test('a comment whose response was lost returns a record naming the issue', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('read ECONNRESET')
  }
  try {
    const tool = toolsOf(makeConfig({ retries: 3 })).get('github_comment')
    const result = await tool.execute({ repo: 'octo/hello', number: 12, body: 'note' })
    assert.equal(result.status, 'unknown')
    assert.equal(result.action, 'comment')
    assert.equal(result.number, 12)
    assert.equal(result.error.retry, 'never')
    assert.match(result.error.nextAction, /github_issue for octo\/hello #12/)
  } finally {
    globalThis.fetch = original
  }
})

test('a rejected write still throws, so an ordinary failure stays ordinary', async () => {
  // 422 means the server explicitly refused: the effect is `none`, so the model
  // SHOULD be able to fix the arguments and call again. That is why it throws.
  const stub = stubFetch(() => ({ status: 422, body: { message: 'Validation Failed' } }))
  try {
    const tool = toolsOf(makeConfig()).get('github_create_issue')
    await assert.rejects(tool.execute({ repo: 'octo/hello', title: 'x' }), /Validation Failed/)
  } finally {
    stub.restore()
  }
})

test('writeFailureRecord only converts errors that carry an unknown effect', () => {
  assert.equal(writeFailureRecord(new Error('plain failure'), { action: 'create_issue' }), null)
  assert.equal(writeFailureRecord(null, {}), null)
  assert.equal(writeFailureRecord({ effectState: 'none', message: 'rejected' }, {}), null)

  const record = writeFailureRecord(
    { effectState: 'unknown', message: 'lost', nextAction: 'read it back' },
    { action: 'create_issue', repo: 'octo/hello' },
  )
  assert.equal(record.status, 'unknown')
  assert.equal(record.error.code, 'WRITE_OUTCOME_UNKNOWN')
  assert.equal(record.error.retry, 'never')
  assert.equal(record.error.nextAction, 'read it back')
  // A malformed error without nextAction still yields actionable advice.
  const fallback = writeFailureRecord({ effectState: 'unknown' }, {})
  assert.match(fallback.error.nextAction, /Read the resource back/)
})
