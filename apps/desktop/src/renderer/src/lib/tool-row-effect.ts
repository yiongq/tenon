import { serverIdOfMappedName } from '@tenon-app/contracts'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'

/** One classification shared by the expanded sentence and the settlement counts. */
const TOOL_CATEGORY = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'write',
  Edit: 'write',
  Delete: 'delete',
  Bash: 'command',
  WebSearch: 'online',
  WebFetch: 'online',
  Agent: null,
  AskUserQuestion: null,
} as const

export function toolCategory(name: string) {
  return Object.hasOwn(TOOL_CATEGORY, name)
    ? TOOL_CATEGORY[name as keyof typeof TOOL_CATEGORY]
    : 'connector'
}

/**
 * `hasSnapshot`: this call has a snapshot number in the root session's rounds. A Bash call with
 * one says its files come back with the round (command-undo-copy); nothing else reads it.
 */
export function toolRowEffect(
  outcome: ToolOutcomeViewContract | null,
  toolName: string,
  hasSnapshot?: boolean,
) {
  if (!outcome) return null
  const category = toolCategory(toolName)
  const reversibility = outcome.reversibility ?? 'unknown'
  const did =
    outcome.state !== 'completed' ||
    category === null ||
    category === 'read' ||
    category === 'search' ||
    ((category === 'write' || category === 'delete') && outcome.isError !== false)
      ? null
      : category
  return {
    didKey: did === null ? null : (`tool.did.${did}` as const),
    undoKey:
      did === null || did === 'online' || reversibility === 'revertible'
        ? null
        : reversibility === 'irreversible'
          ? ('confirm.irreversible' as const)
          : reversibility === 'unknown' && (category === 'write' || category === 'delete')
            ? ('confirm.undo.unknownFile' as const)
            : reversibility === 'unknown' && category === 'command' && hasSnapshot === true
              ? ('confirm.undo.commandRestored' as const)
              : (`confirm.undo.${reversibility}` as const),
    marker: toolMarker(outcome) !== null,
    loginServerId:
      outcome.source === 'connector-unauthorized' ? serverIdOfMappedName(toolName) : null,
  }
}

/** A sandbox receipt already explains failure; never stack an extra marker on it. */
export function toolMarker(outcome: ToolOutcomeViewContract | null) {
  if (outcome === null || outcome.sandbox !== undefined) return null
  if (outcome.state === 'completed' && outcome.isError === true) return 'failed' as const
  return outcome.reversibility === 'irreversible' && outcome.isError !== true
    ? ('irreversible' as const)
    : null
}
