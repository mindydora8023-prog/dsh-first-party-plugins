/**
 * Minimal GitHub REST client built on fetch (Node 22+), with no third-party
 * dependency: the profile installs plugins with pnpm from a linked directory,
 * so any dependency would have to be resolvable from outside the profile.
 *
 * Design notes:
 *   - One request per call. GitHub's REST API is cheap and stateless, so no
 *     connection pool or ETag cache is maintained here.
 *   - Errors are turned into messages that say what to do next: 401 means the
 *     stored credential is expired or revoked, 403 with a zero remaining quota
 *     means the rate limit is exhausted, 404 is reported with the repo/ref.
 *   - `Link` headers are parsed so listing tools can say `has_more` and give a
 *     page number a model can pass back.
 */

import { spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

import { invalidateToken, scrub } from './auth.js'

const USER_AGENT = 'dsh-plugin-github (+https://github.com)'

/**
 * Resolve the proxy for this request.
 *
 * Node's built-in fetch ignores the Windows Internet Settings proxy, so a
 * direct connection times out on networks that need one (this machine has
 * 127.0.0.1:7897 configured system-wide, and the host process is not started
 * with HTTPS_PROXY). Order:
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
    // The value is either "host:port" or "http=host:port;https=host:port".
    const raw = match[1].trim()
    const chosen = /https=([^;]+)/i.exec(raw)?.[1] ?? /http=([^;]+)/i.exec(raw)?.[1] ?? raw
    SYSTEM_PROXY_CACHE = /^\d/.test(chosen) ? `http://${chosen}` : chosen
  } catch {
    /* a missing reg.exe or an unreadable key just means "no system proxy" */
  }
  return SYSTEM_PROXY_CACHE
}

/** Forget the cached system proxy (used by `github_status refresh`). */
export function clearProxyCache() {
  SYSTEM_PROXY_CACHE = null
}

/**
 * fetch() that honours the configured proxy, with no third-party dependency.
 *
 * Node's global fetch cannot be routed through a proxy, and `undici` is not a
 * resolvable module in a stock Node install (`import 'undici'` throws
 * ERR_MODULE_NOT_FOUND, `node:undici` is not a builtin). The runtime flag
 * NODE_USE_ENV_PROXY only works if the host process was started with it, which
 * a plugin cannot change for itself.
 *
 * So the proxied path uses node:https directly with an HTTP CONNECT tunnel:
 * ask the proxy to open a TCP tunnel to api.github.com:443, then do TLS over
 * that socket. This is what curl -x does, and it needs nothing but the
 * standard library. The non-proxied path keeps the simpler global fetch.
 */
function httpFetch(url, init, config) {
  const proxy = proxyOf(config)
  if (proxy === '') return fetch(url, init)
  return tunnelledFetch(url, init, proxy, config)
}

/** Redirect statuses the tunnel may follow (replay-safe methods only). */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
/** Bound on redirect hops so a redirect loop cannot hang the call. */
const MAX_REDIRECTS = 3

