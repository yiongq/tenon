import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'

export const LINKER_INJECTION_ENV = [
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
] as const
export const RISKY_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'LD_DEBUG',
  'LD_BIND_NOW',
  'LD_ASSUME_KERNEL',
  'PYTHONPATH',
  'PYTHONHOME',
  'NODE_OPTIONS',
  'RUBYOPT',
  'GEM_PATH',
  'GEM_HOME',
  'CLASSPATH',
  'GO111MODULE',
  'GOROOT',
  'APPINIT_DLLS',
  'SESSIONNAME',
  'ComSpec',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'NODE_PATH',
  'BASH_ENV',
  'PERL5OPT',
  'JAVA_TOOL_OPTIONS',
  'PYTHONSTARTUP',
] as const
export const RISKY_ENV_PREFIX = 'npm_config_'
function blocked(name: string): boolean {
  return LINKER_INJECTION_ENV.some((n) => n === name.toUpperCase())
}

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9-]{1,24}$/ // T15
export const mcpServerIdSchema = z
  .string()
  .regex(MCP_SERVER_ID_PATTERN)
  .refine((id) => id !== 'builtin') // 02:1983
export const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128)
export const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/)
  .refine(
    (n) => !/^(mcp-|host$|content-|accept$|connection$|transfer-encoding$|last-event-id$)/i.test(n),
  ) // T37
export const definitionHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const toolSettingSchema = z.enum(['always-allow', 'ask', 'never']) // 02:2210 的三态
export const mcpTransportSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stdio'),
      command: z.string().trim().min(1).max(1024), // 用户写的命令，原样存（T27）
      args: z.array(z.string().max(4096)).max(64),
      envs: z
        .record(envNameSchema, z.string().max(4096))
        .refine((v) => !Object.keys(v).some(blocked)), // 明文（Q8-1）
      env_keys: z
        .array(envNameSchema)
        .max(32)
        .refine((v) => !v.some(blocked)), // 值在钥匙串（Q8-1、T29）
    })
    .refine((v) => v.env_keys.every((n) => !Object.hasOwn(v.envs, n))),
  z.object({
    type: z.literal('http'),
    url: z.string().min(1).max(2048), // 规范化后存（§地址与出网）
    header_keys: z.array(headerNameSchema).max(16), // 静态请求头的名字，值在钥匙串（Q1）
    protocol: z.enum(['auto', 'legacy']), // Q2；新建缺省 'auto'
    oauth: z.object({
      ownClient: z
        .object({
          // 自带 client（Q9、T32）
          clientId: z.string().min(1).max(512),
          redirectPort: z.number().int().min(1024).max(65535), // T30：自带 client 由用户填端口
          hasSecret: z.boolean(), // secret 在钥匙串
          issuer: z.string().url().nullable(), // 第一次登录成功时记下（T32）
        })
        .nullable(),
      issuers: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(8), // 写过钥匙串的 issuer 哈希（T35 删除用）；按最近一次登录排序，最后一个是当前 issuer（§机密「provider 契约」）
    }),
  }),
])
export const mcpToolEntrySchema = z.object({
  setting: toolSettingSchema,
  definitionHash: definitionHashSchema,
})
export const mcpServerSchema = z.object({
  id: mcpServerIdSchema,
  displayName: z.string().trim().min(1).max(64),
  source: z.literal('manual'), // 阶段 5 只增 'directory' | 'plugin' | 'mcpb'
  enabled: z.boolean(),
  transport: mcpTransportSchema,
  handshakeTimeoutSec: z.number().int().min(5).max(300).nullable(), // T8；null = 30
  callTimeoutSec: z
    .number()
    .int()
    .nullable() // T9；null = 60；超出 1–3600 夹到边界、不拒（T9「超出夹到边界」）
    .transform((v) => (v === null ? null : Math.min(3600, Math.max(1, v)))),
  instructions: z.object({ enabled: z.boolean(), pinHash: definitionHashSchema.nullable() }), // Q4-2
  consent: z.object({ launchHash: definitionHashSchema }).nullable(), // Q11-1「以后都允许」
  toolsPinned: z.boolean(), // Q14：第一次成功的列表已整表钉住
  tools: z.record(z.string().min(1).max(512), mcpToolEntrySchema), // T18：原名 → 三态与定义哈希
})

