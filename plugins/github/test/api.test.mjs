/**
 * Unit tests for the REST client, using a stubbed global fetch and local HTTP
 * servers for the proxy tunnel path.
 *
 *   node --test test/api.test.mjs
 */

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import test from 'node:test'

import { GitHubError, describeWriteCheck, parseNextPage, request, tunnelledFetch } from '../lib/api.js'
import { scrub } from '../lib/auth.js'
import { readConfig } from '../lib/config.js'

// Stubs replace globalThis.fetch, so the proxy path (node:https) must stay off.
const config = readConfig(
  { retries: 0, timeoutMs: 5000, retryBaseDelayMs: 5, proxyFromEnv: false, proxyFromSystem: false },
  { pluginDir: 'E:/tmp', profileDir: '', home: '' },
)
const authInfo = { token: 'ghp_secretsecretsecret', source: 'test' }

function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const result = await handler(url, init)
    const status = result.status ?? 200
    const body = status === 204 || status === 205 || status === 304 ? null : (result.body ?? '')
    return new Response(body, {
      status,
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
})

test('a 401 explains how to fix the credential using credentialsFile without leaking the token', async () => {
  const stub = stubFetch(() => ({ status: 401, body: JSON.stringify({ message: 'Bad credentials' }) }))
  try {
    await assert.rejects(
      request(config, authInfo, { path: '/user' }),
      (error) => {
        assert.ok(error instanceof GitHubError)
        assert.equal(error.status, 401)
        assert.match(error.message, /rejected the credential/)
        assert.match(error.message, /github\.com again/)
        assert.ok(error.message.includes(config.credentialsFile), '401 must point to config.credentialsFile')
        assert.ok(!error.message.includes('next to the plugin'))
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

test('a 429 and a secondary rate-limit 403 are classified as rate-limited rather than missing scope', async () => {
  let mode = '429'
  const stub = stubFetch(() => {
    if (mode === '429') {
      return {
        status: 429,
        headers: { 'retry-after': '60', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900' },
        body: JSON.stringify({ message: 'Too many requests' }),
      }
    }
    return {
      status: 403,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900' },
      body: JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }),
    }
  })
  try {
    await assert.rejects(request(config, authInfo, { path: '/search/code' }), (error) => {
      assert.equal(error.status, 429)
      assert.equal(error.code, 'rate-limited')
      assert.doesNotMatch(error.message, /lacks the required scope/)
      assert.match(error.message, /Retry after 60s/)
      return true
    })
    mode = 'secondary-403'
    await assert.rejects(request(config, authInfo, { path: '/search/code' }), (error) => {
      assert.equal(error.status, 403)
      assert.equal(error.code, 'rate-limited')
      assert.doesNotMatch(error.message, /lacks the required scope/)
      return true
    })
  } finally {
    stub.restore()
  }
})

test('a 403 without a zero quota or rate-limit signal mentions the missing scope', async () => {
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
  const retried = { ...config, retries: 1, retryBaseDelayMs: 5 }
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
  const fast = { ...config, retries: 3, timeoutMs: 25 }
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
  let attempts = 0
  const original = globalThis.fetch
  const retried = { ...config, retries: 3, retryBaseDelayMs: 5 }
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

test('a premature stream close while reading a WRITE response preserves unknown effect', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error('premature close'))
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(
      request(config, authInfo, { method: 'POST', path: '/repos/octo/hello/issues', body: { title: 'x' } }),
      (error) => {
        assert.ok(error instanceof GitHubError)
        assert.equal(error.code, 'write-outcome-unknown')
        assert.equal(error.effectState, 'unknown')
        assert.equal(error.retry, 'never')
        return true
      },
    )
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

test('a 5xx on a read is retried once (and a write is not)', async () => {
  let calls = 0
  const stub = stubFetch(() => {
    calls += 1
    return calls === 1 ? { status: 503, body: '{}' } : { status: 200, body: JSON.stringify({ ok: true }) }
  })
  const retried = { ...config, retries: 1, retryBaseDelayMs: 5 }
  try {
    const result = await request(retried, authInfo, { method: 'GET', path: '/rate_limit' })
    assert.equal(result.status, 200)
    assert.equal(stub.calls.length, 2, 'a 503 on a GET is retried once')
  } finally {
    stub.restore()
  }
})

test('a write rejected with a 4xx reports no effect and stays retryable after a fix', async () => {
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
  const fast = { ...config, retries: 0, timeoutMs: 25 }
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
        assert.match(error.message, /timed out after 25 ms/)
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

test('a response larger than the cap is cancelled instead of buffered', async () => {
  const original = globalThis.fetch
  let cancelled = false
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(
      request(config, authInfo, { path: '/repos/octo/hello' }),
      (error) => {
        assert.ok(error instanceof GitHubError)
        assert.equal(error.code, 'response-too-large')
        assert.equal(error.retry, 'never')
        return true
      },
    )
    assert.equal(cancelled, true)
  } finally {
    globalThis.fetch = original
  }
})

test('a retried GET discards an unbounded error body and still retries', async () => {
  let calls = 0
  const stub = stubFetch(() => {
    calls += 1
    if (calls === 1) {
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(32 * 1024))
        },
      })
      return { status: 503, body: stream, headers: { 'content-type': 'text/plain' } }
    }
    return { status: 200, body: JSON.stringify({ ok: true }) }
  })
  const retried = { ...config, retries: 1, retryBaseDelayMs: 5 }
  try {
    const result = await request(retried, authInfo, { method: 'GET', path: '/rate_limit' })
    assert.equal(result.data.ok, true)
    assert.equal(calls, 2)
  } finally {
    stub.restore()
  }
})

test('scrub removes a token wherever it appears', () => {
  const token = 'ghp_secretsecretsecret'
  assert.equal(scrub(`bearer ${token} rejected`, token), 'bearer [redacted] rejected')
  assert.equal(scrub('nothing to hide', token), 'nothing to hide')
  assert.equal(scrub('short', 'abc'), 'short')
})

// --------------------------------------------------- tunnelledFetch regressions

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

function startConnectProxy(options = {}) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(405)
      res.end()
    })
    server.on('connect', (req, clientSocket, head) => {
      if (options.hangConnect === true) return
      const [host, portText] = req.url.split(':')
      const targetSocket = netConnect(Number(portText), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length > 0) targetSocket.write(head)
        targetSocket.pipe(clientSocket)
        clientSocket.pipe(targetSocket)
      })
      targetSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => targetSocket.destroy())
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

