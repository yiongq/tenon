import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'
import { canonicalSessionIdSchema } from './session.js'

export const sandboxProfileSchema = z.enum(['read-only', 'workspace-write'])
export const sandboxReasonCodeSchema = z.enum([
  'windows',
  'unsupported-platform',
  'wsl1',
  'root-without-setfcap',
  'missing-bwrap',
  'missing-socat',
  'missing-rg',
  'userns-restricted',
  'nested-sandbox',
  'self-test-failed',
  'init-failed',
  'other',
  'no-seccomp',
  'old-bwrap',
  'test-seam',
])
export type SandboxReasonCode = z.infer<typeof sandboxReasonCodeSchema>

function localIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  )
}

function localIpv6(host: string): boolean {
  // URL canonicalizes compressed and IPv4-mapped spellings after IPv6 validation.
  const canonical = new URL(`http://[${host}]`).hostname.slice(1, -1)
  if (canonical === '::' || canonical === '::1') return true
  if (/^f[cd]/.test(canonical) || /^fe[89ab]/.test(canonical)) return true
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical)
  if (mapped === null) return false
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return localIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
}

function validDomainEntry(value: string): boolean {
  const parts = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(value)
  if (parts === null) return false
  const host = parts[1]!
  const port = parts[2]
  if (port !== undefined && (port.startsWith('0') || Number(port) > 65535)) return false
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    return z.ipv6().safeParse(address).success && (port !== undefined || !localIpv6(address))
  }
  if (z.ipv4().safeParse(host).success) return port !== undefined || !localIpv4(host)
  const domain = host.startsWith('*.') ? host.slice(2) : host
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(domain)) return false
  if (host.startsWith('*.') && domain.split('.').length < 2) return false
  if (domain === 'localhost' || domain.endsWith('.localhost')) return port !== undefined
  return domain.includes('.')
}

/** Spec 04 acceptance 28: the wire accepts only bounded, explicit host patterns. */
export const sandboxDomainSchema = z.string().toLowerCase().refine(validDomainEntry)
export const sandboxAllowedDomainsSchema = z
  .array(sandboxDomainSchema)
  .max(256)
  .transform((entries) => [...new Set(entries)])
export const sandboxSettingsSchema = z.object({
  profile: sandboxProfileSchema,
  allowedDomains: sandboxAllowedDomainsSchema,
  packageManagers: z.boolean(),
})
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>

export const sandboxViewSchema = z.object({
  posture: z.object({
    state: z.enum(['pending', 'active', 'degraded', 'unavailable']),
    profile: sandboxProfileSchema,
  }),
  platform: z.enum(['darwin', 'linux', 'win32', 'other']),
  reasons: z.array(z.object({ code: sandboxReasonCodeSchema, detail: z.string().nullable() })),
  settings: sandboxSettingsSchema,
  preset: z.object({ domains: z.array(z.string()), writable: z.array(z.string()) }),
})
export type SandboxView = z.infer<typeof sandboxViewSchema>
export const sandboxGet = defineRoute('sandbox.get', {
  request: z.object({}).strict(),
  response: sandboxViewSchema,
})
export const sandboxChanged = defineEvent('sandbox.changed', sandboxViewSchema)
export const sandboxSetSettings = defineRoute('sandbox.setSettings', {
  // The handler validates entries so invalid input can return its index (04 §IPC), rather
  // than being collapsed into the IPC envelope's generic invalid-request error.
  request: z
    .object({
      profile: sandboxProfileSchema.optional(),
      allowedDomains: z.array(z.string()).optional(),
      packageManagers: z.boolean().optional(),
    })
    .strict(),
  response: z.union([
    z.object({ ok: z.literal(true) }),
    z.object({
      ok: z.literal(false),
      code: z.literal('invalid-domain'),
      index: z.number().int().nonnegative(),
    }),
    z.object({ ok: z.literal(false), code: z.enum(['too-many', 'write-failed']) }),
  ]),
})
export const sandboxRelease = defineRoute('sandbox.release', {
  request: z
    .object({
      sessionId: canonicalSessionIdSchema,
      callKey: z.string().min(1),
      action: z.enum(['allow-domain', 'allow-path', 'rerun-unsandboxed']),
      target: z.string().nullable(),
    })
    .strict(),
  response: z.object({
    status: z.enum(['released', 'already-released', 'stale', 'not-found', 'refused']),
  }),
})
