/**
 * Write tools (gated by config.allowWrite):
 *   github_create_issue, github_comment, github_create_pr,
 *   github_update_issue, github_merge_pr, github_submit_review.
 */

import { post, request } from '../api.js'
import {
  REPO_PARAM,
  assertAlive,
  assertSignal,
  authForWrite,
  jsonOutput,
  positiveIntArg,
  repoOf,
  summarizeIssue,
  toolTimeoutMs,
  trimTo,
  writeFailureRecord,
} from './shared.js'

export function buildWriteTools(config) {
  if (!config.allowWrite) return []
  const writeTimeout = toolTimeoutMs(config, 1, false)
  return [
    {
      name: 'github_create_issue',
      description: 'Open an issue under the signed-in account. Confirm the title and body with the user before calling.',
      parameters: {
        repo: REPO_PARAM,
        title: { type: 'string', required: true, description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body in Markdown.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply (they must already exist).' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'GitHub logins to assign.' },
      },
      output: jsonOutput(),
      timeoutMs: writeTimeout,
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
          result = await post(config, authInfo, `/repos/${target.owner}/${target.repo}/issues`, payload, {
            signal: exec?.signal,
          })
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'create_issue', repo: target.full })
          if (record !== null) return record
          throw error
        }
        const item = result.data ?? {}
        return { created: true, repo: target.full, ...summarizeIssue(item), body: trimTo(String(item.body ?? ''), 2000) }
      },
    },
    {
      name: 'github_comment',
      description: 'Post a comment on an issue or pull request. Confirm the exact text with the user before calling.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Issue or pull request number.' },
        body: { type: 'string', required: true, description: 'Comment body in Markdown.' },
      },
      output: jsonOutput(),
      timeoutMs: writeTimeout,
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
          result = await post(config, authInfo, `/repos/${target.owner}/${target.repo}/issues/${number}/comments`, { body }, {
            signal: exec?.signal,
          })
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
    },
    {
      name: 'github_create_pr',
      description: 'Open a pull request. Confirm the title, head and base branches with the user before calling.',
      parameters: {
        repo: REPO_PARAM,
        title: { type: 'string', required: true, description: 'Pull request title.' },
        head: { type: 'string', required: true, description: 'Source branch (or owner:branch for a fork).' },
        base: { type: 'string', required: true, description: 'Target branch to merge into.' },
        body: { type: 'string', description: 'Pull request body in Markdown.' },
        draft: { type: 'boolean', description: 'Open as a draft. Default false.' },
      },
      output: jsonOutput(),
      timeoutMs: writeTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const title = String(args.title ?? '').trim()
        const head = String(args.head ?? '').trim()
        const base = String(args.base ?? '').trim()
        if (title === '') throw new Error('title must not be empty')
        if (head === '') throw new Error('head must not be empty')
        if (base === '') throw new Error('base must not be empty')
        const payload = { title, head, base }
        if (typeof args.body === 'string' && args.body !== '') payload.body = args.body
        if (args.draft === true) payload.draft = true
        const authInfo = authForWrite(config)
        let result
        try {
          result = await post(config, authInfo, `/repos/${target.owner}/${target.repo}/pulls`, payload, {
            signal: exec?.signal,
          })
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'create_pr', repo: target.full })
          if (record !== null) return record
          throw error
        }
        const item = result.data ?? {}
        return {
          created: true,
          repo: target.full,
          number: item.number ?? null,
          state: item.state ?? '',
          draft: item.draft === true,
          head: item.head?.ref ?? head,
          base: item.base?.ref ?? base,
          html_url: item.html_url ?? '',
        }
      },
    },
    {
      name: 'github_update_issue',
      description: 'Update an issue or pull request: state, title, body, labels or assignees. Confirm the change with the user before calling.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Issue or pull request number.' },
        state: { type: 'string', enum: ['open', 'closed'], description: 'New state.' },
        title: { type: 'string', description: 'New title.' },
        body: { type: 'string', description: 'New body in Markdown.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label set (must already exist).' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Replacement assignee logins.' },
      },
      output: jsonOutput(),
      timeoutMs: writeTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const number = positiveIntArg(args.number, 'number')
        const payload = {}
        if (args.state === 'open' || args.state === 'closed') payload.state = args.state
        if (typeof args.title === 'string') payload.title = args.title
        if (typeof args.body === 'string') payload.body = args.body
        if (Array.isArray(args.labels)) payload.labels = args.labels
        if (Array.isArray(args.assignees)) payload.assignees = args.assignees
        if (Object.keys(payload).length === 0) {
          throw new Error('nothing to update: give state, title, body, labels or assignees')
        }
        const authInfo = authForWrite(config)
        let result
        try {
          result = await request(config, authInfo, {
            method: 'PATCH',
            path: `/repos/${target.owner}/${target.repo}/issues/${number}`,
            body: payload,
            signal: exec?.signal,
          })
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'update_issue', repo: target.full, number })
          if (record !== null) return record
          throw error
        }
        return { updated: true, repo: target.full, number, ...summarizeIssue(result.data ?? {}) }
      },
    },
    {
      name: 'github_merge_pr',
      description: 'Merge a pull request. Confirm the method with the user before calling; this cannot be undone from here.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Pull request number.' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge strategy. Default merge.' },
        commit_title: { type: 'string', description: 'Title for the merge commit (merge/squash).' },
        commit_message: { type: 'string', description: 'Message for the merge commit (merge/squash).' },
      },
      output: jsonOutput(),
      timeoutMs: writeTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const number = positiveIntArg(args.number, 'number')
        const method = args.merge_method === 'squash' || args.merge_method === 'rebase' ? args.merge_method : 'merge'
        const payload = { merge_method: method }
        if (typeof args.commit_title === 'string' && args.commit_title !== '') payload.commit_title = args.commit_title
        if (typeof args.commit_message === 'string' && args.commit_message !== '') payload.commit_message = args.commit_message
        const authInfo = authForWrite(config)
        let result
        try {
          result = await request(config, authInfo, {
            method: 'PUT',
            path: `/repos/${target.owner}/${target.repo}/pulls/${number}/merge`,
            body: payload,
            signal: exec?.signal,
          })
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'merge_pr', repo: target.full, number })
          if (record !== null) return record
          throw error
        }
        const item = result.data ?? {}
        return { merged: item.merged === true, repo: target.full, number, sha: item.sha ?? '', message: trimTo(String(item.message ?? ''), 500) }
      },
    },
    {
      name: 'github_submit_review',
      description: 'Submit a review on a pull request (approve, request changes, or comment). Confirm the verdict and body with the user before calling.',
      parameters: {
        repo: REPO_PARAM,
        number: { type: 'number', required: true, description: 'Pull request number.' },
        event: { type: 'string', required: true, enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'Review verdict.' },
        body: { type: 'string', description: 'Review body. Required unless event is APPROVE.' },
        commit_id: { type: 'string', description: 'Commit SHA to review (defaults to the head commit).' },
      },
      output: jsonOutput(),
      timeoutMs: writeTimeout,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const number = positiveIntArg(args.number, 'number')
        const event = args.event === 'APPROVE' || args.event === 'REQUEST_CHANGES' || args.event === 'COMMENT' ? args.event : ''
        if (event === '') throw new Error('event must be APPROVE, REQUEST_CHANGES or COMMENT')
        const body = typeof args.body === 'string' ? args.body.trim() : ''
        if (event !== 'APPROVE' && body === '') throw new Error('body is required unless event is APPROVE')
        const payload = { event }
        if (body !== '') payload.body = body
        if (typeof args.commit_id === 'string' && args.commit_id !== '') payload.commit_id = args.commit_id
        const authInfo = authForWrite(config)
        let result
        try {
          result = await post(config, authInfo, `/repos/${target.owner}/${target.repo}/pulls/${number}/reviews`, payload, {
            signal: exec?.signal,
          })
        } catch (error) {
          const record = writeFailureRecord(error, { action: 'submit_review', repo: target.full, number })
          if (record !== null) return record
          throw error
        }
        const item = result.data ?? {}
        return { submitted: true, repo: target.full, number, review_id: item.id ?? null, state: item.state ?? '', html_url: item.html_url ?? '' }
      },
    },
  ]
}
