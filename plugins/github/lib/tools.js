/**
 * Thin facade assembling the github_* tool family from domain modules.
 */

import { buildActionsTools } from './tools/actions.js'
import { buildIssueTools } from './tools/issues.js'
import { buildPullTools } from './tools/pulls.js'
import { buildRepoTools } from './tools/repo.js'
import { buildSearchTools } from './tools/search.js'
import { writeFailureRecord } from './tools/shared.js'
import { buildStatusTools } from './tools/status.js'
import { buildWriteTools } from './tools/writes.js'

export { writeFailureRecord }

/**
 * Build all tool definitions.
 * @param config Normalized plugin config
 * @param logger Host logger
 */
export function buildTools(config, logger) {
  const tools = [
    ...buildStatusTools(config),
    ...buildSearchTools(config),
    ...buildRepoTools(config),
    ...buildIssueTools(config),
    ...buildPullTools(config),
    ...buildActionsTools(config),
    ...buildWriteTools(config),
  ]

  logger.info(
    'github: built %d tools (write=%s, api=%s)',
    tools.length,
    String(config.allowWrite),
    config.apiBaseUrl,
  )
  return tools
}