/** Build the Response-shaped object the rest of this file expects. */
async function tunnelledFetch(url, init, proxy, config, hop = 0) {
  const target = new URL(url)
  const proxyUrl = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
  if (target.protocol !== 'https:') throw new Error(`proxy support covers https only, got ${target.protocol}`)

  const proxyAuth =
    proxyUrl.username !== ''
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
      : ''

  // 1. CONNECT through the proxy.
  const tunnel = await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 8080),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        Host: `${target.hostname}:${target.port || 443}`,
        ...(proxyAuth === '' ? {} : { 'Proxy-Authorization': proxyAuth }),
      },
      timeout: Number.isFinite(config?.timeoutMs) ? config.timeoutMs : 20000,
    })
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed with HTTP ${response.statusCode}`))
        return
      }
      resolve(socket)
    })
    request.once('timeout', () => request.destroy(new Error('proxy CONNECT timed out')))
    request.once('error', reject)
    request.end()
  })

  // 2. TLS over the tunnel, then one HTTP request.
  let response
  try {
    const body = init.body === undefined ? null : Buffer.from(String(init.body), 'utf8')
    const headers = { ...init.headers }
    if (body !== null) headers['Content-Length'] = String(body.length)

    response = await new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: target.hostname,
          port: Number(target.port || 443),
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'GET',
          headers,
          createConnection: () => tlsConnect({ socket: tunnel, servername: target.hostname }),
          signal: init.signal,
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            const headers = new Headers()
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(key, item)
              else if (value !== undefined) headers.set(key, String(value))
            }
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 0, headers }))
          })
          response.on('error', reject)
        },
      )
      request.once('error', reject)
      if (body !== null) request.write(body)
      request.end()
    })
  } finally {
    // The tunnel is a single-use socket: responses are fully buffered above, so
    // closing it here cannot truncate anything.
    tunnel.destroy()
  }

  // 3. Follow a same-host redirect for a replay-safe method, mirroring the
  //    direct fetch() path's `redirect: 'follow'`. A renamed/transferred repo
  //    answers 301; without this the tunnelled path (the only path on a
  //    proxy-only network) would report it as a hard failure. We never follow a
  //    redirect for a write (that would re-issue a POST) and never forward the
  //    token to another host.
  if (REDIRECT_STATUS.has(response.status) && hop < MAX_REDIRECTS) {
    const location = response.headers.get('location')
    if (location !== null && location !== '') {
      const method = (init.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        throw new Error(`proxy request was redirected (HTTP ${response.status}); refusing to replay a ${method}`)
      }
      const next = new URL(location, target)
      if (next.protocol !== 'https:') throw new Error(`proxy support covers https only, got ${next.protocol}`)
      if (next.host === target.host) return tunnelledFetch(next.toString(), init, proxy, config, hop + 1)
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
    // May the caller repeat the identical call? See EFFECT_STATES in the
    // workspace: an effect that may have happened never licenses a replay.
    this.retry = details.retry ?? 'after-input-change'
    this.nextAction = details.nextAction ?? ''
  }
}

/**
 * Methods whose replay cannot create a second resource.
 *
 * Only reads are listed. `PUT` and `DELETE` are idempotent per HTTP but this
 * plugin issues none of them; adding one here later should be a deliberate
 * decision, not a side effect of the name looking safe.
 */
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The concrete "did my write land?" instruction for one endpoint.
 *
 * A generic "check before retrying" is not actionable for a model: it needs the
 * exact call that would reveal a duplicate. These are the two write endpoints
 * this plugin exposes; an unknown path falls back to a safe generic sentence.
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

/** Parse `Link: <url>; rel="next", ...` into { next: pageNumber }. */
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

/**
 * Perform one REST request.
 * @param config normalized plugin config
 * @param auth { token, source }
 * @param spec { method, path, query, body, accept, headers }
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
  // A GET that hits a connection blip is worth retrying: nothing was created,
  // and the server saw the same idempotent request twice. A write is different:
  // GitHub has no idempotency key, so a POST that reached the server but whose
  // response was lost (socket reset, proxy drop, half-closed tunnel) would open
  // a SECOND issue or post a SECOND comment if it were replayed. This plugin
  // therefore never retries a write, whatever `retries` says -- and reports the
  // outcome as `unknown` so the model checks before acting.
  const replaySafe = REPLAY_SAFE_METHODS.has(method)
  const attempts = replaySafe ? Math.max(1, config.retries + 1) : 1
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    let response
    try {
      response = await httpFetch(url, {
        method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
        redirect: 'follow',
      }, config)
    } catch (error) {
      clearTimeout(timer)
      const timedOut = error?.name === 'AbortError'
      const reason = timedOut ? `timed out after ${config.timeoutMs} ms` : toMessage(error)
      // Built as a sentence fragment so the two callers below can each end the
      // sentence themselves; appending a period here produced "one..".
      const hint = proxyOf(config) !== '' ? '' : ' (no proxy is configured; set proxyUrl in the plugin config if this network needs one)'
      if (!replaySafe) {
        // The request may already have been applied. Say so explicitly: the
        // dangerous recovery here is blindly calling again.
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
      lastError = new GitHubError(
        `GitHub request failed: ${scrub(reason, token)}${hint}.`,
        { status: 0, code: 'network', effectState: 'none', retry: 'after-input-change' },
      )
      // A network blip deserves one retry; a timeout usually does not, because
      // the same call will burn the same wall-clock budget again.
      if (timedOut) throw lastError
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
        continue
      }
      throw lastError
    }
    clearTimeout(timer)

    // Retry a transient server fault (5xx) or a secondary rate limit (429, or a
    // 403 that carries Retry-After) for a replay-safe request. A write is never
    // retried, whatever the status.
    if (replaySafe && attempt + 1 < attempts) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '')
      const transient = response.status === 502 || response.status === 503 || response.status === 504
        || ((response.status === 429 || response.status === 403) && Number.isFinite(retryAfter) && retryAfter > 0)
      if (transient) {
        try { await response.text() } catch { /* drain the body before retrying */ }
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 400 * (attempt + 1)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }
    }

    const rate = parseRate(response.headers)
    const text = await response.text()
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
      // Remember that this token is dead, so the next call does not repeat the
      // same failure: resolveToken() re-probes the sources once and then falls
      // back to anonymous mode for reads.
      if (typeof auth?.token === 'string' && auth.token !== '') {
        invalidateToken(config, `GitHub rejected the ${auth.source ?? 'stored'} token (401)`)
      }
      throw new GitHubError(
        `GitHub rejected the credential (401). ${scrub(message, token)}. ` +
          'The stored token is invalid or expired: sign in to github.com again from the browser, ' +
          'or put a fresh personal access token in credentials.json next to the plugin. ' +
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
    // A 5xx on a write is the second way the outcome can be unknowable: GitHub
    // returns 500/502/504 for some requests it has already applied, and the
    // client cannot tell that apart from one it dropped. The 4xx branches above
    // are safe to report as `none` because the server explicitly rejected the
    // request before acting.
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

/** Follow up to `maxPages` pages of a list endpoint. */
export async function paginate(config, auth, path, query, options = {}) {
  const limit = Math.min(Math.max(1, Math.trunc(options.pages ?? 1)), 5)
  const items = []
  let page = Math.max(1, Math.trunc(options.startPage ?? 1))
  let rate = null
  let hasMore = false
  for (let index = 0; index < limit; index += 1) {
    const result = await request(config, auth, {
      method: 'GET',
      path,
      query: { ...(query ?? {}), page },
      accept: options.accept,
    })
    rate = result.rate ?? rate
    const data = result.data
    if (Array.isArray(data)) items.push(...data)
    hasMore = parseNextPage(result.headers.get('link')) !== null
    if (!hasMore) break
    page += 1
  }
  return {
    items,
    rate,
    has_more: hasMore,
    next_page: hasMore ? page : null,
  }
}

export { parseNextPage }
