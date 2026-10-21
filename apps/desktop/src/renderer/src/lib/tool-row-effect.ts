import { serverIdOfMappedName } from '@tenon-app/contracts'
import type { MessageRowContract, ToolOutcomeViewContract } from '@tenon-app/contracts'

/** One classification shared by the expanded sentence and the settlement counts. */
const TOOL_CATEGORY = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'write',
  Edit: 'write',
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

export function toolRowEffect(
  outcome: ToolOutcomeViewContract | null,
  toolName: string,
  isError?: boolean,
) {
  if (!outcome) return null
  const category = toolCategory(toolName)
  const reversibility = outcome.reversibility ?? 'unknown'
  const did =
    outcome.state !== 'completed' ||
    category === null ||
    category === 'read' ||
    category === 'search' ||
    (category === 'write' && isError !== false)
      ? null
      : category
  return {
    didKey: did === null ? null : (`tool.did.${did}` as const),
    undoKey:
      did === null || did === 'online'
        ? null
        : reversibility === 'irreversible'
          ? ('confirm.irreversible' as const)
          : reversibility === 'unknown' && category === 'write'
            ? ('confirm.undo.unknownFile' as const)
            : (`confirm.undo.${reversibility}` as const),
    marker: reversibility === 'irreversible',
    loginServerId:
      outcome.source === 'connector-unauthorized' ? serverIdOfMappedName(toolName) : null,
  }
}

/** Match by callKey first: provider tool IDs can be reused in later replies. */
export function writeResultError(
  rows: readonly MessageRowContract[],
  callKey: string,
): boolean | undefined {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!
    const callIndex = row.calls?.findIndex((call) => call.callKey === callKey) ?? -1
    if (callIndex < 0) continue
    const request = row.content.filter((block) => block.type === 'tool-request')[callIndex]
    if (!request) return undefined
    for (const responseRow of rows.slice(rowIndex + 1)) {
      for (const block of responseRow.content) {
        if (block.type === 'tool-response' && block.id === request.id) return block.isError
      }
    }
    return undefined
  }
  return undefined
}
