import type { ClientOptions, ListChangedHandlers } from '@modelcontextprotocol/client'

export function mcpClientOptions(
  q: { era?: 'auto' | 'legacy'; listChanged?: ListChangedHandlers } = {},
): ClientOptions {
  return {
    versionNegotiation: { mode: q.era ?? 'legacy' },
    ...(q.listChanged === undefined ? {} : { listChanged: q.listChanged }),
    listMaxPages: 64,
    jsonSchemaValidator: {
      getValidator: () => (data: unknown) => ({
        valid: true,
        data: data as never,
        errorMessage: undefined,
      }),
    },
  }
}
