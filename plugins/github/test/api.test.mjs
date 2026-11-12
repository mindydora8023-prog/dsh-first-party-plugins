/**
 * Unit tests for the REST client, using a stubbed global fetch.
 *
 *   node --test test/api.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { GitHubError, describeWriteCheck, parseNextPage, request } from '../lib/api.js'
import { scrub } from '../lib/auth.js'
import { readConfig } from '../lib/config.js'

// Stubs replace globalThis.fetch, so the proxy path (node:https) must stay off.
const config = readConfig(
  { retries: 0, timeoutMs: 5000, proxyFromEnv: false, proxyFromSystem: false },
  { pluginDir: 'E:/tmp', profileDir: '', home: '' },
)
const authInfo = { token: 'ghp_secretsecretsecret', source: 'test' }

function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const result = await handler(url, init)
    return new Response(result.body ?? '', {
      status: result.status ?? 200,
      headers: result.headers ?? { 'content-type': 'application/json' },
    })
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

test('a successful request carries auth, version headers, and the query', async () => {
  const stub = stubFetch(() => ({ body: JSON.stringify({ full_name: 'octo/hello' }) }))
  try {
    const result = await request(config, authInfo, { path: '/repos/octo/hello', query: { ref: 'main', empty: '' } })
    assert.equal(result.data.full_name, 'octo/hello')
    assert.equal(stub.calls.length, 1)
    const [call] = stub.calls
    assert.equal(call.url, 'https://api.github.com/repos/octo/hello?ref=main')
    assert.equal(call.init.headers.Authorization, 'Bearer ghp_secretsecretsecret')
    assert.equal(call.init.headers['X-GitHub-Api-Version'], '2022-11-28')
    assert.equal(call.init.method, 'GET')
  } finally {
    stub.restore()
  }
});

test('a 401 explains how to fix the credential without leaking the token', async () => {
  const stub = stubFetch(() => ({ status: 401, body: JSON.stringify({ message: 'Bad credentials' }) }))
  try {
    await assert.rejects(
      request(config, authInfo, { path: '/user' }),
      (error) => {
        assert.ok(error instanceof GitHubError)
        assert.equal(error.status, 401)
        assert.match(error.message, /rejected the credential/)
        assert.match(error.message, /github\.com again/)
        assert.ok(!error.message.includes('ghp_secretsecretsecret'))
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('a 403 with an exhausted quota is reported as rate limiting', async () => {
  const stub = stubFetch(() => ({
    status: 403,
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792767094', 'x-ratelimit-resource': 'core' },
    body: JSON.stringify({ message: 'API rate limit exceeded' }),
  }))
  try {
    await assert.rejects(request(config, authInfo, { path: '/user' }), (error) => {
      assert.equal(error.code, 'rate-limited')
      assert.match(error.message, /rate limit exhausted/)
      assert.equal(error.rate.resource, 'core')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('a 403 without a zero quota mentions the missing scope', async () => {
  const stub = stubFetch(() => ({
    status: 403,
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
    body: JSON.stringify({ message: 'Resource not accessible' }),
  }))
  try {
    await assert.rejects(request(config, authInfo, { path: '/user/repos' }), /lacks the required scope/)
  } finally {
    stub.restore()
  }
})

test('a 404 names the path and the possible causes', async () => {
  const stub = stubFetch(() => ({ status: 404, body: JSON.stringify({ message: 'Not Found' }) }))
  try {
    await assert.rejects(request(config, authInfo, { path: '/repos/octo/missing' }), (error) => {
      assert.equal(error.code, 'not-found')
      assert.match(error.message, /private repository/)
      return true
    })
  } finally {
    stub.restore()
  }
})

test('a 422 passes the validation message through', async () => {
  const stub = stubFetch(() => ({ status: 422, body: JSON.stringify({ message: 'Validation Failed', documentation_url: 'https://docs' }) }))
  try {
    await assert.rejects(request(config, authInfo, { method: 'POST', path: '/repos/o/r/issues', body: {} }), (error) => {
      assert.equal(error.code, 'invalid')
      assert.match(error.message, /Validation Failed/)
      assert.equal(error.documentation, 'https://docs')
      return true
    })
  } finally {
    stub.restore()
  }
})

test('a non-JSON body is returned as text rather than throwing', async () => {
  const stub = stubFetch(() => ({ body: 'plain text', headers: { 'content-type': 'text/plain' } }))
  try {
    const result = await request(config, authInfo, { path: '/raw' })
    assert.equal(result.data, 'plain text')
  } finally {
    stub.restore()
  }
})

test('a network error is retried once when retries is 1', async () => {
  let attempts = 0
  const original = globalThis.fetch
  const retried = readConfig({ retries: 1, timeoutMs: 5000, proxyFromEnv: false, proxyFromSystem: false }, { pluginDir: 'E:/tmp', profileDir: '', home: '' })
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('socket hang up')
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await request(retried, authInfo, { path: '/user' })
    assert.equal(result.data.ok, true)
    assert.equal(attempts, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('an aborted request reports a timeout and is not retried', async () => {
  let attempts = 0
  const original = globalThis.fetch
  const fast = readConfig({ retries: 3, timeoutMs: 10, proxyFromEnv: false, proxyFromSystem: false }, { pluginDir: 'E:/tmp', profileDir: '', home: '' })
  globalThis.fetch = async (_url, init) => {
    attempts += 1
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }
  try {
    await assert.rejects(request(fast, authInfo, { path: '/user' }), /timed out/)
    assert.equal(attempts, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('a network error on a WRITE is never retried and reports an unknown effect', async () => {
  // The dangerous case: the POST may have reached GitHub before the connection
  // dropped, so a replay would open a second public issue. `retries: 3` must not
  // loosen this.
  let attempts = 0
  const original = globalThis.fetch
  const retried = readConfig({ retries: 3, timeoutMs: 5000, proxyFromEnv: false, proxyFromSystem: false }, { pluginDir: 'E:/tmp', profileDir: '', home: '' })
  globalThis.fetch = async () => {
    attempts += 1
    throw new Error('socket hang up')
  }
  try {
    await assert.rejects(
      request(retried, authInfo, { method: 'POST', path: '/repos/octo/hello/issues', body: { title: 'x' } }),
      (error) => {
        assert.ok(error instanceof GitHubError)
        assert.equal(error.code, 'write-outcome-unknown')
        assert.equal(error.effectState, 'unknown')
        assert.equal(error.retry, 'never')
        assert.match(error.message, /NOT retried/)
        assert.match(error.nextAction, /github_issues/)
        return true
      },
    )
    assert.equal(attempts, 1, 'a write must be attempted exactly once')
  } finally {
    globalThis.fetch = original
  }
})

test('a 5xx on a write is also unknown, because GitHub can fail after applying', async () => {
  const stub = stubFetch(() => ({ status: 502, body: JSON.stringify({ message: 'Server Error' }) }))
  try {
    await assert.rejects(
      request(config, authInfo, { method: 'POST', path: '/repos/octo/hello/issues/7/comments', body: { body: 'hi' } }),
      (error) => {
        assert.equal(error.code, 'write-outcome-unknown')
        assert.equal(error.effectState, 'unknown')
        assert.equal(error.retry, 'never')
        assert.match(error.nextAction, /github_issue/)
        assert.match(error.nextAction, /#7/)
        return true
      },
    )
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('a write rejected with a 4xx reports no effect and stays retryable after a fix', async () => {
  // 422 is the server refusing to act, so the effect is genuinely `none` and
  // telling the model "never retry" would be wrong.
  const stub = stubFetch(() => ({ status: 422, body: JSON.stringify({ message: 'Validation Failed' }) }))
  try {
    await assert.rejects(
      request(config, authInfo, { method: 'POST', path: '/repos/octo/hello/issues', body: {} }),
      (error) => {
        assert.equal(error.code, 'invalid')
        assert.equal(error.effectState, 'none')
        assert.notEqual(error.retry, 'never')
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('a write timeout is reported as unknown rather than as a plain timeout', async () => {
  const original = globalThis.fetch
  // readConfig clamps timeoutMs to >= 1000, so the assertion uses that value.
  const fast = readConfig({ retries: 0, timeoutMs: 1000, proxyFromEnv: false, proxyFromSystem: false }, { pluginDir: 'E:/tmp', profileDir: '', home: '' })
  globalThis.fetch = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }
  try {
    await assert.rejects(
      request(fast, authInfo, { method: 'POST', path: '/repos/octo/hello/issues', body: { title: 'x' } }),
      (error) => {
        assert.equal(error.code, 'write-outcome-unknown')
        assert.equal(error.retry, 'never')
        assert.match(error.message, /timed out after 1000 ms/)
        // Regression: the hint must not produce a doubled full stop.
        assert.ok(!error.message.includes('one..'), 'message must not contain a doubled period')
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('describeWriteCheck names the read that settles each write endpoint', () => {
  assert.match(describeWriteCheck('POST', '/repos/octo/hello/issues'), /github_issues for octo\/hello/)
  assert.match(describeWriteCheck('POST', '/repos/octo/hello/issues/12/comments'), /github_issue for octo\/hello #12/)
  assert.match(describeWriteCheck('POST', '/something/else'), /read the resource back/)
})

test('parseNextPage extracts the page number from a Link header', () => {
  assert.equal(
    parseNextPage('<https://api.github.com/repos/o/r/issues?page=3&per_page=25>; rel="next", <https://api.github.com/x>; rel="last"'),
    3,
  )
  assert.equal(parseNextPage('<https://api.github.com/x>; rel="prev"'), null)
  assert.equal(parseNextPage(''), null)
  assert.equal(parseNextPage(undefined), null)
})

test('scrub removes a token wherever it appears', () => {
  const token = 'ghp_secretsecretsecret'
  assert.equal(scrub(`bearer ${token} rejected`, token), 'bearer [redacted] rejected')
  assert.equal(scrub('nothing to hide', token), 'nothing to hide')
  assert.equal(scrub('short', 'abc'), 'short')
})