export type McpServer = z.infer<typeof mcpServerSchema>
export function serverIdOfMappedName(name: string): string | null {
  const at = name.indexOf('__')
  if (at < 0) return null
  const id = name.slice(0, at)
  return mcpServerIdSchema.safeParse(id).success ? id : null
}
const ownDraft = mcpTransportSchema.options[1].shape.oauth.shape.ownClient
  .unwrap()
  .omit({ issuer: true })
  .nullable()
const draftHttp = mcpTransportSchema.options[1].extend({ oauth: z.object({ ownClient: ownDraft }) })
export const mcpDraftSchema = mcpServerSchema
  .omit({ enabled: true, consent: true, toolsPinned: true, tools: true })
  .extend({
    transport: z.discriminatedUnion('type', [mcpTransportSchema.options[0], draftHttp]),
    instructions: z.object({ enabled: z.boolean() }),
  })
export type McpDraft = z.infer<typeof mcpDraftSchema>
export const mcpWriteErrorCodeSchema = z.enum([
  'invalid-id',
  'duplicate-id',
  'blocked-env',
  'duplicate-env',
  'invalid-header',
  'invalid-address',
  'https-required',
  'secret-required',
  'secret-too-long',
  'consent-required',
  'interaction-required',
  'policy-asks',
  'stale',
  'not-found',
  'keychain',
])
export const mcpWriteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: mcpWriteErrorCodeSchema }),
])
const secretValueSchema = z.string().min(1).max(8192)
export const mcpSecretsSchema = z
  .object({
    env: z.record(envNameSchema, secretValueSchema),
    headers: z.record(headerNameSchema, secretValueSchema),
    ownClientSecret: secretValueSchema.optional(),
  })
  .strict()
