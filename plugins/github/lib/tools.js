/**
 * The github_* tool family.
 *
 * Conventions:
 *   - Reads are cheap and cache-friendly; writes are gated by `allowWrite`.
 *   - Every tool that touches a repository accepts `repo` as "owner/name" and
 *     falls back to the configured `defaultRepo`.
 *   - Results are flattened to what a model needs: numbers, titles, states,
 *     paths. No raw API dumps, except by explicit request.
 *   - Nothing ever echoes the token.
 */

import { existsSync } from 'node:fs'

import { clearProxyCache, get, post } from './api.js'
import { resolveToken } from './auth.js'
import { encodeRef, parseRepo } from './config.js'

const text = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

function jsonOutput() {
  // An object root must declare additionalProperties explicitly, or the schema compiler rejects it outright.
  return { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) }
}

const REPO_PARAM = {
  type: 'string',
  description: 'Repository as "owner/name" (a full https://github.com/owner/name URL also works). Omit to use the configured default repository.',
}

const PAGING = {
  limit: { type: 'number', description: 'Maximum items to return (default: the plugin perPage setting, max 100).' },
  page: { type: 'number', description: 'Page number to start from (default 1).' },
}

function integerArg(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * Parse a required positive integer argument.
 *
 * `integerArg` clamps into a range, so it would quietly turn 0 into `min` and
 * hide a caller mistake; issue and pull request numbers must fail loudly.
 */
function positiveIntArg(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || Math.trunc(number) !== number || number <= 0) {
    throw new Error(`${label} must be a positive whole number`)
  }
  return Math.trunc(number)
}

