/**
 * Write tools added for parity with mature GitHub connectors:
 * create PR, update issue, merge PR, submit review. Stubbed fetch, no network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTools } from '../lib/tools.js'
import { readConfig } from '../lib/config.js'

const TOKEN = 'test-token-value'
const silentLogger = { info() {}, warn() {} }

function makeConfig(overrides = {}) {
  return readConfig(
    {
      token: TOKEN,
      retries: 0,
      timeoutMs: 5000,
      defaultRepo: 'octo/hello',
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
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

test('github_create_pr posts title/head/base and reports the new number', async () => {
  const stub = stubFetch(() => ({ body: { number: 42, state: 'open', draft: false, html_url: 'https://x/42', head: { ref: 'feat' }, base: { ref: 'main' } } }))
  try {
    const tool = toolsOf(makeConfig()).get('github_create_pr')
    const out = await tool.execute({ repo: 'octo/hello', title: 'Add X', head: 'feat', base: 'main' }, { signal: new AbortController().signal })
    assert.equal(out.created, true)
    assert.equal(out.number, 42)
    assert.equal(stub.calls[0].url, 'https://api.github.com/repos/octo/hello/pulls')
    const body = JSON.parse(stub.calls[0].init.body)
    assert.deepEqual(body, { title: 'Add X', head: 'feat', base: 'main' })
  } finally { stub.restore() }
})

test('github_merge_pr PUTs the merge endpoint and reports merged', async () => {
  const stub = stubFetch(() => ({ body: { merged: true, sha: 'abc123', message: 'ok' } }))
  try {
    const tool = toolsOf(makeConfig()).get('github_merge_pr')
    const out = await tool.execute({ repo: 'octo/hello', number: 9, merge_method: 'squash' }, { signal: new AbortController().signal })
    assert.equal(out.merged, true)
    assert.equal(out.sha, 'abc123')
    assert.match(stub.calls[0].url, /\/pulls\/9\/merge$/)
    assert.equal(stub.calls[0].init.method, 'PUT')
    assert.equal(JSON.parse(stub.calls[0].init.body).merge_method, 'squash')
  } finally { stub.restore() }
})

test('github_submit_review requires a body unless approving', async () => {
  const tool = toolsOf(makeConfig()).get('github_submit_review')
  await assert.rejects(
    () => tool.execute({ repo: 'octo/hello', number: 9, event: 'REQUEST_CHANGES' }, { signal: new AbortController().signal }),
    /body is required/,
  )
  const stub = stubFetch(() => ({ body: { id: 7, state: 'APPROVED', html_url: 'https://x' } }))
  try {
    const out = await tool.execute({ repo: 'octo/hello', number: 9, event: 'APPROVE' }, { signal: new AbortController().signal })
    assert.equal(out.submitted, true)
    assert.equal(out.review_id, 7)
    assert.match(stub.calls[0].url, /\/pulls\/9\/reviews$/)
  } finally { stub.restore() }
})

test('github_update_issue PATCHes only the provided fields', async () => {
  const stub = stubFetch(() => ({ body: { number: 3, title: 't', state: 'closed', labels: [{ name: 'bug' }], assignees: [] } }))
  try {
    const tool = toolsOf(makeConfig()).get('github_update_issue')
    const out = await tool.execute({ repo: 'octo/hello', number: 3, state: 'closed', labels: ['bug'] }, { signal: new AbortController().signal })
    assert.equal(out.updated, true)
    assert.equal(stub.calls[0].init.method, 'PATCH')
    assert.match(stub.calls[0].url, /\/issues\/3$/)
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { state: 'closed', labels: ['bug'] })
  } finally { stub.restore() }
})

test('github_update_issue refuses an empty patch', async () => {
  const tool = toolsOf(makeConfig()).get('github_update_issue')
  await assert.rejects(
    () => tool.execute({ repo: 'octo/hello', number: 3 }, { signal: new AbortController().signal }),
    /nothing to update/,
  )
})

test('all four new write tools disappear when allowWrite is false', () => {
  const readonly = toolsOf(makeConfig({ allowWrite: false }))
  for (const name of ['github_create_pr', 'github_update_issue', 'github_merge_pr', 'github_submit_review']) {
    assert.equal(readonly.has(name), false, `${name} must be gated`)
  }
})
