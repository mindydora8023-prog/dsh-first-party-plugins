/**
 * Minimal GitHub REST client built on fetch (Node 22+), with no third-party
 * dependency: the profile installs plugins with pnpm from a linked directory,
 * so any dependency would have to be resolvable from outside the profile.
 *
 * Design notes:
 *   - One request per call. GitHub's REST API is cheap and stateless, so no
 *     connection pool or ETag cache is maintained here.
 *   - Errors are turned into messages that say what to do next: 401 means the
 *     stored credential is expired or revoked, 403/429 rate limits are
 *     classified separately from missing scopes, 404 is reported with the
 *     repo/ref.
 *   - `Link` headers are parsed so listing tools can say `has_more` and give a
 *     page number a model can pass back.
 */

import { spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

import { invalidateToken, scrub } from './auth.js'
import { hostFromApiBase } from './config.js'

const USER_AGENT = 'dsh-plugin-github (+https://github.com)'

/**
 * Parse a Windows Internet Settings `ProxyServer` registry value into a usable
 * HTTP(S) proxy URL, or '' if none is usable.
 *
 * Examples:
 *   "127.0.0.1:7897"                              -> "http://127.0.0.1:7897"
 *   "localhost:7897"                              -> "http://localhost:7897"
 *   "proxy.corp:8080"                             -> "http://proxy.corp:8080"
 *   "http=a:1;https=proxy.corp:8080"              -> "http://proxy.corp:8080"
 *   "socks=127.0.0.1:1080"                        -> ""
 *   "socks=127.0.0.1:1080;https=proxy.corp:8080"  -> "http://proxy.corp:8080"
 */
export function parseWindowsProxyServer(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed === '') return ''

  let chosen = ''
  if (trimmed.includes('=')) {
    const entries = trimmed.split(';').map((part) => part.trim()).filter(Boolean)
    let httpEntry = ''
    let httpsEntry = ''
    for (const entry of entries) {
      const sep = entry.indexOf('=')
      if (sep <= 0) continue
      const scheme = entry.slice(0, sep).trim().toLowerCase()
      const target = entry.slice(sep + 1).trim()
      if (target === '') continue
      if (scheme === 'https') httpsEntry = target
      else if (scheme === 'http') httpEntry = target
      // socks=, ftp=, etc. are intentionally ignored: CONNECT only speaks HTTP(S).
    }
    chosen = httpsEntry || httpEntry
  } else {
    if (/^socks\d*[a-z]*:\/\//i.test(trimmed)) return ''
    chosen = trimmed
  }

  if (chosen === '') return ''
  const candidate = chosen.includes('://') ? chosen : `http://${chosen}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.hostname === '') return ''
    return candidate
  } catch {
    return ''
  }
}

/**
 * Resolve the proxy for this request.
 *
 * Node's built-in fetch ignores the Windows Internet Settings proxy, so a
 * direct connection times out on networks that need one. Order:
 *   1. an explicit `proxyUrl` in the plugin config
 *   2. the standard proxy environment variables
 *   3. the Windows system proxy from the registry
 * Set `proxyFromSystem: false` to stop reading the registry.
 */
export function proxyOf(config) {
  if (typeof config.proxyUrl === 'string' && config.proxyUrl.trim() !== '') return config.proxyUrl.trim()
  if (config.proxyFromEnv !== false) {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  if (config.proxyFromSystem !== false) return systemProxy()
  return ''
}

let SYSTEM_PROXY_CACHE = null

/**
 * Read the Windows system proxy from the registry.
 *
 * `reg query` is a small built-in executable, so this costs a few milliseconds
 * once per process and adds no dependency. ProxyOverride (the bypass list) is
 * deliberately ignored: api.github.com is never in it on a normal setup, and
 * honouring it faithfully is a lot of surface for no benefit here.
 */
function systemProxy() {
  if (SYSTEM_PROXY_CACHE !== null) return SYSTEM_PROXY_CACHE
  SYSTEM_PROXY_CACHE = ''
  if (process.platform !== 'win32') return SYSTEM_PROXY_CACHE
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enabled = spawnSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    if (enabled.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(String(enabled.stdout ?? ''))) return SYSTEM_PROXY_CACHE
    const server = spawnSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(String(server.stdout ?? ''))
    if (match === null) return SYSTEM_PROXY_CACHE
    SYSTEM_PROXY_CACHE = parseWindowsProxyServer(match[1])
  } catch {
    /* a missing reg.exe or an unreadable key just means "no system proxy" */
  }
  return SYSTEM_PROXY_CACHE
}

/** Forget the cached system proxy (used by `github_status refresh`). */
export function clearProxyCache() {
  SYSTEM_PROXY_CACHE = null
}

/** Stop buffering a response the plugin will only trim or discard. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_DRAIN_BYTES = 64 * 1024

/** Redirect statuses the tunnel may follow (replay-safe methods only). */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
/** Statuses that must pass `null` as the Response body (Fetch spec / Node 24). */
const NULL_BODY_STATUS = new Set([204, 205, 304])
/** Bound on redirect hops so a redirect loop cannot hang the call. */
const MAX_REDIRECTS = 3

function makeAbortError(message) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function stripAuthorization(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') out[key] = value
  }
  return out
}

/**
 * fetch() that honours the configured proxy, with no third-party dependency.
 *
 * The proxied path uses node:https directly with an HTTP CONNECT tunnel:
 * ask the proxy to open a TCP tunnel to host:443, then do TLS over that socket.
 * The non-proxied path keeps the simpler global fetch.
 */
function httpFetch(url, init, config) {
  const proxy = proxyOf(config)
  if (proxy === '') return fetch(url, init)
  return tunnelledFetch(url, init, proxy, config)
}

/** Build the Response-shaped object the rest of this file expects. */
export async function tunnelledFetch(url, init, proxy, config, hop = 0, deps = null) {
  const target = new URL(url)
  const proxyUrl = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
  const allowHttp = deps?.allowHttp === true
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error(`unsupported proxy protocol: ${proxyUrl.protocol}`)
  }
  if (target.protocol !== 'https:' && !(allowHttp && target.protocol === 'http:')) {
    throw new Error(`proxy support covers https only, got ${target.protocol}`)
  }

  const maxBytes = Number.isFinite(config?.maxResponseBytes) && config.maxResponseBytes > 0
    ? config.maxResponseBytes
    : MAX_RESPONSE_BYTES
  const connectRequest = deps?.httpRequest ?? httpRequest
  const tunnelRequest = deps?.httpsRequest ?? httpsRequest
  const createTunnelConnection = deps?.createConnection
    ?? ((tunnel, hostname) => tlsConnect({ socket: tunnel, servername: hostname }))

  const proxyAuth =
    proxyUrl.username !== ''
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
      : ''

  // 1. CONNECT through the proxy, honouring init.signal and timing out as AbortError.
  const targetPort = Number(target.port || (target.protocol === 'http:' ? 80 : 443))
  const tunnel = await new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(makeAbortError('proxy CONNECT aborted'))
      return
    }
    let settled = false
    const request = connectRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 8080),
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...(proxyAuth === '' ? {} : { 'Proxy-Authorization': proxyAuth }),
      },
      timeout: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : 20000,
    })
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      request.destroy()
      reject(makeAbortError('proxy CONNECT aborted'))
    }
    const cleanup = () => {
      if (init.signal) init.signal.removeEventListener('abort', onAbort)
    }
    if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true })

    request.once('connect', (response, socket) => {
      cleanup()
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed with HTTP ${response.statusCode}`))
        return
      }
      resolve(socket)
    })
    request.once('timeout', () => {
      cleanup()
      if (settled) return
      settled = true
      request.destroy()
      reject(makeAbortError('proxy CONNECT timed out'))
    })
    request.once('error', (error) => {
      cleanup()
      if (settled) return
      settled = true
      reject(error)
    })
    request.end()
  })

  // 2. TLS over the tunnel, then one HTTP request with streaming byte cap.
  let response
  try {
    const body = init.body === undefined ? null : Buffer.from(String(init.body), 'utf8')
    const headers = { ...init.headers }
    if (body !== null) headers['Content-Length'] = String(body.length)

    response = await new Promise((resolve, reject) => {
      let settled = false
      const finishError = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const request = tunnelRequest(
        {
          host: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'GET',
          headers,
          createConnection: () => createTunnelConnection(tunnel, target.hostname),
          signal: init.signal,
        },
        (incoming) => {
          const chunks = []
          let total = 0
          let overflowed = false
          incoming.on('data', (chunk) => {
            if (overflowed || settled) return
            total += chunk.length
            if (total > maxBytes) {
              overflowed = true
              request.destroy()
              tunnel.destroy()
              finishError(
                new GitHubError(
                  `GitHub response exceeded ${maxBytes} bytes and was stopped before it was buffered.`,
                  { status: incoming.statusCode ?? 0, code: 'response-too-large', effectState: 'none', retry: 'never' },
                ),
              )
              return
            }
            chunks.push(chunk)
          })
          incoming.on('end', () => {
            if (overflowed || settled) return
            settled = true
            const responseHeaders = new Headers()
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item)
              else if (value !== undefined) responseHeaders.set(key, String(value))
            }
            const status = incoming.statusCode ?? 0
            const payload = NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks)
            resolve(new Response(payload, { status, headers: responseHeaders }))
          })
          incoming.on('error', finishError)
        },
      )
      request.once('error', finishError)
      if (body !== null) request.write(body)
      request.end()
    })
  } finally {
    // The tunnel is a single-use socket: responses are fully buffered above, so
    // closing it here cannot truncate anything.
    tunnel.destroy()
  }

  // 3. Follow redirects for replay-safe methods (GET/HEAD), mirroring direct
  //    fetch()'s `redirect: 'follow'`. Cross-host redirects (such as Actions
  //    log downloads to *.actions.githubusercontent.com) are followed, with
  //    Authorization stripped whenever the host changes so tokens never leak.
  if (REDIRECT_STATUS.has(response.status) && hop < MAX_REDIRECTS) {
    const location = response.headers.get('location')
    if (location !== null && location !== '') {
      const method = (init.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        throw new Error(`proxy request was redirected (HTTP ${response.status}); refusing to replay a ${method}`)
      }
      const next = new URL(location, target)
      if (next.protocol !== 'https:' && !(allowHttp && next.protocol === 'http:')) {
        throw new Error(`proxy support covers https only, got ${next.protocol}`)
      }
      const nextInit = next.host === target.host
        ? init
        : { ...init, headers: stripAuthorization(init.headers) }
      return tunnelledFetch(next.toString(), nextInit, proxy, config, hop + 1, deps)
    }
  }
  return response
}

