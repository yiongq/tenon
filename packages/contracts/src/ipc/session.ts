import { z } from 'zod'
import { defineRoute } from '../route.js'

/**
 * Reading the stored conversation (spec 01 §desktop 接线): the renderer restores the latest
 * session at startup and pages a session's messages. Writing is `chat.send` — there is no
 * IPC that appends to the tape.
 *
 * The shapes are written from the kernel's `MessageRow` / `ContentBlock`, which are the
 * camelCase form of the `message_projection` columns. They are restated here rather than
 * imported because contracts is bundled into the sandboxed preload and an import of the
 * kernel would drag the whole kernel in with it; a type-level test asserts the two
 * definitions stay mutually assignable, so a drift is a compile error rather than a
 * runtime surprise.
 *
 * Message content is UNTRUSTED: it is model output, and from phase 2 on it carries tool
 * results too. It crosses this boundary as data — the renderer prints it, never evaluates
 * it — and no field here is ever an i18n sentence.
 */

/** Mirrors the kernel's `MAX_READ_LIMIT`; the store refuses more and so does this schema. */
export const SESSION_READ_LIMIT_MAX = 1000

/**
 * Lowercase 8-4-4-4-12 hex — the kernel's `isCanonicalUuid`, restated for the same reason the
 * row shapes are (contracts must not import the kernel). Every id on the tape has this shape, so
 * an id that does not is a typo or a probe, and it is refused HERE rather than turned into a
 * bounded but pointless store read. `chat.send` refuses the same input one layer up; the two
 * boundaries agreeing is the point. A type-level test keeps this regex and the kernel's together.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A session id as the Tape writes it: a canonical UUID (spec 02 exports it for approval.*). */
export const canonicalSessionIdSchema = z.string().regex(CANONICAL_UUID, 'not a canonical uuid')

const limitSchema = z.number().int().min(1).max(SESSION_READ_LIMIT_MAX)
const orderSeqSchema = z.number().int().min(0)

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() })

const imageBlockSchema = z.object({
  type: z.literal('image'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string(),
})

/** The kernel content model, block for block (`ContentBlock` in provider/types.ts). */
export const contentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  z.object({
    type: z.literal('thinking'),
    text: z.string(),
    signature: z.string(),
    provider: z.string(),
    providerModel: z.string(),
  }),
  z.object({
    type: z.literal('redacted-thinking'),
    data: z.string(),
    provider: z.string(),
    providerModel: z.string(),
  }),
  z.object({
    type: z.literal('tool-request'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool-response'),
    id: z.string(),
    content: z.array(z.union([textBlockSchema, imageBlockSchema])),
    isError: z.boolean(),
  }),
  imageBlockSchema,
])
export type ContentBlockContract = z.infer<typeof contentBlockSchema>

/** `message_projection` as the port hands it over: ids and ordinals kept, tenant dropped. */
export const messageRowSchema = z.object({
  sessionId: canonicalSessionIdSchema,
  messageId: z.string().min(1),
  /** `entry_id` of the message's FIRST fact: the stable sort key a revision never moves. */
  orderSeq: orderSeqSchema,
  role: z.enum(['user', 'assistant']),
  status: z.enum(['complete', 'aborted', 'error']),
  content: z.array(contentBlockSchema),
  /** `entry_id` of the fact this content came from — a revision DOES move this one. */
  entryId: orderSeqSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type MessageRowContract = z.infer<typeof messageRowSchema>

/** The newest session that has messages, and the last `limit` of them. `null` = nothing stored. */
export const sessionLatest = defineRoute('session.latest', {
  request: z.object({ limit: limitSchema }),
  response: z
    .object({ sessionId: canonicalSessionIdSchema, messages: z.array(messageRowSchema) })
    .nullable(),
})

/** One page of a session's messages. No cursor = the tail, which is where a reader opens. */
export const sessionMessages = defineRoute('session.messages', {
  request: z.object({
    sessionId: canonicalSessionIdSchema,
    limit: limitSchema,
    afterOrderSeq: orderSeqSchema.optional(),
    beforeOrderSeq: orderSeqSchema.optional(),
  }),
  response: z.array(messageRowSchema),
})

// ----- spec 02: the profile, the workspace and the draft before a session exists ------------------

/**
 * A workspace answer (spec 02 §工作区「路由」; D11, A9): the whole list after the change, with where it
 * came from — or why nothing changed. Written like `providerWriteResultSchema`; the folders restate
 * the kernel's `WorkspaceSetPayload` (real absolute paths, `folders[0]` is where commands run).
 */
export const workspaceResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    folders: z.array(z.string().min(1)),
    origin: z.enum(['picked', 'dedicated']),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['not-cowork', 'unknown-session', 'not-in-list']),
  }),
])
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>

/** Only the session: a folder never comes from the renderer, only from main's dialog or prefill. */
const workspaceTarget = z.object({ sessionId: canonicalSessionIdSchema }).strict()

/** Opens main's directory dialog (multiple folders); a cancel answers the list as it was. */
export const workspacePick = defineRoute('workspace.pick', {
  request: workspaceTarget,
  response: workspaceResultSchema,
})
/** Takes the prefill `config.json` holds (`lastWorkspaceFolders`) into the session's list. */
export const workspaceUsePrefill = defineRoute('workspace.usePrefill', {
  request: workspaceTarget,
  response: workspaceResultSchema,
})
/** Removes one folder already in the list; the list falls back to the dedicated folder when empty. */
export const workspaceRemove = defineRoute('workspace.remove', {
  request: z.object({ sessionId: canonicalSessionIdSchema, folder: z.string().min(1) }).strict(),
  response: workspaceResultSchema,
})

/**
 * A session's profile and workspace (spec 02 §工作区「路由」): the Tape's once it is established, the
 * draft's before. A session neither established nor drafted is a chat with no workspace; phase 1's
 * sessions are established chats with none.
 */
export const sessionFactsResponse = z.object({
  established: z.boolean(),
  profile: z.enum(['chat', 'cowork']),
  workspace: z
    .object({ folders: z.array(z.string().min(1)), origin: z.enum(['picked', 'dedicated']) })
    .nullable(),
})
export type SessionFactsResponse = z.infer<typeof sessionFactsResponse>

/** The home page's profile, into the draft; `established` once the session exists (H1). */
export const sessionSelectProfile = defineRoute('session.selectProfile', {
  request: z
    .object({ sessionId: canonicalSessionIdSchema, profile: z.enum(['chat', 'cowork']) })
    .strict(),
  response: z.discriminatedUnion('ok', [
    sessionFactsResponse.extend({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), code: z.literal('established') }),
  ]),
})

export const sessionFacts = defineRoute('session.facts', {
  request: z.object({ sessionId: canonicalSessionIdSchema }).strict(),
  response: sessionFactsResponse,
})
