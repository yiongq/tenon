import type { Server } from '@modelcontextprotocol/server'
export const INSTRUCTIONS: string
export function createFixtureTools(): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}[]
export function createFixtureServer(
  tools?: ReturnType<typeof createFixtureTools>,
  instructions?: string,
): Server