const plainTunnelDeps = {
  allowHttp: true,
  httpRequest,
  httpsRequest: httpRequest,
  createConnection: (tunnel) => tunnel,
}

test('tunnelledFetch follows cross-host 302 redirects and strips Authorization', async () => {
  const seen = []
  const logsServer = await startServer((req, res) => {
    seen.push({ server: 'logs', auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('job log body')
  })
  const apiServer = await startServer((req, res) => {
    seen.push({ server: 'api', auth: req.headers.authorization })
    res.writeHead(302, { location: `http://127.0.0.1:${logsServer.port}/log.txt` })
    res.end()
  })
  const proxy = await startConnectProxy()
  try {
    const response = await tunnelledFetch(
      `http://127.0.0.1:${apiServer.port}/actions/jobs/1/logs`,
      { method: 'GET', headers: { Authorization: 'Bearer ghp_secret00000000000000' } },
      `http://127.0.0.1:${proxy.port}`,
      config,
      0,
      plainTunnelDeps,
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'job log body')
    assert.equal(seen.length, 2)
    assert.equal(seen[0].auth, 'Bearer ghp_secret00000000000000')
    assert.equal(seen[1].auth, undefined, 'Authorization must be stripped across hosts')
  } finally {
    proxy.server.close()
    apiServer.server.close()
    logsServer.server.close()
  }
})

test('tunnelledFetch handles 204 and 304 null-body statuses cleanly', async () => {
  const target = await startServer((req, res) => {
    const status = req.url === '/304' ? 304 : 204
    res.writeHead(status)
    res.end()
  })
  const proxy = await startConnectProxy()
  try {
    const r204 = await tunnelledFetch(
      `http://127.0.0.1:${target.port}/204`,
      { method: 'GET', headers: {} },
      `http://127.0.0.1:${proxy.port}`,
      config,
      0,
      plainTunnelDeps,
    )
    assert.equal(r204.status, 204)
    assert.equal(await r204.text(), '')

    const r304 = await tunnelledFetch(
      `http://127.0.0.1:${target.port}/304`,
      { method: 'GET', headers: {} },
      `http://127.0.0.1:${proxy.port}`,
      config,
      0,
      plainTunnelDeps,
    )
    assert.equal(r304.status, 304)
    assert.equal(await r304.text(), '')
  } finally {
    proxy.server.close()
    target.server.close()
  }
})

test('tunnelledFetch enforces the 8 MiB streaming cap and destroys the socket', async () => {
  const target = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    const chunk = Buffer.alloc(1024 * 1024, 65)
    let sent = 0
    const pump = () => {
      while (sent < 10 && !res.destroyed) {
        sent += 1
        if (!res.write(chunk)) {
          res.once('drain', pump)
          return
        }
      }
      if (!res.destroyed) res.end()
    }
    pump()
  })
  const proxy = await startConnectProxy()
  try {
    await assert.rejects(
      tunnelledFetch(
        `http://127.0.0.1:${target.port}/huge`,
        { method: 'GET', headers: {} },
        `http://127.0.0.1:${proxy.port}`,
        config,
        0,
        plainTunnelDeps,
      ),
      (error) => {
        assert.ok(error instanceof GitHubError)
        assert.equal(error.code, 'response-too-large')
        assert.equal(error.retry, 'never')
        return true
      },
    )
  } finally {
    proxy.server.close()
    target.server.close()
  }
})

test('tunnelledFetch throws AbortError on CONNECT timeout and honours init.signal', async () => {
  const proxy = await startConnectProxy({ hangConnect: true })
  try {
    await assert.rejects(
      tunnelledFetch(
        'http://127.0.0.1:443/test',
        { method: 'GET', headers: {} },
        `http://127.0.0.1:${proxy.port}`,
        { ...config, timeoutMs: 40 },
        0,
        plainTunnelDeps,
      ),
      (error) => {
        assert.equal(error.name, 'AbortError')
        assert.match(error.message, /timed out/)
        return true
      },
    )

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(
      tunnelledFetch(
        'http://127.0.0.1:443/test',
        { method: 'GET', headers: {}, signal: controller.signal },
        `http://127.0.0.1:${proxy.port}`,
        { ...config, timeoutMs: 5000 },
        0,
        plainTunnelDeps,
      ),
      (error) => {
        assert.equal(error.name, 'AbortError')
        return true
      },
    )
  } finally {
    proxy.server.close()
  }
})
