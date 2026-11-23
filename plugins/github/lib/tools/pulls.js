/**
 * Pull request tools: github_pulls, github_pull_files.
 */

import { get, parseNextPage } from '../api.js'
import {
  REPO_PARAM,
  assertAlive,
  assertSignal,
  authForRead,
  integerArg,
  jsonOutput,
  pageInfo,
  positiveIntArg,
  repoOf,
  toolTimeoutMs,
  trimTo,
} from './shared.js'

export function buildPullTools(config) {
  return [
    {
      name: 'github_pulls',
      description: 'List pull requests with author, branches, draft flag, and merge state. Pass number to read one pull request, including review comments on changed lines.',
      parameters: {
        repo: REPO_PARAM,
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Pull request state (default open). Ignored when number is set.' },
        number: { type: 'number', description: 'Read this one pull request, including line comments, instead of listing.' },
        include_review_comments: { type: 'boolean', description: 'Include review comments on changed lines when number is set (default true).' },
        comment_limit: { type: 'number', description: 'Maximum review comments when number is set (default 30, max 100).' },
        sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: 'Sort order (default created).' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default desc).' },
        limit: { type: 'number', description: `Maximum pull requests (default ${config.perPage}, max 100).` },
        page: { type: 'number', description: 'Page number (default 1).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 2, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        if (args.number !== undefined) {
          const number = positiveIntArg(args.number, 'number')
          const result = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/pulls/${number}`,
            undefined,
            { signal: exec?.signal },
          )
          const item = result.data ?? {}
          const output = {
            repo: target.full,
            number,
            title: item.title ?? '',
            state: item.state ?? '',
            draft: item.draft === true,
            user: item.user?.login ?? '',
            head: item.head?.label ?? '',
            base: item.base?.label ?? '',
            // Preserve null when GitHub has not finished computing mergeability.
            mergeable: typeof item.mergeable === 'boolean' ? item.mergeable : null,
            mergeable_state: item.mergeable_state ?? '',
            commits: item.commits ?? 0,
            changed_files: item.changed_files ?? 0,
            additions: item.additions ?? 0,
            deletions: item.deletions ?? 0,
            body: trimTo(String(item.body ?? ''), config.maxChars),
            html_url: item.html_url ?? '',
            rate: result.rate,
          }
          if (args.include_review_comments !== false) {
            assertSignal(exec)
            const comments = await get(
              config,
              authInfo,
              `/repos/${target.owner}/${target.repo}/pulls/${number}/comments`,
              { per_page: integerArg(args.comment_limit, 30, 1, 100) },
              { signal: exec?.signal },
            )
            const rows = Array.isArray(comments.data) ? comments.data : []
            output.review_comments = rows.map((comment) => ({
              user: comment.user?.login ?? '',
              path: comment.path ?? '',
              line: comment.line ?? comment.original_line ?? null,
              side: comment.side ?? '',
              created_at: comment.created_at ?? '',
              body: trimTo(String(comment.body ?? ''), 2000),
            }))
            output.review_comment_count = rows.length
            output.review_comments_has_more = parseNextPage(comments.headers.get('link')) !== null
          }
          return output
        }
        const page = integerArg(args.page, 1, 1, 100)
        const result = await get(
          config,
          authInfo,
          `/repos/${target.owner}/${target.repo}/pulls`,
          {
            state: typeof args.state === 'string' ? args.state : 'open',
            sort: typeof args.sort === 'string' ? args.sort : 'created',
            direction: typeof args.direction === 'string' ? args.direction : 'desc',
            per_page: integerArg(args.limit, config.perPage, 1, 100),
            page,
          },
          { signal: exec?.signal },
        )
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
        return { repo: target.full, count: items.length, ...pageInfo(result, page), rate: result.rate, pulls: items }
      },
    },
    {
      name: 'github_pull_files',
      description: 'List files changed by a pull request, with additions, deletions, and a truncated patch.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Pull request number.' },
        include_patch: { type: 'boolean', description: 'Include the unified diff per file (default true).' },
        max_patch_chars: { type: 'number', description: 'Truncate each patch at this many characters (default 4000).' },
        limit: { type: 'number', description: `Maximum files (default ${config.maxFiles}, max 100).` },
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
        const number = positiveIntArg(args.number, 'number')
        const maxPatch = integerArg(args.max_patch_chars, 4000, 200, 100000)
        const page = integerArg(args.page, 1, 1, 100)
        const result = await get(
          config,
          authInfo,
          `/repos/${target.owner}/${target.repo}/pulls/${number}/files`,
          {
            per_page: integerArg(args.limit, config.maxFiles, 1, 100),
            page,
          },
          { signal: exec?.signal },
        )
        const files = (Array.isArray(result.data) ? result.data : []).map((file) => {
          const entry = {
            filename: file.filename ?? '',
            status: file.status ?? '',
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            changes: file.changes ?? 0,
          }
          if (args.include_patch !== false) entry.patch = trimTo(String(file.patch ?? ''), maxPatch)
          return entry
        })
        return { repo: target.full, number, count: files.length, ...pageInfo(result, page), rate: result.rate, files }
      },
    },
  ]
}