/** Turn a fetch failure (which hides the cause in `error.cause`) into one line. */
function toMessage(error) {
  const cause = error?.cause
  const code = cause?.code ?? error?.code ?? ''
  const detail = cause?.message ?? error?.message ?? String(error)
  return code === '' ? detail : `${code}: ${detail}`
}

export class GitHubError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'GitHubError'
    this.status = details.status ?? 0
    this.code = details.code ?? ''
    this.documentation = details.documentation ?? ''
    this.rate = details.rate ?? null
    this.body = details.body ?? null
    // Did the request change anything on GitHub? `none` is the default because
    // most failures happen before the server acted. A transport failure on a
    // write is the exception: the bytes may have arrived and been applied.
    this.effectState = details.effectState ?? 'none'
    // May the caller repeat the identical call? An effect that may have
    // happened never licenses a replay.
    this.retry = details.retry ?? 'after-input-change'
    this.nextAction = details.nextAction ?? ''
  }
}

/**
 * Read a response body up to `maxBytes`. A longer body is cancelled and refused
 * instead of being concatenated into one string first.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBody(response, maxBytes) {
  const stream = response.body
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const size = value?.byteLength ?? 0
      total += size
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* already closed */ }
        throw new GitHubError(
          `GitHub response exceeded ${maxBytes} bytes and was stopped before it was buffered.`,
          { status: response.status, code: 'response-too-large', effectState: 'none', retry: 'never' },
        )
      }
      if (size > 0) chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const text = typeof response.text === 'function' ? await response.text() : ''
  if (Buffer.byteLength(text) > maxBytes) {
    throw new GitHubError(
      `GitHub response exceeded ${maxBytes} bytes and was stopped before it was buffered.`,
      { status: response.status, code: 'response-too-large', effectState: 'none', retry: 'never' },
    )
  }
  return text
}

