/**
 * Issue tools: github_issues, github_issue.
 */

import { get, parseNextPage } from '../api.js'
import {
  REPO_PARAM,
  assertAlive,
  assertSignal,
  authForRead,
  integerArg,
  jsonOutput,
  positiveIntArg,
  repoOf,
  summarizeIssue,
  toolTimeoutMs,
  trimTo,
} from './shared.js'

export function buildIssueTools(config) {
  return [
    {
      name: 'github_issues',
      description: 'List issues in one repository. Pull requests are omitted unless include_pull_requests is true.',
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
      timeoutMs: toolTimeoutMs(config, 3, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const includePrs = args.include_pull_requests === true
        const perPage = integerArg(args.limit, config.perPage, 1, 100)
        const startPage = integerArg(args.page, 1, 1, 100)
        let currentPage = startPage

        // The issues endpoint returns issues and pull requests interleaved.
        // Walk up to 3 upstream pages when filtering PRs out so a PR-heavy page
        // does not appear empty.
        const maxPages = includePrs ? 1 : 3
        const collected = []
        const seen = new Set()
        let rate = null
        let scanned = 0
        let lastNextPage = null
        let lastLinkHeader = ''
        let lastPageShort = false
        let lastFetchedPage = startPage

        for (let index = 0; index < maxPages; index += 1) {
          assertSignal(exec)
          const result = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/issues`,
            {
              state: typeof args.state === 'string' ? args.state : 'open',
              labels: args.labels,
              sort: typeof args.sort === 'string' ? args.sort : 'updated',
              direction: typeof args.direction === 'string' ? args.direction : 'desc',
              per_page: perPage,
              page: currentPage,
            },
            { signal: exec?.signal },
          )
          lastFetchedPage = currentPage
          rate = result.rate ?? rate
          const raw = Array.isArray(result.data) ? result.data : []
          scanned += raw.length
          for (const item of raw.map(summarizeIssue)) {
            if (!includePrs && item.pull_request === true) continue
            if (seen.has(item.number)) continue
            seen.add(item.number)
            collected.push(item)
          }
          lastLinkHeader = result.headers?.get('link') ?? ''
          lastNextPage = parseNextPage(lastLinkHeader)
          lastPageShort = raw.length < perPage
          if (lastPageShort) break
          if (lastLinkHeader !== '' && lastNextPage === null) break
          if (collected.length >= perPage) break
          currentPage += 1
        }

        const issues = collected.slice(0, perPage)
        const overflowed = collected.length > perPage
        const upstreamHasMore = !lastPageShort && (lastNextPage !== null || lastLinkHeader === '')
        const hasMore = overflowed || upstreamHasMore
        const nextPage = !hasMore
          ? null
          : (overflowed ? lastFetchedPage : (lastNextPage ?? lastFetchedPage + 1))

        const output = {
          repo: target.full,
          count: issues.length,
          page: startPage,
          has_more: hasMore,
          next_page: nextPage,
          rate,
          issues,
        }
        if (issues.length === 0 && !includePrs && scanned > 0) {
          output.scanned = scanned
          output.note =
            `Scanned ${scanned} entries and none was a real issue: this repository is dominated by pull requests. ` +
            'Try include_pull_requests:true, github_search_issues with "is:issue", or a labels filter.'
        }
        return output
      },
    },
    {
      name: 'github_issue',
      description: 'Read one issue or pull request, including its body and the first comments.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Issue or pull request number.' },
        include_comments: { type: 'boolean', description: 'Include comments (default true).' },
        comment_limit: { type: 'number', description: 'Maximum comments (default 20, max 100).' },
        max_body_chars: { type: 'number', description: `Truncate the body at this many characters (default ${config.maxChars}).` },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 2, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        const number = positiveIntArg(args.number, 'number')
        const maxBody = integerArg(args.max_body_chars, config.maxChars, 200, 2000000)
        const result = await get(
          config,
          authInfo,
          `/repos/${target.owner}/${target.repo}/issues/${number}`,
          undefined,
          { signal: exec?.signal },
        )
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
          assertSignal(exec)
          const comments = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/issues/${number}/comments`,
            { per_page: integerArg(args.comment_limit, 20, 1, 100) },
            { signal: exec?.signal },
          )
          output.comments = (Array.isArray(comments.data) ? comments.data : []).map((comment) => ({
            user: comment.user?.login ?? '',
            created_at: comment.created_at ?? '',
            body: trimTo(String(comment.body ?? ''), 4000),
          }))
        }
        return output
      },
    },
  ]
}
