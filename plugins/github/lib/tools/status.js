/**
 * github_status tool.
 */

import { existsSync } from 'node:fs'

import { clearProxyCache, get } from '../api.js'
import { resolveToken } from '../auth.js'
import { assertAlive, assertSignal, jsonOutput, toolTimeoutMs } from './shared.js'

export function buildStatusTools(config) {
  return [
    {
      name: 'github_status',
      description: 'Report the signed-in GitHub account, credential source, scopes, and API quota. Never returns the token.',
      parameters: {
        refresh: { type: 'boolean', description: 'Ignore the cached token and re-read every credential source (default false).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 1, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
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

        if (resolved.token === '') {
          const anonymous = await get(config, resolved, '/rate_limit', undefined, { signal: exec?.signal })
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

        const result = await get(config, resolved, '/user', undefined, { signal: exec?.signal })
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
    },
  ]
}