/** Discard a body that will not be parsed, without reading it to the end. */
async function drainBody(response) {
  try {
    await readBody(response, MAX_DRAIN_BYTES)
  } catch {
    /* a too-large or broken body must not block the retry */
  }
}

/**
 * Methods whose replay cannot create a second resource.
 *
 * Only reads are listed. `PUT` and `DELETE` are idempotent per HTTP but this
 * plugin issues none of them as replay-safe; adding one here later should be a
 * deliberate decision.
 */
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The concrete "did my write land?" instruction for one endpoint.
 *
 * @param method the HTTP method, used only for the wording.
 * @param path the request path, e.g. `/repos/o/r/issues`.
 * @returns a one-sentence instruction naming the read that settles the question.
 */
export function describeWriteCheck(method, path) {
  const issueCreate = /\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path)
  if (issueCreate !== null && method === 'POST') {
    return `call github_issues for ${issueCreate[1]}/${issueCreate[2]} sorted by created (newest first) and look for the issue you just tried to open`
  }
  const commentCreate = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path)
  if (commentCreate !== null && method === 'POST') {
    return `call github_issue for ${commentCreate[1]}/${commentCreate[2]} #${commentCreate[3]} and check whether your comment is already there`
  }
  const prCreate = /\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path)
  if (prCreate !== null && method === 'POST') {
    return `call github_pulls for ${prCreate[1]}/${prCreate[2]} and look for the pull request you just opened`
  }
  const prMerge = /\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(path)
  if (prMerge !== null && method === 'PUT') {
    return `call github_pulls with number ${prMerge[3]} for ${prMerge[1]}/${prMerge[2]} and check whether it is now merged`
  }
  const review = /\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(path)
  if (review !== null && method === 'POST') {
    return `call github_pulls with number ${review[3]} for ${review[1]}/${review[2]} and check the latest reviews`
  }
  const issuePatch = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path)
  if (issuePatch !== null && method === 'PATCH') {
    return `call github_issue for ${issuePatch[1]}/${issuePatch[2]} #${issuePatch[3]} and verify the fields you changed`
  }
  return 'read the resource back first and look for the change you attempted'
}

