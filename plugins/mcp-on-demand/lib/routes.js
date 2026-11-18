/**
 * Settings-panel route for mcp-on-demand.
 *
 * GET lists the configured servers (nothing is mounted by reading).
 * POST { name, action: "enable" | "disable" } calls the same tool bodies the
 * model uses, then returns a fresh list so the panel does not guess.
 *
 * ASCII only: see the workspace AGENTS.md encoding rule.
 */

export const SERVERS_PATH = '/api/mcp-on-demand/servers'

/**
 * @param {{ method?: string, path?: string, bodyText?: string, tools: Record<string, { execute: Function }> }} request
 * @returns {Promise<{ status: number, value: object }>}
 */
export async function handleServersRequest(request) {
  const method = request.method
  const path = request.path
  if (path !== SERVERS_PATH) return { status: 404, value: { error: 'not-found' } }

  if (method === 'GET' || method === 'HEAD') {
    const listed = await request.tools.mcpod_list.execute({})
    return { status: 200, value: listed }
  }
  if (method !== 'POST') return { status: 405, value: { error: 'method-not-allowed' } }

  let body
  try {
    body = request.bodyText ? JSON.parse(request.bodyText) : {}
  } catch {
    return { status: 400, value: { error: 'invalid-json' } }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' || body.name === '') {
    return { status: 400, value: { error: 'name-required' } }
  }

  const tool = body.action === 'enable'
    ? request.tools.mcpod_enable
    : body.action === 'disable'
      ? request.tools.mcpod_disable
      : undefined
  if (tool === undefined) return { status: 400, value: { error: 'unknown-action' } }

  /** @type {{ name: string, ttl_seconds?: number }} */
  const args = { name: body.name }
  if (body.action === 'enable' && Number.isFinite(body.ttl_seconds) && body.ttl_seconds >= 0) {
    args.ttl_seconds = body.ttl_seconds
  }
  const result = await tool.execute(args)
  const listed = await request.tools.mcpod_list.execute({})
  return { status: 200, value: { result, servers: listed.servers, hint: listed.hint } }
}