export const mcpPhaseSchema = z.enum([
  'stopped',
  'connecting',
  'connected',
  'restarting',
  'error',
  'unauthorized',
])
export const mcpErrorCodeSchema = z.enum([
  'handshake-timeout',
  'handshake-failed',
  'crashed',
  'modern-only',
  'era-negotiation-failed',
  'command-not-found',
  'windows-unsupported',
  'spawn-failed',
  'missing-secret',
  'tools-limit',
  'network',
  'rate-limited',
  'keychain',
])
export const mcpLoginErrorSchema = z.enum([
  'metadata-unreachable',
  'pkce-unsupported',
  'issuer-mismatch',
  'iss-mismatch',
  'needs-client',
  'issuer-changed',
  'denied',
  'timeout',
  'port-in-use',
  'unsafe-url',
  'cancelled',
  'keychain',
  'network',
])
export const mcpLoginResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: mcpLoginErrorSchema }),
])
export const mcpWarningSchema = z.union([
  z.object({ kind: z.enum(['sudo', 'rm-rf']) }),
  z.object({ kind: z.enum(['home-path', 'ssh-path']), arg: z.string() }),
  z.object({ kind: z.literal('unpinned-package'), package: z.string() }),
  z.object({ kind: z.literal('risky-env'), name: envNameSchema }),
])
export type McpWarning = z.infer<typeof mcpWarningSchema>
export const mcpToolViewSchema = z.object({
  originalName: z.string(),
  mappedName: z.string(),
  setting: toolSettingSchema,
  definitionHash: definitionHashSchema,
  review: z.enum(['ok', 'changed', 'new']),
  requiresUserInteraction: z.boolean(),
  alwaysAllowOffered: z.boolean(),
  unavailable: z.enum(['name-collision', 'invalid-definition']).nullable(),
  description: z.string().max(1024),
})
export const mcpServerStatusSchema = z.object({
  serverId: mcpServerIdSchema,
  phase: mcpPhaseSchema,
  stopReason: z.enum(['needs-consent', 'crash-limit']).nullable(),
  error: z.object({ code: mcpErrorCodeSchema, stderrTail: z.string() }).nullable(),
  firstConnect: z.boolean(),
  restartInMs: z.number().nullable(),
  era: z.enum(['legacy', 'modern']).nullable(),
  protocolVersion: z.string().nullable(),
})
export const mcpServerViewSchema = mcpServerSchema.extend({
  status: mcpServerStatusSchema,
  toolViews: z.array(mcpToolViewSchema),
  instructionsView: z
    .object({ text: z.string(), hash: definitionHashSchema, review: z.enum(['ok', 'changed']) })
    .nullable(),
  needsConsent: z.boolean(),
  loggedIn: z.boolean().nullable(),
})
export type McpServerView = z.infer<typeof mcpServerViewSchema>
const id = z.object({ id: mcpServerIdSchema }).strict()
const target = z.union([
  z.object({ tool: z.string().min(1) }).strict(),
  z.object({ instructions: z.literal(true) }).strict(),
])
export const mcpList = defineRoute('mcp.list', {
  request: z.object({}).strict(),
  response: z.object({
    servers: z.array(mcpServerViewSchema),
    overLimit: z.array(
      z.object({ providerId: z.string(), omitted: z.number().int().nonnegative() }),
    ),
  }),
})
export const mcpPreview = defineRoute('mcp.preview', {
  request: z.object({ draft: mcpDraftSchema }).strict(),
  response: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      argv: z.array(z.string()),
      resolved: z.string().nullable(),
      warnings: z.array(mcpWarningSchema),
    }),
    z.object({ ok: z.literal(false), code: mcpWriteErrorCodeSchema }),
  ]),
})
export const mcpSave = defineRoute('mcp.save', {
  request: z
    .object({
      mode: z.enum(['create', 'update']),
      draft: mcpDraftSchema,
      secrets: mcpSecretsSchema,
      consent: z.enum(['run', 'persistent']).nullable(),
    })
    .strict(),
  response: mcpWriteResultSchema,
})
export const mcpDelete = defineRoute('mcp.delete', { request: id, response: mcpWriteResultSchema })
export const mcpSetEnabled = defineRoute('mcp.setEnabled', {
  request: id.extend({ enabled: z.boolean() }),
  response: mcpWriteResultSchema,
})
export const mcpReorder = defineRoute('mcp.reorder', {
  request: z.object({ ids: z.array(mcpServerIdSchema) }).strict(),
  response: mcpWriteResultSchema,
})
export const mcpSetToolSetting = defineRoute('mcp.setToolSetting', {
  request: id.extend({ tool: z.string().min(1), setting: toolSettingSchema }),
  response: mcpWriteResultSchema,
})
export const mcpRelease = defineRoute('mcp.release', {
  request: id.extend({ target, definitionHash: definitionHashSchema }),
  response: mcpWriteResultSchema,
})
export const mcpReviewChange = defineRoute('mcp.reviewChange', {
  request: id.extend({ target }),
  response: z.object({ before: z.string().nullable(), after: z.string() }),
})
export const mcpSetInstructions = defineRoute('mcp.setInstructions', {
  request: id.extend({ enabled: z.boolean() }),
  response: mcpWriteResultSchema,
})
export const mcpConnect = defineRoute('mcp.connect', {
  request: id.extend({ consent: z.enum(['run', 'persistent']) }),
  response: mcpWriteResultSchema,
})
export const mcpRestart = defineRoute('mcp.restart', {
  request: id,
  response: z.object({ restarted: z.boolean() }),
})
export const mcpRevoke = defineRoute('mcp.revoke', { request: id, response: mcpWriteResultSchema })
export const mcpRefreshTools = defineRoute('mcp.refreshTools', {
  request: id,
  response: z.object({ ok: z.boolean() }),
})
export const mcpLogin = defineRoute('mcp.login', { request: id, response: mcpLoginResultSchema })
export const mcpCancelLogin = defineRoute('mcp.cancelLogin', {
  request: id,
  response: z.object({ cancelled: z.boolean() }),
})
export const mcpReadLog = defineRoute('mcp.readLog', {
  request: id,
  response: z.object({ text: z.string(), truncated: z.boolean() }),
})
export const mcpChanged = defineEvent('mcp.changed', z.object({}).strict())