function parseRate(headers) {
  const limit = Number(headers.get('x-ratelimit-limit') ?? '')
  const remaining = Number(headers.get('x-ratelimit-remaining') ?? '')
  const reset = Number(headers.get('x-ratelimit-reset') ?? '')
  const resource = headers.get('x-ratelimit-resource') ?? ''
  if (!Number.isFinite(limit) || limit <= 0) return null
  return {
    resource,
    limit,
    remaining: Number.isFinite(remaining) ? remaining : null,
    reset_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : '',
  }
}

/** Parse `Link: <url>; rel="next", ...` into the next page number. */
function parseNextPage(linkHeader) {
  if (typeof linkHeader !== 'string' || linkHeader === '') return null
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(linkHeader)
  if (match === null) return null
  try {
    const url = new URL(match[1])
    const page = Number(url.searchParams.get('page') ?? '')
    return Number.isFinite(page) && page > 0 ? page : null
  } catch {
    return null
  }
}

function buildQuery(query) {
  if (query === undefined || query === null) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

function sleepWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError('the call was cancelled'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(makeAbortError('the call was cancelled'))
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Perform one REST request.
 * @param config normalized plugin config
 * @param auth { token, source }
 * @param spec { method, path, query, body, accept, headers, raw, signal }
 * @returns {{ data: any, status: number, headers: Headers, rate: object|null }}
 */
export async function request(config, auth, spec) {
  const method = (spec.method ?? 'GET').toUpperCase()
  const path = spec.path.startsWith('/') ? spec.path : `/${spec.path}`
  const url = `${config.apiBaseUrl}${path}${buildQuery(spec.query)}`

  const headers = {
    Accept: spec.accept ?? 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(spec.headers ?? {}),
  }
  if (typeof auth?.token === 'string' && auth.token !== '') {
    headers.Authorization = `Bearer ${auth.token}`
  }
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json'

  const token = auth?.token ?? ''
  const replaySafe = REPLAY_SAFE_METHODS.has(method)
  const attempts = replaySafe ? Math.max(1, config.retries + 1) : 1
  const retryBaseDelayMs = Number.isFinite(config.retryBaseDelayMs) && config.retryBaseDelayMs >= 0
    ? config.retryBaseDelayMs
    : 400
  const maxResponseBytes = Number.isFinite(config.maxResponseBytes) && config.maxResponseBytes > 0
    ? config.maxResponseBytes
    : MAX_RESPONSE_BYTES
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (spec.signal?.aborted) {
      throw new GitHubError('GitHub request was cancelled.', {
        status: 0,
        code: 'cancelled',
        effectState: 'none',
        retry: 'never',
      })
    }

    const controller = new AbortController()
    let timedOut = false
    let callerAborted = false
    const onCallerAbort = () => {
      callerAborted = true
      controller.abort()
    }
    if (spec.signal) spec.signal.addEventListener('abort', onCallerAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, config.timeoutMs)

    let response
    let text = ''
    let shouldRetry = false
    let retryWaitMs = 0

    try {
      response = await httpFetch(url, {
        method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
        redirect: 'follow',
      }, config)

      // Retry a transient server fault (5xx) or a secondary rate limit (429, or a
      // 403 that carries Retry-After) for a replay-safe request. A write is never
      // retried, whatever the status.
      if (replaySafe && attempt + 1 < attempts) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '')
        const transient = response.status === 502 || response.status === 503 || response.status === 504
          || ((response.status === 429 || response.status === 403) && Number.isFinite(retryAfter) && retryAfter > 0)
        if (transient) {
          await drainBody(response)
          shouldRetry = true
          retryWaitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 5000)
            : retryBaseDelayMs * (attempt + 1)
        }
      }

      if (!shouldRetry) {
        text = await readBody(response, maxResponseBytes)
      }
    } catch (error) {
      clearTimeout(timer)
      if (spec.signal) spec.signal.removeEventListener('abort', onCallerAbort)

      // Preserve structured errors such as response-too-large directly.
      if (error instanceof GitHubError) throw error

      const abortedByTimeout = timedOut || (!callerAborted && error?.name === 'AbortError')
      const reason = callerAborted
        ? 'the call was cancelled'
        : (abortedByTimeout ? `timed out after ${config.timeoutMs} ms` : toMessage(error))
      const hint = callerAborted || proxyOf(config) !== ''
        ? ''
        : ' (no proxy is configured; set proxyUrl in the plugin config if this network needs one)'

      if (!replaySafe) {
        // The request may already have been applied (including premature socket
        // close while reading the response). Never retry; report unknown effect.
        throw new GitHubError(
          `GitHub did not answer the ${method}: ${scrub(reason, token)}${hint}. ` +
            'The write may or may not have been applied: GitHub gives no idempotency key, so this call is NOT retried. ' +
            `Check whether it landed before trying again -- ${describeWriteCheck(method, path)}.`,
          {
            status: 0,
            code: 'write-outcome-unknown',
            effectState: 'unknown',
            retry: 'never',
            nextAction: describeWriteCheck(method, path),
          },
        )
      }
      if (callerAborted) {
        throw new GitHubError('GitHub request was cancelled.', {
          status: 0,
          code: 'cancelled',
          effectState: 'none',
          retry: 'never',
        })
      }
      lastError = new GitHubError(
        `GitHub request failed: ${scrub(reason, token)}${hint}.`,
        { status: 0, code: 'network', effectState: 'none', retry: 'after-input-change' },
      )
      if (abortedByTimeout) throw lastError
      if (attempt + 1 < attempts) {
        await sleepWithSignal(retryBaseDelayMs * (attempt + 1), spec.signal)
        continue
      }
      throw lastError
    } finally {
      clearTimeout(timer)
      if (spec.signal) spec.signal.removeEventListener('abort', onCallerAbort)
    }

    if (shouldRetry) {
      await sleepWithSignal(retryWaitMs, spec.signal)
      continue
    }

    const rate = parseRate(response.headers)
    // `raw: true` means the body IS the payload (file content), not an API
    // document: parsing it would turn a JSON file into a fake API object.
    let data = null
    if (spec.raw === true) {
      data = text
    } else if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }

    if (response.ok) return { data, status: response.status, headers: response.headers, rate }

    const details = response.headers.get('x-github-request-id') ?? ''
    const message = typeof data?.message === 'string' ? scrub(data.message, token) : ''
    const suffix = details === '' ? '' : ` (request id ${details})`

    if (response.status === 401) {
      if (typeof auth?.token === 'string' && auth.token !== '') {
        invalidateToken(config, `GitHub rejected the ${auth.source ?? 'stored'} token (401)`, auth.token)
      }
      const host = hostFromApiBase(config.apiBaseUrl)
      throw new GitHubError(
        `GitHub rejected the credential (401). ${scrub(message, token)}. ` +
          `The stored token is invalid or expired: sign in to ${host} again from the browser, ` +
          `or put a fresh personal access token in ${config.credentialsFile}. ` +
          `Source currently in use: ${auth?.source ?? 'none'}.${suffix}`,
        { status: 401, code: 'bad-credentials', body: data },
      )
    }
    if (response.status === 403 || response.status === 429) {
      if (rate !== null && rate.remaining === 0) {
        const until = rate.reset_at === '' ? '' : ` It resets at ${rate.reset_at}.`
        throw new GitHubError(
          `GitHub ${rate.resource || 'API'} rate limit exhausted for this credential (${rate.limit} per window).${until} ` +
            'Unauthenticated and fine-grained tokens have lower limits; wait for the reset or use a token with more quota.',
          { status: response.status, code: 'rate-limited', rate, body: data },
        )
      }
      const retryAfter = Number(response.headers.get('retry-after') ?? '')
      const isSecondaryRateLimit =
        response.status === 429 ||
        (Number.isFinite(retryAfter) && retryAfter > 0) ||
        /secondary rate limit|abuse detection|rate limit exceeded|too many requests/i.test(message)
      if (isSecondaryRateLimit) {
        const waitHint = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Retry after ${retryAfter}s.` : ''
        throw new GitHubError(
          `GitHub rate limit triggered (${response.status}): ${message === '' ? 'too many requests' : message}.${waitHint} ` +
            'Slow down and wait before retrying.' +
            suffix,
          { status: response.status, code: 'rate-limited', rate, body: data },
        )
      }
      throw new GitHubError(
        `GitHub refused the request (${response.status}): ${message === '' ? 'forbidden' : message}. ` +
          'This usually means the token lacks the required scope (repo for private repositories).' +
          suffix,
        { status: response.status, code: 'forbidden', rate, body: data },
      )
    }
    if (response.status === 404) {
      throw new GitHubError(
        `Not found (404): ${message === '' ? path : message}. The repository, ref, file, issue or pull request may not exist, ` +
          'or a private repository is being read with a token that cannot see it.' +
          suffix,
        { status: 404, code: 'not-found', body: data },
      )
    }
    if (response.status === 422) {
      throw new GitHubError(
        `GitHub rejected the request payload (422): ${message === '' ? 'validation failed' : message}${suffix}`,
        { status: 422, code: 'invalid', body: data, documentation: String(data?.documentation_url ?? '') },
      )
    }
    const serverFault = response.status >= 500
    if (!replaySafe && serverFault) {
      throw new GitHubError(
        `GitHub returned ${response.status} to the ${method}: ${message === '' ? 'server error' : message}${suffix}. ` +
          'A server-side failure can come back after the write was applied, so this call is NOT retried. ' +
          `Check whether it landed before trying again -- ${describeWriteCheck(method, path)}.`,
        {
          status: response.status,
          code: 'write-outcome-unknown',
          effectState: 'unknown',
          retry: 'never',
          body: data,
          nextAction: describeWriteCheck(method, path),
        },
      )
    }
    throw new GitHubError(
      `GitHub request failed (${response.status}): ${message === '' ? 'unexpected response' : message}${suffix}`,
      { status: response.status, code: 'http', body: data },
    )
  }

  throw lastError ?? new GitHubError('GitHub request failed for an unknown reason.')
}

/** Convenience wrappers. */
export function get(config, auth, path, query, spec = {}) {
  return request(config, auth, { ...spec, method: 'GET', path, query })
}

export function post(config, auth, path, body, spec = {}) {
  return request(config, auth, { ...spec, method: 'POST', path, body })
}

export { parseNextPage }
