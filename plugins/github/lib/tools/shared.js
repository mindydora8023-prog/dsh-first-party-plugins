/**
 * Shared helpers and summarizers for the github_* tool family.
 */

import { existsSync } from 'node:fs'

import { parseNextPage } from '../api.js'
import { resolveToken } from '../auth.js'
import { hostFromApiBase, parseRepo } from '../config.js'

export const text = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

export function jsonOutput() {
  // An object root must declare additionalProperties explicitly, or the schema compiler rejects it outright.
  return { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) }
}

export const REPO_PARAM = {
  type: 'string',
  description: 'owner/name, or a repository URL. Omit to use the configured default.',
}

export const PAGING = {
  limit: { type: 'number', description: 'Maximum items (plugin default, max 100).' },
  page: { type: 'number', description: 'Page number, starting at 1.' },
}

export function integerArg(value, fallback, min, max) {
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
export function positiveIntArg(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || Math.trunc(number) !== number || number <= 0) {
    throw new Error(`${label} must be a positive whole number`)
  }
  return Math.trunc(number)
}

export function trimTo(value, max) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max)}\n... [truncated ${value.length - max} characters]`
}

/** Page hint from the GitHub `Link` header. */
export function pageInfo(result, page) {
  const header = result?.headers
  const link = header && typeof header.get === 'function' ? header.get('link') : ''
  const next = parseNextPage(link)
  return {
    page,
    has_more: next !== null,
    next_page: next === null ? null : next,
  }
}

/**
 * Positive whole number, or null when the argument was omitted.
 * A present but unusable value throws: clamping 0 up to 1 would hide the mistake.
 */
export function optionalPositive(value, label, max) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || Math.trunc(number) !== number || number <= 0 || number > max) {
    throw new Error(`${label} must be a positive whole number up to ${max}`)
  }
  return number
}

/** Physical lines: CRLF is one break, a trailing newline does not add an empty line. */
export function splitLines(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  const parts = normalized.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * Take a line window out of a file, then stop on the character budget between
 * lines. Cutting a single over-long line does not advertise the next line as
 * `next_offset`: that would skip the rest of the line that was just truncated.
 */
export function sliceLines(contentText, offset, lineLimit, maxChars) {
  const lines = splitLines(contentText)
  const start = offset
  if (lines.length > 0 && start > lines.length) {
    return {
      content: '',
      line_start: start,
      line_count: 0,
      total_lines: lines.length,
      truncated: false,
      next_offset: null,
      past_end: true,
    }
  }
  const rest = lines.slice(start - 1)
  const cap = lineLimit === null ? rest.length : lineLimit
  const chosen = []
  let used = 0
  let stoppedByChars = false
  for (const line of rest) {
    if (chosen.length >= cap) break
    const extra = chosen.length === 0 ? line.length : line.length + 1
    if (chosen.length > 0 && used + extra > maxChars) {
      stoppedByChars = true
      break
    }
    chosen.push(line)
    used += extra
    if (chosen.length === 1 && line.length > maxChars) {
      stoppedByChars = true
      break
    }
  }
  let content = chosen.join('\n')
  const midLine = chosen.length === 1 && chosen[0].length > maxChars
  if (content.length > maxChars) content = trimTo(content, maxChars)
  const consumed = chosen.length
  const moreLines = start - 1 + consumed < lines.length
  const truncated = moreLines || stoppedByChars || (chosen.length === 1 && chosen[0].length > maxChars)
  const nextOffset = !midLine && (moreLines || stoppedByChars) ? start + consumed : null
  return {
    content,
    line_start: lines.length === 0 ? 1 : start,
    line_count: consumed,
    total_lines: lines.length,
    truncated,
    next_offset: nextOffset,
    past_end: false,
  }
}

export function assertAlive(config) {
  if (typeof config.killSwitch === 'string' && config.killSwitch !== '' && existsSync(config.killSwitch)) {
    throw new Error(`The GitHub plugin is disabled by the kill-switch file: ${config.killSwitch}`)
  }
}

export function assertSignal(exec) {
  if (exec?.signal?.aborted) throw new Error('the call was cancelled')
}

/**
 * Compute an appropriate tool-level timeout from config.timeoutMs, accounting
 * for retries and multi-request tools instead of hardcoded 45s/60s caps.
 */
export function toolTimeoutMs(config, calls = 1, replaySafe = true) {
  const perAttempt = Number.isFinite(config?.timeoutMs) ? config.timeoutMs : 30000
  const attempts = replaySafe ? Math.max(1, (config?.retries ?? 0) + 1) : 1
  const retryDelay = Number.isFinite(config?.retryBaseDelayMs) ? config.retryBaseDelayMs : 400
  const retryPad = replaySafe && attempts > 1 ? retryDelay * attempts : 0
  const budget = Math.ceil((perAttempt * attempts + retryPad) * Math.max(1, calls)) + 5000
  return Math.min(300000, Math.max(15000, budget))
}

/**
 * Resolve the credential for a read call.
 */
export function authForRead(config, options) {
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
export function authForWrite(config) {
  const resolved = resolveToken(config)
  if (resolved.token === '') {
    throw new Error(
      'Writing to GitHub needs a token. Write {"token": "ghp_..."} to ' + config.credentialsFile + ', or set GITHUB_TOKEN. ' +
        'Run github_status to see which credential sources were checked.',
    )
  }
  return resolved
}

export function repoOf(args, config) {
  const allowedHost = config.host || hostFromApiBase(config.apiBaseUrl)
  return parseRepo(args.repo, config.defaultRepo, allowedHost)
}

export function summarizeRepo(item) {
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

export function summarizeIssue(item) {
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

export function summarizeCommit(item) {
  return {
    sha: (item.sha ?? '').slice(0, 12),
    author: item.author?.login ?? item.commit?.author?.name ?? '',
    date: item.commit?.author?.date ?? '',
    message: String(item.commit?.message ?? '').split('\n')[0].slice(0, 200),
    html_url: item.html_url ?? '',
  }
}

export function summarizeWorkflowRun(item) {
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
 * Turn a write failure whose effect is non-`none` into a structured result,
 * preserving the actual `effectState` (`unknown`, `applied`, or `partial`).
 *
 * @param error the caught value.
 * @param context `{ action, repo, number }` echoed back so the model sees target.
 * @returns the failure record, or null when the error carries no ambiguity.
 */
export function writeFailureRecord(error, context = {}) {
  const state = error !== null && typeof error === 'object' ? error.effectState : 'none'
  if (state !== 'unknown' && state !== 'applied' && state !== 'partial') return null
  const code = state === 'unknown' ? 'WRITE_OUTCOME_UNKNOWN' : `WRITE_OUTCOME_${state.toUpperCase()}`
  return {
    status: state,
    applied: state === 'applied',
    action: context.action ?? '',
    repo: context.repo ?? '',
    ...(context.number === undefined ? {} : { number: context.number }),
    error: {
      code,
      effectState: state,
      retry: 'never',
      message: error instanceof Error ? error.message : String(error),
      nextAction:
        typeof error?.nextAction === 'string' && error.nextAction !== ''
          ? error.nextAction
          : 'Read the resource back before trying again.',
    },
  }
}
