/**
 * Connector tools as table candidates (spec 02 §工具来源、命名与权限键). A source is a connected MCP
 * server; its `tools/list` gives the originals, and each becomes a candidate under its mapped name.
 *
 * Only one annotation is read: `_meta["anthropic/requiresUserInteraction"]`, true only when it is the
 * JSON value `true` (D12). Everything else a server says about its tools is shown, never trusted; the
 * descriptions and results of MCP tools are untrusted content (AGENTS.md).
 */
import { definitionProblem, mcpDefinitionHash } from '../mcp/definition.js'
import type { McpToolSource } from '../loop/ports.js'
import type { ToolCandidate } from './registry.js'
import { mcpToolName } from './registry.js'

const REQUIRES_USER_INTERACTION = 'anthropic/requiresUserInteraction'
/** The MCP field name; bracket access, because it is the protocol's name and not ours. */
const META = '_meta'

/** Every tool of every source, in the order the servers list them; the table sorts. */
export async function mcpCandidates(sources: readonly McpToolSource[]): Promise<ToolCandidate[]> {
  const listed = await Promise.all(
    sources.map(async (source) => ({ source, tools: await source.connection.listTools() })),
  )
  return listed.flatMap(({ source, tools }) =>
    tools.map((tool): ToolCandidate => {
      const name = mcpToolName(source.serverId, tool.name)
      const meta: unknown = (tool as Record<string, unknown>)[META]
      const spec = {
        name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }
      const requiresUserInteraction =
        typeof meta === 'object' &&
        meta !== null &&
        (meta as Record<string, unknown>)[REQUIRES_USER_INTERACTION] === true
      const definitionHash = mcpDefinitionHash({
        spec,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        requiresUserInteraction,
      })
      const problem = definitionProblem({ ...tool, description: tool.description ?? '' })
      return {
        source: 'mcp',
        serverId: source.serverId,
        originalName: tool.name,
        name,
        spec,
        requiresUserInteraction,
        definitionHash,
        ...(source.rank === undefined ? {} : { rank: source.rank }),
        ...(source.review === undefined
          ? {}
          : { review: source.review({ originalName: tool.name, definitionHash }) }),
        ...(problem === null ? {} : { definitionProblem: problem }),
      }
    }),
  )
}
