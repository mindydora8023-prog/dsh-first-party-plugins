/**
 * Search tools: github_search_repos, github_search_code, github_search_issues.
 */

import { get } from '../api.js'
import {
  REPO_PARAM,
  assertAlive,
  assertSignal,
  authForRead,
  integerArg,
  jsonOutput,
  pageInfo,
  repoOf,
  summarizeIssue,
  summarizeRepo,
  toolTimeoutMs,
  trimTo,
} from './shared.js'

export function buildSearchTools(config) {
  return [
    {
      name: 'github_search_repos',
      description: 'Search repositories with GitHub qualifier syntax. Returns name, description, stars, language, and default branch.',
      parameters: {
        query: { type: 'string', required: true, description: 'GitHub repository search query, e.g. "language:typescript stars:>5000 cli".' },
        sort: { type: 'string', enum: ['best-match', 'stars', 'forks', 'updated', 'help-wanted-issues'], description: 'Sort order (default best-match).' },
        limit: { type: 'number', description: `Maximum results (default ${config.perPage}, max 100).` },
        page: { type: 'number', description: 'Page number (default 1).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
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
        const result = await get(
          config,
          authInfo,
          '/search/repositories',
          {
            q: query,
            sort,
            order: sort === undefined ? undefined : 'desc',
            per_page: limit,
            page,
          },
          { signal: exec?.signal },
        )
        return {
          total: result.data?.total_count ?? 0,
          count: Array.isArray(result.data?.items) ? result.data.items.length : 0,
          incomplete: result.data?.incomplete_results === true,
          ...pageInfo(result, page),
          rate: result.rate,
          items: (result.data?.items ?? []).map(summarizeRepo),
        }
      },
    },
    {
      name: 'github_search_code',
      description: 'Search indexed file contents on the default branch. Needs a token. Returns the path and the matching text fragment when GitHub sends one.',
      parameters: {
        query: { type: 'string', required: true, description: 'Code search query, e.g. "repo:owner/name filename:package.json workspaces".' },
        limit: { type: 'number', description: 'Maximum results (default 20, max 100).' },
        page: { type: 'number', description: 'Page number (default 1).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const query = String(args.query ?? '').trim()
        if (query === '') throw new Error('query must not be empty')
        const authInfo = authForRead(config)
        if (authInfo.token === '') {
          throw new Error(
            'GitHub code search requires a token; anonymous callers are rejected. Use github_list_files and github_read_file ' +
              'instead, or write {"token": "ghp_..."} to ' + config.credentialsFile + '.',
          )
        }
        const page = integerArg(args.page, 1, 1, 100)
        const result = await get(
          config,
          authInfo,
          '/search/code',
          {
            q: query,
            per_page: integerArg(args.limit, 20, 1, 100),
            page,
          },
          {
            headers: { Accept: 'application/vnd.github+json, application/vnd.github.text-match+json' },
            signal: exec?.signal,
          },
        )
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
        return {
          total: result.data?.total_count ?? 0,
          count: items.length,
          incomplete: result.data?.incomplete_results === true,
          ...pageInfo(result, page),
          rate: result.rate,
          items,
        }
      },
    },
    {
      name: 'github_search_issues',
      description: 'Search issues and pull requests with GitHub qualifier syntax. Pass repo to limit it to one repository.',
      parameters: {
        query: { type: 'string', required: true, description: 'Issue/PR search query, e.g. "repo:owner/name is:issue is:open label:bug".' },
        sort: { type: 'string', enum: ['best-match', 'created', 'updated', 'comments'], description: 'Sort order (default best-match).' },
        limit: { type: 'number', description: `Maximum results (default ${config.perPage}, max 100).` },
        page: { type: 'number', description: 'Page number (default 1).' },
        repo: REPO_PARAM,
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
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
        const page = integerArg(args.page, 1, 1, 100)
        const authInfo = authForRead(config)
        const result = await get(
          config,
          authInfo,
          '/search/issues',
          {
            q: query,
            sort,
            order: sort === undefined ? undefined : 'desc',
            per_page: integerArg(args.limit, config.perPage, 1, 100),
            page,
          },
          { signal: exec?.signal },
        )
        return {
          total: result.data?.total_count ?? 0,
          count: Array.isArray(result.data?.items) ? result.data.items.length : 0,
          ...pageInfo(result, page),
          rate: result.rate,
          items: (result.data?.items ?? []).map(summarizeIssue),
        }
      },
    },
  ]
}
