/**
 * Actions tool: github_actions.
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
  positiveIntArg,
  repoOf,
  splitLines,
  summarizeWorkflowRun,
  toolTimeoutMs,
  trimTo,
} from './shared.js'

const ANNOTATION_CONCURRENCY = 4

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) return
      results[current] = await fn(items[current], current)
    }
  })
  await Promise.all(workers)
  return results
}

export function buildActionsTools(config) {
  return [
    {
      name: 'github_actions',
      description: 'List recent Actions runs. When run_id is set, return that run plus failed (or all) jobs, their annotations, and the tail of a failed job log.',
      parameters: {
        repo: REPO_PARAM,
        branch: { type: 'string', description: 'Only runs for this branch.' },
        status: {
          type: 'string',
          enum: ['queued', 'in_progress', 'completed', 'success', 'failure', 'cancelled', 'skipped'],
          description: 'Only runs in this status.',
        },
        run_id: { type: 'number', description: 'Return this single run, with jobs and the failure detail, instead of a list.' },
        failed_only: { type: 'boolean', description: 'When run_id is set, only include jobs that did not succeed (default true).' },
        include_log: { type: 'boolean', description: 'Include the tail of one failed job log when run_id is set (default true).' },
        log_lines: { type: 'number', description: 'How many log lines to keep from the end (default 80, max 400).' },
        limit: { type: 'number', description: `Maximum runs (default ${config.perPage}, max 100).` },
        page: { type: 'number', description: 'Page number (default 1).' },
      },
      output: jsonOutput(),
      timeoutMs: toolTimeoutMs(config, 4, true),
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        assertAlive(config)
        assertSignal(exec)
        const target = repoOf(args, config)
        const authInfo = authForRead(config)
        if (args.run_id !== undefined) {
          const id = positiveIntArg(args.run_id, 'run_id')
          const failedOnly = args.failed_only !== false
          const run = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/actions/runs/${id}`,
            undefined,
            { signal: exec?.signal },
          )
          assertSignal(exec)
          const jobsResult = await get(
            config,
            authInfo,
            `/repos/${target.owner}/${target.repo}/actions/runs/${id}/jobs`,
            { filter: failedOnly ? 'latest' : 'all', per_page: 100 },
            { signal: exec?.signal },
          )
          const allJobs = Array.isArray(jobsResult.data?.jobs) ? jobsResult.data.jobs : []
          const jobs = failedOnly
            ? allJobs.filter((job) => job.conclusion !== 'success' && job.conclusion !== 'skipped' && job.conclusion !== 'neutral')
            : allJobs
          const selectedJobs = jobs.slice(0, 20)

          const summarized = await mapWithConcurrency(selectedJobs, ANNOTATION_CONCURRENCY, async (job) => {
            const steps = Array.isArray(job.steps) ? job.steps : []
            const entry = {
              id: job.id,
              name: job.name ?? '',
              status: job.status ?? '',
              conclusion: job.conclusion ?? '',
              failed_steps: steps
                .filter((step) => step.conclusion === 'failure' || step.conclusion === 'cancelled' || step.conclusion === 'timed_out')
                .map((step) => step.name ?? '')
                .filter((name) => name !== ''),
              annotations: [],
            }
            if (job.conclusion === 'failure' || job.conclusion === 'cancelled' || job.conclusion === 'timed_out') {
              assertSignal(exec)
              try {
                const notes = await get(
                  config,
                  authInfo,
                  `/repos/${target.owner}/${target.repo}/check-runs/${job.id}/annotations`,
                  { per_page: 20 },
                  { signal: exec?.signal },
                )
                entry.annotations = (Array.isArray(notes.data) ? notes.data : []).slice(0, 10).map((note) => ({
                  path: note.path ?? '',
                  start_line: note.start_line ?? null,
                  end_line: note.end_line ?? null,
                  level: note.annotation_level ?? '',
                  message: trimTo(String(note.message ?? ''), 500),
                }))
              } catch (error) {
                if (exec?.signal?.aborted || error?.code === 'cancelled') throw error
                entry.annotations_error = 'annotations unavailable'
              }
            }
            return entry
          })

          const output = {
            repo: target.full,
            run: summarizeWorkflowRun(run.data ?? {}),
            job_count: allJobs.length,
            jobs: summarized,
            rate: run.rate,
          }
          if (args.include_log !== false) {
            const failed = summarized.find((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out' || job.conclusion === 'cancelled')
            if (failed !== undefined) {
              assertSignal(exec)
              const lines = integerArg(args.log_lines, 80, 1, 400)
              try {
                const log = await get(
                  config,
                  authInfo,
                  `/repos/${target.owner}/${target.repo}/actions/jobs/${failed.id}/logs`,
                  {},
                  { accept: 'application/vnd.github+json', raw: true, signal: exec?.signal },
                )
                const rawText = typeof log.data === 'string' ? log.data : ''
                const allLines = splitLines(rawText)
                const joinedTail = allLines.slice(-lines).join('\n')
                const charCap = config.maxChars
                const cappedTail = trimTo(joinedTail, charCap)
                output.log = {
                  job_id: failed.id,
                  job_name: failed.name,
                  line_count: allLines.length,
                  tail: cappedTail,
                  truncated: allLines.length > lines || joinedTail.length > charCap,
                }
              } catch (error) {
                if (exec?.signal?.aborted || error?.code === 'cancelled') throw error
                output.log = { job_id: failed.id, job_name: failed.name, error: error instanceof Error ? error.message : String(error) }
              }
            }
          }
          return output
        }

        const page = integerArg(args.page, 1, 1, 100)
        const result = await get(
          config,
          authInfo,
          `/repos/${target.owner}/${target.repo}/actions/runs`,
          {
            branch: args.branch,
            status: args.status,
            per_page: integerArg(args.limit, config.perPage, 1, 100),
            page,
          },
          { signal: exec?.signal },
        )
        const runs = Array.isArray(result.data?.workflow_runs) ? result.data.workflow_runs.map(summarizeWorkflowRun) : []
        return {
          repo: target.full,
          total: result.data?.total_count ?? runs.length,
          count: runs.length,
          ...pageInfo(result, page),
          rate: result.rate,
          runs,
        }
      },
    },
  ]
}
