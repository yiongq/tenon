import type { ClientOptions, ListChangedHandlers } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'

export function mcpClientOptions(
  q: { era?: 'auto' | 'legacy'; listChanged?: ListChangedHandlers } = {},
): ClientOptions {
  return {
    versionNegotiation: { mode: q.era ?? 'legacy' },
    ...(q.listChanged === undefined ? {} : { listChanged: q.listChanged }),
    listMaxPages: 64,
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  }
}