function trimTo(value, max) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max)}\n... [truncated ${value.length - max} characters]`
}

function assertAlive(config) {
  if (typeof config.killSwitch === 'string' && config.killSwitch !== '' && existsSync(config.killSwitch)) {
    throw new Error(`The GitHub plugin is disabled by the kill-switch file: ${config.killSwitch}`)
  }
}

function assertSignal(exec) {
  if (exec?.signal?.aborted) throw new Error('the call was cancelled')
}

/**
 * Resolve the credential for a read call.
 *
 * Reads do not require a token: with none, GitHub serves public repositories
 * on the anonymous quota (60 requests per hour per address). That keeps the
 * plugin useful before the user configures anything, and no sign-in window is
 * ever opened to obtain one.
 */
function authForRead(config, options) {
  const resolved = resolveToken(config, options)
  if (resolved.token === '') {
    if (!config.allowAnonymous) {
      throw new Error(
        'No GitHub credential and anonymous access is disabled. Write {"token": "ghp_..."} to ' +
          config.credentialsFile + ', or set GITHUB_TOKEN.',
      )
    }
    return { token: '', source: 'anonymous', login: '', detail: 'no credential; public reads only (60 requests per hour)' }
  }
  return resolved
}

/** Writes always need a real token: there is no anonymous identity to attribute them to. */
function authForWrite(config) {
  const resolved = resolveToken(config)
  if (resolved.token === '') {
    throw new Error(
      'Writing to GitHub needs a token. Write {"token": "ghp_..."} to ' + config.credentialsFile + ', or set GITHUB_TOKEN. ' +
        'Run github_status to see which credential sources were checked.',
    )
  }
  return resolved
}

function repoOf(args, config) {
  return parseRepo(args.repo, config.defaultRepo)
}

function summarizeRepo(item) {
  return {
    full_name: item.full_name,
    private: item.private === true,
    description: item.description ?? '',
    language: item.language ?? '',
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    open_issues: item.open_issues_count ?? 0,
    default_branch: item.default_branch ?? '',
    pushed_at: item.pushed_at ?? '',
    archived: item.archived === true,
    html_url: item.html_url ?? '',
  }
}

function summarizeIssue(item) {
  // Never leave an `undefined` value in the result: the host validates tool
  // output as lossless JSON, and a single `undefined` field fails the call
  // ("value is not lossless JSON") even though the data is complete.
  return {
    number: item.number,
    title: item.title ?? '',
    state: item.state ?? '',
    draft: item.draft === true,
    user: item.user?.login ?? '',
    labels: Array.isArray(item.labels) ? item.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean) : [],
    comment_count: item.comments ?? 0,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
    closed_at: item.closed_at ?? '',
    html_url: item.html_url ?? '',
    pull_request: item.pull_request !== undefined,
  }
}

function summarizeCommit(item) {
  return {
    sha: (item.sha ?? '').slice(0, 12),
    author: item.author?.login ?? item.commit?.author?.name ?? '',
    date: item.commit?.author?.date ?? '',
    message: String(item.commit?.message ?? '').split('\n')[0].slice(0, 200),
    html_url: item.html_url ?? '',
  }
}

function summarizeWorkflowRun(item) {
  return {
    id: item.id,
    name: item.name ?? '',
    workflow: item.workflow_id,
    event: item.event ?? '',
    status: item.status ?? '',
    conclusion: item.conclusion ?? '',
    branch: item.head_branch ?? '',
    sha: (item.head_sha ?? '').slice(0, 12),
    run_number: item.run_number,
    created_at: item.created_at ?? '',
    updated_at: item.updated_at ?? '',
    html_url: item.html_url ?? '',
  }
}

/**
 * Build every tool definition.
 * @param config normalized plugin config
 * @param logger host logger
 */
/**
 * Turn a write failure whose effect is UNKNOWN into a structured result.
 *
 * Why this exists: a bare throw tells the model "it failed" and nothing more.
 * For `github_create_issue` / `github_comment` that is actively dangerous --
 * the model cannot tell whether the issue or comment already exists, and its
 * most likely recovery is to call again, which duplicates a PUBLIC artifact
 * under the user's account. So the uncertain case returns a record that answers
 * the three questions the workspace failure contract requires:
 *
 *   effectState  unknown -- it may or may not have been applied
 *   retry        never   -- effects dominate retry advice
 *   nextAction   the exact read that settles the question
 *
 * Errors with a KNOWN effect (`none`, e.g. 401/403/404/422 before the server
 * acted) keep throwing: they are ordinary failures, not ambiguity.
 *
 * Pure function, so this contract is testable without a network.
 *
 * @param error the caught value.
 * @param context `{ action, repo, number }` echoed back so the model sees target.
 * @returns the failure record, or null when the error carries no ambiguity.
 */
export function writeFailureRecord(error, context = {}) {
  const state = error !== null && typeof error === 'object' ? error.effectState : 'none'
  if (state !== 'unknown' && state !== 'applied' && state !== 'partial') return null
  return {
    status: 'unknown',
    applied: false,
    action: context.action ?? '',
    repo: context.repo ?? '',
    ...(context.number === undefined ? {} : { number: context.number }),
    error: {
      code: 'WRITE_OUTCOME_UNKNOWN',
      effectState: 'unknown',
      retry: 'never',
      message: error instanceof Error ? error.message : String(error),
      nextAction:
        typeof error?.nextAction === 'string' && error.nextAction !== ''
          ? error.nextAction
          : 'Read the resource back before trying again.',
    },
  }
}

/**
 * Build all tool definitions.
 * @param config Normalized plugin config
 * @param logger Host logger
 */
export function buildTools(config, logger) {
  const tools = []

  // --------------------------------------------------------------- status

  tools.push({
    name: 'github_status',
    description:
      'Check the GitHub connection: which credential source is in effect (plugin config, GITHUB_TOKEN, credentials.json, ' +
      'Git Credential Manager stored login, or gh CLI), the authenticated account, token scopes, and the remaining API quota. ' +
      'Without a token it reports anonymous mode (public reads only, 60 requests per hour). ' +
      'Use it first when a GitHub tool fails, or to confirm which account is being used. Never returns the token itself.',
    parameters: {
      refresh: { type: 'boolean', description: 'Ignore the cached token and re-read every credential source (default false).' },
    },
    output: jsonOutput(),
    timeoutMs: 45000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      // `refresh` should re-read every connection source, including the Windows
      // system proxy, not just the token (the comment on clearProxyCache promised
      // this but nothing called it).
      if (args.refresh === true) clearProxyCache()
      const resolved = resolveToken(config, { refresh: args.refresh === true })
      const base = {
        ok: true,
        api: config.apiBaseUrl,
        credential_source: resolved.token === '' ? 'anonymous' : resolved.source,
        credential_detail: resolved.token === '' ? 'no credential found; public reads only' : resolved.detail,
        credentials_file: config.credentialsFile,
        credentials_file_exists: existsSync(config.credentialsFile),
        git_credential_enabled: config.useGitCredential,
        gh_cli_enabled: config.useGhCli,
        default_repo: config.defaultRepo,
        write_enabled: config.allowWrite,
        authenticated: resolved.token !== '',
      }

      // Anonymous mode: /rate_limit answers without a token, which proves the
      // network path works and reports the small anonymous quota.
      if (resolved.token === '') {
        const anonymous = await get(config, resolved, '/rate_limit')
        const limits = anonymous.data?.resources ?? {}
        return {
          ...base,
          login: '',
          scopes: [],
          rate: limits.core ?? anonymous.rate,
          search_rate: limits.search ?? null,
          hint:
            'No credential found, so only public repositories can be read (60 requests per hour). ' +
            'To raise the limit and enable writes, write {"token": "ghp_..."} to ' + config.credentialsFile + ' or set GITHUB_TOKEN.',
        }
      }

      const result = await get(config, resolved, '/user')
      const scopes = String(result.headers.get('x-oauth-scopes') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
      const data = result.data ?? {}
      return {
        ...base,
        login: data.login ?? resolved.login ?? '',
        name: data.name ?? '',
        type: data.type ?? '',
        scopes,
        rate: result.rate,
        public_repos: data.public_repos ?? null,
        private_repos: data.total_private_repos ?? null,
      }
    },
  })

  // ---------------------------------------------------------------- search

  tools.push({
    name: 'github_search_repos',
    description:
      'Search repositories on GitHub with the search qualifier syntax (in:name, in:description, language:ts, stars:>1000, ' +
      'topic:cli, user:owner, org:owner, pushed:>2026-01-01). Returns full names, descriptions, stars, language and default branch, ' +
      'sorted by best match. Use it to find a repository before reading its files.',
    parameters: {
      query: { type: 'string', required: true, description: 'GitHub repository search query, e.g. "language:typescript stars:>5000 cli".' },
      sort: { type: 'string', enum: ['best-match', 'stars', 'forks', 'updated', 'help-wanted-issues'], description: 'Sort order (default best-match).' },
      limit: { type: 'number', description: `Maximum results (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAlive(config)
      assertSignal(exec)
      const query = String(args.query ?? '').trim()
      if (query === '') throw new Error('query must not be empty')
      const limit = integerArg(args.limit, config.perPage, 1, 100)
      const page = integerArg(args.page, 1, 1, 100)
      const sort = args.sort === 'best-match' || args.sort === undefined ? undefined : args.sort
      const authInfo = authForRead(config)
      const result = await get(config, authInfo, '/search/repositories', {
        q: query,
        sort,
        order: sort === undefined ? undefined : 'desc',
        per_page: limit,
        page,
      })
      return {
        total: result.data?.total_count ?? 0,
        count: Array.isArray(result.data?.items) ? result.data.items.length : 0,
        incomplete: result.data?.incomplete_results === true,
        rate: result.rate,
        items: (result.data?.items ?? []).map(summarizeRepo),
      }
    },
  })

  tools.push({
    name: 'github_search_code',
    description:
      'Search file contents across GitHub with the code search qualifier syntax (repo:owner/name, path:, language:, filename:, ' +
      'extension:). Returns the matching files with a text fragment. Note: code search needs an authenticated token and covers ' +
      'the default branch of indexed repositories; prefer github_list_files and github_read_file when you know the repository.',
    parameters: {
      query: { type: 'string', required: true, description: 'Code search query, e.g. "repo:owner/name filename:package.json workspaces".' },
      limit: { type: 'number', description: 'Maximum results (default 20, max 100).' },
      page: { type: 'number', description: 'Page number (default 1).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAlive(config)
      assertSignal(exec)
      const query = String(args.query ?? '').trim()
      if (query === '') throw new Error('query must not be empty')
      const authInfo = authForRead(config)
      if (authInfo.token === '') {
        // The code search endpoint rejects anonymous callers outright, so say
        // that here instead of surfacing a bare 401.
        throw new Error(
          'GitHub code search requires a token; anonymous callers are rejected. Use github_list_files and github_read_file ' +
            'instead, or write {"token": "ghp_..."} to ' + config.credentialsFile + '.',
        )
      }
      const result = await get(config, authInfo, '/search/code', {
        q: query,
        per_page: integerArg(args.limit, 20, 1, 100),
        page: integerArg(args.page, 1, 1, 100),
      })
      const items = (result.data?.items ?? []).map((item) => {
        const fragments = Array.isArray(item.text_matches) ? item.text_matches : []
        return {
          repository: item.repository?.full_name ?? '',
          path: item.path ?? '',
          score: item.score,
          fragments: fragments.slice(0, 3).map((fragment) => trimTo(String(fragment.fragment ?? ''), 300)),
          html_url: item.html_url ?? '',
        }
      })
      return { total: result.data?.total_count ?? 0, count: items.length, incomplete: result.data?.incomplete_results === true, rate: result.rate, items }
    },
  })

  tools.push({
    name: 'github_search_issues',
    description:
      'Search issues and pull requests across GitHub (is:issue, is:pr, is:open, author:, assignee:, label:, repo:, mentions:, ' +
      'created:>date). Returns number, title, state, labels, author and URL. Set repo to restrict the search to one repository.',
    parameters: {
      query: { type: 'string', required: true, description: 'Issue/PR search query, e.g. "repo:owner/name is:issue is:open label:bug".' },
      sort: { type: 'string', enum: ['best-match', 'created', 'updated', 'comments'], description: 'Sort order (default best-match).' },
      limit: { type: 'number', description: `Maximum results (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
      repo: REPO_PARAM,
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAlive(config)
      assertSignal(exec)
      let query = String(args.query ?? '').trim()
      if (query === '') throw new Error('query must not be empty')
      if (typeof args.repo === 'string' && args.repo.trim() !== '') {
        query = `repo:${repoOf(args, config).full} ${query}`
      }
      const sort = args.sort === 'best-match' || args.sort === undefined ? undefined : args.sort
      const authInfo = authForRead(config)
      const result = await get(config, authInfo, '/search/issues', {
        q: query,
        sort,
        order: sort === undefined ? undefined : 'desc',
        per_page: integerArg(args.limit, config.perPage, 1, 100),
        page: integerArg(args.page, 1, 1, 100),
      })
      return {
        total: result.data?.total_count ?? 0,
        count: Array.isArray(result.data?.items) ? result.data.items.length : 0,
        rate: result.rate,
        items: (result.data?.items ?? []).map(summarizeIssue),
      }
    },
  })

  // ------------------------------------------------------------------ repo

  tools.push({
    name: 'github_get_repo',
    description:
      'Read one repository: description, visibility, default branch, language, stars/forks, open issue count, topics, license, ' +
      'last push, and whether it is archived. Start here when a task names a repository.',
    parameters: { repo: REPO_PARAM },
    output: jsonOutput(),
    timeoutMs: 45000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}`)
      const data = result.data ?? {}
      return {
        ...summarizeRepo(data),
        topics: Array.isArray(data.topics) ? data.topics : [],
        license: data.license?.spdx_id ?? '',
        created_at: data.created_at ?? '',
        updated_at: data.updated_at ?? '',
        size_kb: data.size ?? 0,
        visibility: data.visibility ?? (data.private === true ? 'private' : 'public'),
        homepage: data.homepage ?? '',
        rate: result.rate,
      }
    },
  })

  tools.push({
    name: 'github_list_files',
    description:
      'List the files and directories at a path in a repository (one tree level), or the whole tree of a ref when `recursive` is true. ' +
      'Returns type, name, path and size. Use it to explore a repository before reading files; combine with a ref to look at a branch, ' +
      'tag or commit sha instead of the default branch.',
    parameters: {
      repo: REPO_PARAM,
      path: { type: 'string', description: 'Directory path inside the repository (default: the repository root).' },
      ref: { type: 'string', description: 'Branch, tag or commit sha (default: the default branch).' },
      recursive: { type: 'boolean', description: 'Return the full tree under path instead of one level (default false).' },
      limit: { type: 'number', description: `Maximum entries to return (default ${config.maxFiles * 10}, max 2000).` },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : ''
      const limit = integerArg(args.limit, config.maxFiles * 10, 1, 2000)

      if (args.recursive === true) {
        const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/git/trees/${ref === '' ? 'HEAD' : encodeRef(ref)}`, {
          recursive: '1',
        })
        const tree = Array.isArray(result.data?.tree) ? result.data.tree : []
        const prefix = typeof args.path === 'string' ? args.path.trim().replace(/^\/+|\/+$/g, '') : ''
        const filtered = prefix === '' ? tree : tree.filter((entry) => String(entry.path ?? '').startsWith(`${prefix}/`))
        return {
          repo: target.full,
          ref: ref === '' ? 'HEAD' : ref,
          path: prefix,
          truncated_by_github: result.data?.truncated === true,
          total: filtered.length,
          count: Math.min(filtered.length, limit),
          entries: filtered.slice(0, limit).map((entry) => ({ type: entry.type, path: entry.path, size: entry.size })),
          rate: result.rate,
        }
      }

      const directory = typeof args.path === 'string' ? args.path.trim().replace(/^\/+|\/+$/g, '') : ''
      const result = await get(
        config,
        authInfo,
        `/repos/${target.owner}/${target.repo}/contents/${directory === '' ? '' : directory.split('/').map(encodeURIComponent).join('/')}`,
        ref === '' ? {} : { ref },
      )
      const list = Array.isArray(result.data) ? result.data : [result.data]
      const entries = list
        .filter((entry) => entry !== null && typeof entry === 'object')
        .slice(0, limit)
        .map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, size: entry.size }))
      return { repo: target.full, ref: ref === '' ? '(default branch)' : ref, path: directory, total: list.length, count: entries.length, entries, rate: result.rate }
    },
  })

  tools.push({
    name: 'github_read_file',
    description:
      'Read one file from a repository at a ref (default: the default branch). Returns the decoded text, the byte size and, when ' +
      'truncated, the note that it was cut off. Binary files are reported rather than decoded. Use github_list_files first to find the path.',
    parameters: {
      repo: REPO_PARAM,
      path: { type: 'string', required: true, description: 'File path inside the repository, e.g. "src/index.ts".' },
      ref: { type: 'string', description: 'Branch, tag or commit sha (default: the default branch).' },
      max_chars: { type: 'number', description: `Truncate the file at this many characters (default ${config.maxChars}).` },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const path = String(args.path ?? '').trim().replace(/^\/+/, '')
      if (path === '') throw new Error('path must not be empty')
      const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : ''
      const maxChars = integerArg(args.max_chars, config.maxChars, 200, 2000000)
      const urlPath = `/repos/${target.owner}/${target.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`

      // Raw media type: the response body is the file itself, so a JSON file is
      // not mistaken for an API document (and a symlink resolves to its target
      // text). Directories answer 404 on this media type, which is why the
      // error is rewritten to point at github_list_files.
      let result
      try {
        result = await get(config, authInfo, urlPath, ref === '' ? {} : { ref }, {
          accept: 'application/vnd.github.raw',
          raw: true,
        })
      } catch (error) {
        if (error?.code === 'not-found' || error?.status === 404) {
          throw new Error(
            `${path} cannot be read as a file at ${ref === '' ? 'the default branch' : ref}. ` +
              'It may be a directory, or it may not exist at that ref. Use github_list_files to see what is there.',
          )
        }
        throw error
      }

      const raw = typeof result.data === 'string' ? result.data : ''
      const contentType = result.headers.get('content-type') ?? ''
      const binary = /content-type:\s*(image|audio|video|application\/(octet-stream|zip|gzip|pdf|x-))|[\u0000]/.test(
        `content-type: ${contentType}`,
      )
      const text = raw.replace(/^\uFEFF/, '')
      return {
        repo: target.full,
        path,
        ref: ref === '' ? '(default branch)' : ref,
        bytes: Buffer.byteLength(raw, 'utf8'),
        content_type: contentType,
        binary,
        truncated: text.length > maxChars,
        content: binary ? '' : trimTo(text, maxChars),
        rate: result.rate,
      }
    },
  })

  tools.push({
    name: 'github_commits',
    description:
      'List recent commits of a repository, optionally limited to a path, branch or author. Returns sha, author, date and the first ' +
      'line of each commit message. Use it to see what changed recently, then github_read_file at that sha to inspect the version.',
    parameters: {
      repo: REPO_PARAM,
      ref: { type: 'string', description: 'Branch, tag or sha to list from (default: the default branch).' },
      path: { type: 'string', description: 'Only commits that touch this path.' },
      author: { type: 'string', description: 'GitHub login or email to filter by.' },
      limit: { type: 'number', description: `Maximum commits (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/commits`, {
        sha: args.ref,
        path: args.path,
        author: args.author,
        per_page: integerArg(args.limit, config.perPage, 1, 100),
        page: integerArg(args.page, 1, 1, 100),
      })
      const items = (Array.isArray(result.data) ? result.data : []).map(summarizeCommit)
      return { repo: target.full, count: items.length, rate: result.rate, commits: items }
    },
  })

  tools.push({
    name: 'github_branches',
    description: 'List the branches of a repository with the head sha of each, newest first. Useful before reading files at a branch or checking whether a branch already exists.',
    parameters: {
      repo: REPO_PARAM,
      limit: { type: 'number', description: `Maximum branches (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
      protected_only: { type: 'boolean', description: 'Only show protected branches (default false).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/branches`, {
        per_page: integerArg(args.limit, config.perPage, 1, 100),
        page: integerArg(args.page, 1, 1, 100),
        protected: args.protected_only === true ? 'true' : undefined,
      })
      const items = (Array.isArray(result.data) ? result.data : []).map((item) => ({
        name: item.name,
        sha: (item.commit?.sha ?? '').slice(0, 12),
        protected: item.protected === true,
      }))
      return { repo: target.full, count: items.length, rate: result.rate, branches: items }
    },
  })

  // -------------------------------------------------------------- issues/PR

  tools.push({
    name: 'github_issues',
    description:
      'List issues of one repository (pull requests are excluded unless include_pull_requests is true). Returns number, title, state, ' +
      'labels, author, comment count and dates. Set state:"all" to include closed issues, and labels for a comma-separated filter.',
    parameters: {
      repo: REPO_PARAM,
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state (default open).' },
      labels: { type: 'string', description: 'Comma-separated label names; an issue must have all of them.' },
      sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: 'Sort order (default updated).' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default desc).' },
      include_pull_requests: { type: 'boolean', description: 'Also return pull requests (the GitHub issues endpoint returns both).' },
      limit: { type: 'number', description: `Maximum issues (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const includePrs = args.include_pull_requests === true
      const perPage = integerArg(args.limit, config.perPage, 1, 100)
      let page = integerArg(args.page, 1, 1, 100)

      // The issues endpoint returns issues and pull requests interleaved, and
      // busy repositories are dominated by pull requests: one page of 25
      // "newest updated" can contain zero real issues. Walk a few pages so a
      // filtered result is not an empty result.
      const maxPages = includePrs ? 1 : 3
      const collected = []
      const seen = new Set()
      let rate = null
      let scanned = 0
      for (let index = 0; index < maxPages; index += 1) {
        const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/issues`, {
          state: typeof args.state === 'string' ? args.state : 'open',
          labels: args.labels,
          sort: typeof args.sort === 'string' ? args.sort : 'updated',
          direction: typeof args.direction === 'string' ? args.direction : 'desc',
          per_page: perPage,
          page,
        })
        rate = result.rate ?? rate
        const raw = Array.isArray(result.data) ? result.data : []
        scanned += raw.length
        for (const item of raw.map(summarizeIssue)) {
          if (!includePrs && item.pull_request === true) continue
          // An issue can shift between pages while paging; never report it twice.
          if (seen.has(item.number)) continue
          seen.add(item.number)
          collected.push(item)
        }
        if (raw.length < perPage) break
        page += 1
        if (collected.length >= perPage) break
      }

      const output = { repo: target.full, count: collected.length, rate, issues: collected.slice(0, perPage) }
      if (collected.length === 0 && !includePrs && scanned > 0) {
        output.scanned = scanned
        output.note =
          `Scanned ${scanned} entries and none was a real issue: this repository is dominated by pull requests. ` +
          'Try include_pull_requests:true, github_search_issues with "is:issue", or a labels filter.'
      }
      return output
    },
  })

  tools.push({
    name: 'github_issue',
    description:
      'Read one issue or pull request with its body, labels, milestone, comment count, and the first comments. Set include_comments ' +
      'to false for the issue alone. Works for both issue numbers and pull request numbers.',
    parameters: {
      repo: REPO_PARAM,
      number: { type: 'number', required: true, description: 'Issue or pull request number.' },
      include_comments: { type: 'boolean', description: 'Include comments (default true).' },
      comment_limit: { type: 'number', description: 'Maximum comments (default 20, max 100).' },
      max_body_chars: { type: 'number', description: `Truncate the body at this many characters (default ${config.maxChars}).` },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const number = positiveIntArg(args.number, 'number')
      const maxBody = integerArg(args.max_body_chars, config.maxChars, 200, 2000000)
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/issues/${number}`)
      const item = result.data ?? {}
      const output = {
        repo: target.full,
        ...summarizeIssue(item),
        body: trimTo(String(item.body ?? ''), maxBody),
        milestone: item.milestone?.title ?? '',
        assignees: Array.isArray(item.assignees) ? item.assignees.map((user) => user?.login).filter(Boolean) : [],
        rate: result.rate,
      }
      if (args.include_comments !== false && (item.comments ?? 0) > 0) {
        const comments = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/issues/${number}/comments`, {
          per_page: integerArg(args.comment_limit, 20, 1, 100),
        })
        output.comments = (Array.isArray(comments.data) ? comments.data : []).map((comment) => ({
          user: comment.user?.login ?? '',
          created_at: comment.created_at ?? '',
          body: trimTo(String(comment.body ?? ''), 4000),
        }))
      }
      return output
    },
  })

  tools.push({
    name: 'github_pulls',
    description:
      'List pull requests of one repository with state, title, author, head/base branches, draft flag, and merge state. ' +
      'Use github_issue with the same number to read the discussion, or github_pull_files to see the diff.',
    parameters: {
      repo: REPO_PARAM,
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Pull request state (default open).' },
      sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: 'Sort order (default created).' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default desc).' },
      limit: { type: 'number', description: `Maximum pull requests (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/pulls`, {
        state: typeof args.state === 'string' ? args.state : 'open',
        sort: typeof args.sort === 'string' ? args.sort : 'created',
        direction: typeof args.direction === 'string' ? args.direction : 'desc',
        per_page: integerArg(args.limit, config.perPage, 1, 100),
        page: integerArg(args.page, 1, 1, 100),
      })
      const items = (Array.isArray(result.data) ? result.data : []).map((item) => ({
        number: item.number,
        title: item.title ?? '',
        state: item.state ?? '',
        draft: item.draft === true,
        user: item.user?.login ?? '',
        head: item.head?.label ?? '',
        base: item.base?.label ?? '',
        mergeable_state: item.mergeable_state ?? '',
        created_at: item.created_at ?? '',
        updated_at: item.updated_at ?? '',
        html_url: item.html_url ?? '',
      }))
      return { repo: target.full, count: items.length, rate: result.rate, pulls: items }
    },
  })

  tools.push({
    name: 'github_pull_files',
    description:
      'Read the changed files of a pull request: status (added/modified/removed), additions/deletions and the patch. ' +
      'Patches are truncated per file and can be turned off with include_patch:false. Use it to review a pull request.',
    parameters: {
      repo: REPO_PARAM,
      number: { type: 'number', required: true, description: 'Pull request number.' },
      include_patch: { type: 'boolean', description: 'Include the unified diff per file (default true).' },
      max_patch_chars: { type: 'number', description: 'Truncate each patch at this many characters (default 4000).' },
      limit: { type: 'number', description: 'Maximum files (default 30, max 100).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      const number = positiveIntArg(args.number, 'number')
      const maxPatch = integerArg(args.max_patch_chars, 4000, 200, 100000)
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/pulls/${number}/files`, {
        per_page: integerArg(args.limit, 30, 1, 100),
      })
      const files = (Array.isArray(result.data) ? result.data : []).map((file) => {
        const entry = {
          filename: file.filename ?? '',
          status: file.status ?? '',
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
        }
        // Omit the key entirely instead of setting it to undefined: the host
        // rejects tool output containing an undefined value.
        if (args.include_patch !== false) entry.patch = trimTo(String(file.patch ?? ''), maxPatch)
        return entry
      })
      return { repo: target.full, number, count: files.length, rate: result.rate, files }
    },
  })

  // --------------------------------------------------------------- actions

  tools.push({
    name: 'github_actions',
    description:
      'List recent GitHub Actions workflow runs of a repository, or one run in detail when run_id is given. Returns the workflow ' +
      'name, status, conclusion, branch, commit sha and the run URL. Use it to check whether CI is green before proposing a merge.',
    parameters: {
      repo: REPO_PARAM,
      branch: { type: 'string', description: 'Only runs for this branch.' },
      status: {
        type: 'string',
        enum: ['queued', 'in_progress', 'completed', 'success', 'failure', 'cancelled', 'skipped'],
        description: 'Only runs in this status.',
      },
      run_id: { type: 'number', description: 'Return this single run in full instead of a list.' },
      limit: { type: 'number', description: `Maximum runs (default ${config.perPage}, max 100).` },
      page: { type: 'number', description: 'Page number (default 1).' },
    },
    output: jsonOutput(),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args) {
      assertAlive(config)
      const target = repoOf(args, config)
      const authInfo = authForRead(config)
      if (args.run_id !== undefined) {
        const id = positiveIntArg(args.run_id, 'run_id')
        const run = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/actions/runs/${id}`)
        return { repo: target.full, run: summarizeWorkflowRun(run.data ?? {}), rate: run.rate }
      }
      const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}/actions/runs`, {
        branch: args.branch,
        status: args.status,
        per_page: integerArg(args.limit, config.perPage, 1, 100),
        page: integerArg(args.page, 1, 1, 100),
      })
      const runs = Array.isArray(result.data?.workflow_runs) ? result.data.workflow_runs.map(summarizeWorkflowRun) : []
      return { repo: target.full, total: result.data?.total_count ?? runs.length, count: runs.length, rate: result.rate, runs }
    },
  })

  // ---------------------------------------------------------------- writes

  if (config.allowWrite) {
    tools.push({
      name: 'github_create_issue',
      description:
        'Open a new issue in a repository. Confirm the title and body with the user before calling this: it creates a public ' +
        '(or organisation-visible) issue under the authenticated account. Returns the issue number and URL.',
      parameters: {
        repo: REPO_PARAM,
        title: { type: 'string', required: true, description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body in Markdown.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply (they must already exist).' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'GitHub logins to assign.' },
      },
      output: jsonOutput(),
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const title = String(args.title ?? '').trim()
        if (title === '') throw new Error('title must not be empty')
        const authInfo = authForWrite(config)
        const payload = { title }
        if (typeof args.body === 'string' && args.body !== '') payload.body = args.body
        if (Array.isArray(args.labels) && args.labels.length > 0) payload.labels = args.labels
        if (Array.isArray(args.assignees) && args.assignees.length > 0) payload.assignees = args.assignees
        let result
        try {
          result = await post(config, authInfo, `/repos/${target.owner}/${target.repo}/issues`, payload)
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'create_issue', repo: target.full })
          if (record !== null) return record
          throw error
        }
        const item = result.data ?? {}
        return { created: true, repo: target.full, ...summarizeIssue(item), body: trimTo(String(item.body ?? ''), 2000) }
      },
    })

    tools.push({
      name: 'github_comment',
      description:
        'Add a comment to an issue or pull request. Confirm the text with the user first: it posts under the authenticated ' +
        'account and notifies watchers. Use github_issue first to read the existing discussion.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Issue or pull request number.' },
        body: { type: 'string', required: true, description: 'Comment body in Markdown.' },
      },
      output: jsonOutput(),
      timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const number = positiveIntArg(args.number, 'number')
        const body = String(args.body ?? '').trim()
        if (body === '') throw new Error('body must not be empty')
        const authInfo = authForWrite(config)
        let result
        try {
          result = await post(config, authInfo, `/repos/${target.owner}/${target.repo}/issues/${number}/comments`, { body })
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'comment', repo: target.full, number })
          if (record !== null) return record
          throw error
        }
        const item = result.data ?? {}
        return {
          created: true,
          repo: target.full,
          number,
          comment_id: item.id ?? null,
          user: item.user?.login ?? '',
          html_url: item.html_url ?? '',
          created_at: item.created_at ?? '',
        }
      },
    })
  }

  // Every write path is gated above; keep the resolved config visible to the
  // caller so github_status can tell the model why a tool is missing.
  logger.info(
    'github: built %d tools (write=%s, api=%s)',
    tools.length,
    String(config.allowWrite),
    config.apiBaseUrl,
  )
  return tools
}
