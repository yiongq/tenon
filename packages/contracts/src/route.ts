import { z } from 'zod'

/**
 * A renderer → main request/response channel. Both directions are validated:
 * main never sees an unparsed request, and a handler's return value is checked
 * against `response` before it crosses back.
 */
export interface RouteDef<Req extends z.ZodType, Res extends z.ZodType> {
  readonly kind: 'route'
  readonly channel: string
  readonly request: Req
  readonly response: Res
}

/** A main → renderer event channel with a validated payload. */
export interface EventDef<Payload extends z.ZodType> {
  readonly kind: 'event'
  readonly channel: string
  readonly payload: Payload
}

export function defineRoute<Req extends z.ZodType, Res extends z.ZodType>(
  channel: string,
  shape: { request: Req; response: Res },
): RouteDef<Req, Res> {
  return { kind: 'route', channel, request: shape.request, response: shape.response }
}

export function defineEvent<Payload extends z.ZodType>(
  channel: string,
  payload: Payload,
): EventDef<Payload> {
  return { kind: 'event', channel, payload }
}

export type RouteRequest<R> = R extends RouteDef<infer Req, z.ZodType> ? z.infer<Req> : never
export type RouteResponse<R> = R extends RouteDef<z.ZodType, infer Res> ? z.infer<Res> : never
export type EventPayload<E> = E extends EventDef<infer P> ? z.infer<P> : never

/** Machine-readable failure; the UI maps `code` to copy, never shows `message` verbatim. */
export const ipcErrorSchema = z.object({
  code: z.enum(['invalid-request', 'invalid-response', 'handler-failed']),
  message: z.string(),
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
})
export type IpcError = z.infer<typeof ipcErrorSchema>

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export function ipcResultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }),
  ])
}

/** The subset of Electron's `ipcMain` the registry needs; kept structural so contracts never imports electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export type RouteHandler<R extends RouteDef<z.ZodType, z.ZodType>> = (
  input: RouteRequest<R>,
  event: unknown,
) => Promise<RouteResponse<R>> | RouteResponse<R>

function issuesOf(error: z.ZodError): NonNullable<IpcError['issues']> {
  return error.issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
    message: issue.message,
  }))
}

/**
 * The only sanctioned way to expose a main-process handler over IPC. The
 * listener never throws: a request that fails `route.request` yields
 * `{ ok: false, error: { code: 'invalid-request' } }`, a throwing handler
 * yields `handler-failed`, and a handler returning something that fails
 * `route.response` yields `invalid-response`.
 */
export function registerRoute<R extends RouteDef<z.ZodType, z.ZodType>>(
  ipc: IpcMainLike,
  route: R,
  handler: RouteHandler<R>,
): void {
  ipc.handle(route.channel, async (event, raw): Promise<IpcResult<RouteResponse<R>>> => {
    const parsed = route.request.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'invalid-request',
          message: `${route.channel}: request failed validation`,
          issues: issuesOf(parsed.error),
        },
      }
    }
    let result: unknown
    try {
      result = await handler(parsed.data as RouteRequest<R>, event)
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'handler-failed',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
    const checked = route.response.safeParse(result)
    if (!checked.success) {
      return {
        ok: false,
        error: {
          code: 'invalid-response',
          message: `${route.channel}: response failed validation`,
          issues: issuesOf(checked.error),
        },
      }
    }
    return { ok: true, data: checked.data as RouteResponse<R> }
  })
}

/** The subset of a preload bridge the renderer-side caller needs. */
export interface IpcInvokerLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

/** Renderer-side counterpart of registerRoute: validates the envelope coming back from main. */
export async function invokeRoute<R extends RouteDef<z.ZodType, z.ZodType>>(
  ipc: IpcInvokerLike,
  route: R,
  input: RouteRequest<R>,
): Promise<IpcResult<RouteResponse<R>>> {
  const raw = await ipc.invoke(route.channel, input)
  const parsed = ipcResultSchema(route.response).safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid-response',
        message: `${route.channel}: envelope failed validation`,
        issues: issuesOf(parsed.error),
      },
    }
  }
  return parsed.data as IpcResult<RouteResponse<R>>
}
