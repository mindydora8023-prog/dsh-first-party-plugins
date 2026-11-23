/**
 * Repository tools: github_get_repo, github_list_files, github_read_file,
 * github_commits, github_branches.
 */

import { get } from '../api.js'
import { encodeRef } from '../config.js'
import {
  REPO_PARAM,
  assertAlive,
  assertSignal,
  authForRead,
  integerArg,
  jsonOutput,
  optionalPositive,
  pageInfo,
  repoOf,
  sliceLines,
  summarizeCommit,
  summarizeRepo,
  toolTimeoutMs,
  trimTo,
} from './shared.js'

export function buildRepoTools(config) {
  return [
    {
      name: 'github_get_repo',
      description: 'Read one repository: description, default branch, language, stars, topics, license, and archive state.',
      parameters: { repo: REPO_PARAM },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const result = await get(config, authInfo, `/repos/${target.owner}/${target.repo}`, undefined, {
          signal: exec?.signal,
        })
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
    },
    {
      name: 'github_list_files',
      description: 'List one directory level, or the whole tree when recursive is true. Returns type, name, path, and size.',
      parameters: {
        repo: REPO_PARAM,
        path: { type: 'string', description: 'Directory path inside the repository (default: the repository root).' },
        ref: { type: 'string', description: 'Branch, tag or commit sha (default: the default branch).' },
        recursive: { type: 'boolean', description: 'Return the full tree under path instead of one level (default false).' },
        limit: { type: 'number', description: `Maximum entries to return (default ${config.maxFiles * 10}, max 2000).` },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : ''
        const limit = integerArg(args.limit, config.maxFiles * 10, 1, 2000)

        if (args.recursive === true) {
          const result = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/git/trees/${ref === '' ? 'HEAD' : encodeRef(ref)}`,
            { recursive: '1' },
            { signal: exec?.signal },
          )
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
          { signal: exec?.signal },
        )
        const list = Array.isArray(result.data) ? result.data : [result.data]
        const entries = list
          .filter((entry) => entry !== null && typeof entry === 'object')
          .slice(0, limit)
          .map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, size: entry.size }))
        return {
          repo: target.full,
          ref: ref === '' ? '(default branch)' : ref,
          path: directory,
          total: list.length,
          count: entries.length,
          entries,
          rate: result.rate,
        }
      },
    },
    {
      name: 'github_read_file',
      description: 'Read one text file at a ref, optionally a line window. Binary files are reported, not decoded. A truncated window returns next_offset for the next call.',
      parameters: {
        repo: REPO_PARAM,
        path: { type: 'string', required: true, description: 'File path inside the repository, e.g. "src/index.ts".' },
        ref: { type: 'string', description: 'Branch, tag or commit sha (default: the default branch).' },
        offset: { type: 'number', description: '1-based first line to return. Omit to start at line 1. Use next_offset from a previous call to continue.' },
        limit: { type: 'number', description: 'Maximum lines to return (default: the whole remainder, capped by max_chars).' },
        max_chars: { type: 'number', description: `Stop the window at this many characters (default ${config.maxChars}).` },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const path = String(args.path ?? '').trim().replace(/^\/+/, '')
        if (path === '') throw new Error('path must not be empty')
        const ref = typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : ''
        const maxChars = integerArg(args.max_chars, config.maxChars, 200, 2000000)
        const offset = optionalPositive(args.offset, 'offset', 10000000) ?? 1
        const lineLimit = optionalPositive(args.limit, 'limit', 20000)
        const urlPath = `/repos/${target.owner}/${target.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`

        let result
        try {
          result = await get(config, authInfo, urlPath, ref === '' ? {} : { ref }, {
            accept: 'application/vnd.github.raw',
            raw: true,
            signal: exec?.signal,
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
        const binaryHeader = /^(image|audio|video)\/|application\/(octet-stream|zip|gzip|pdf|x-)/i.test(contentType.trim())
        const binaryBody = raw.includes('\u0000')
        const binary = binaryHeader || binaryBody
        const contentText = raw.replace(/^\uFEFF/, '')
        const windowed = binary ? null : sliceLines(contentText, offset, lineLimit, maxChars)
        return {
          repo: target.full,
          path,
          ref: ref === '' ? '(default branch)' : ref,
          bytes: Buffer.byteLength(raw, 'utf8'),
          content_type: contentType,
          binary,
          line_start: windowed?.line_start ?? 1,
          line_count: windowed?.line_count ?? 0,
          total_lines: windowed?.total_lines ?? 0,
          truncated: windowed?.truncated === true,
          next_offset: windowed?.next_offset ?? null,
          content: windowed?.content ?? '',
          ...(windowed?.past_end === true ? { note: `offset ${offset} is past the end (${windowed.total_lines} lines)` } : {}),
          rate: result.rate,
        }
      },
    },
    {
      name: 'github_commits',
      description: 'List recent commits, or one commit with its changed files and patches when sha is set. Filter the list by ref, path, or author.',
      parameters: {
        repo: REPO_PARAM,
        ref: { type: 'string', description: 'Branch, tag or sha to list from (default: the default branch). Ignored when sha is set.' },
        sha: { type: 'string', description: 'Return this one commit, including changed files and truncated patches, instead of a list.' },
        path: { type: 'string', description: 'Only commits that touch this path (list mode).' },
        author: { type: 'string', description: 'GitHub login or email to filter by (list mode).' },
        include_patch: { type: 'boolean', description: 'Include each file patch when sha is set (default true).' },
        max_patch_chars: { type: 'number', description: 'Truncate each patch at this many characters (default 4000).' },
        limit: { type: 'number', description: `Maximum commits, or files when sha is set (default ${config.perPage}, max 100).` },
        page: { type: 'number', description: 'Page number (default 1).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const sha = typeof args.sha === 'string' ? args.sha.trim() : ''
        if (sha !== '') {
          if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) throw new Error('sha must be 7 to 64 hex characters')
          const maxPatch = integerArg(args.max_patch_chars, 4000, 200, 100000)
          const result = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/commits/${encodeRef(sha)}`,
            undefined,
            { signal: exec?.signal },
          )
          const data = result.data ?? {}
          const files = (Array.isArray(data.files) ? data.files : []).slice(0, integerArg(args.limit, config.perPage, 1, 100))
          return {
            repo: target.full,
            commit: {
              ...summarizeCommit(data),
              message: trimTo(String(data.commit?.message ?? ''), 4000),
              stats: {
                additions: data.stats?.additions ?? 0,
                deletions: data.stats?.deletions ?? 0,
                total: data.stats?.total ?? 0,
              },
            },
            file_count: Array.isArray(data.files) ? data.files.length : 0,
            count: files.length,
            files: files.map((file) => {
              const entry = {
                filename: file.filename ?? '',
                status: file.status ?? '',
                additions: file.additions ?? 0,
                deletions: file.deletions ?? 0,
              }
              if (args.include_patch !== false) entry.patch = trimTo(String(file.patch ?? ''), maxPatch)
              return entry
            }),
            rate: result.rate,
          }
        }
        const page = integerArg(args.page, 1, 1, 100)
        const result = await get(
          config,
          authInfo,
          `/repos/${target.owner}/${target.repo}/commits`,
          {
            sha: args.ref,
            path: args.path,
            author: args.author,
            per_page: integerArg(args.limit, config.perPage, 1, 100),
            page,
          },
          { signal: exec?.signal },
        )
        const items = (Array.isArray(result.data) ? result.data : []).map(summarizeCommit)
        return { repo: target.full, count: items.length, ...pageInfo(result, page), rate: result.rate, commits: items }
      },
    },
    {
      name: 'github_branches',
      description: 'List repository branches with each head sha, newest first.',
      parameters: {
        repo: REPO_PARAM,
        limit: { type: 'number', description: `Maximum branches (default ${config.perPage}, max 100).` },
        page: { type: 'number', description: 'Page number (default 1).' },
        protected_only: { type: 'boolean', description: 'Only show protected branches (default false).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const page = integerArg(args.page, 1, 1, 100)
        const result = await get(
          config,
          authInfo,
          `/repos/${target.owner}/${target.repo}/branches`,
          {
            per_page: integerArg(args.limit, config.perPage, 1, 100),
            page,
            protected: args.protected_only === true ? 'true' : undefined,
          },
          { signal: exec?.signal },
        )
        const items = (Array.isArray(result.data) ? result.data : []).map((item) => ({
          name: item.name,
          sha: (item.commit?.sha ?? '').slice(0, 12),
          protected: item.protected === true,
        }))
        return { repo: target.full, count: items.length, ...pageInfo(result, page), rate: result.rate, branches: items }
      },
    },
  ]
}
