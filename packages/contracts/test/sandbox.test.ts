import type { SandboxOutcome, ToolOutcomeView } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import {
  sandboxAllowedDomainsSchema,
  sandboxDomainSchema,
  sandboxSettingsSchema,
  sandboxGet,
  sandboxChanged,
  sandboxSetSettings,
  sandboxRelease,
} from '../src/ipc/sandbox.js'
import { configSetRequestSchema } from '../src/ipc/config.js'
import { toolOutcomeViewSchema } from '../src/ipc/outcome.js'
import type { ToolOutcomeViewContract } from '../src/ipc/outcome.js'

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false
type WireSandbox = NonNullable<ToolOutcomeViewContract['sandbox']>
type KernelSandbox = NonNullable<ToolOutcomeView['sandbox']>
type BothWays<A, B> = Extends<A, B> extends true ? Extends<B, A> : false
export type SandboxBothWays = Assert<BothWays<WireSandbox, KernelSandbox>>
export type SandboxKeysBothWays = Assert<BothWays<keyof WireSandbox, keyof SandboxOutcome>>
export type ViolationKeysBothWays = Assert<
  BothWays<keyof WireSandbox['violations'][number], keyof SandboxOutcome['violations'][number]>
>
export type KindBothWays = Assert<
  BothWays<WireSandbox['violations'][number]['kind'], SandboxOutcome['violations'][number]['kind']>
>
export type TargetBothWays = Assert<
  BothWays<
    WireSandbox['violations'][number]['target'],
    SandboxOutcome['violations'][number]['target']
  >
>
export type ReleaseBothWays = Assert<
  BothWays<
    WireSandbox['violations'][number]['release'],
    SandboxOutcome['violations'][number]['release']
  >
>
export type ProtectedBothWays = Assert<
  BothWays<
    WireSandbox['violations'][number]['protected'],
    SandboxOutcome['violations'][number]['protected']
  >
>
export type ObservedBothWays = Assert<
  BothWays<
    WireSandbox['violations'][number]['observed'],
    SandboxOutcome['violations'][number]['observed']
  >
>
// Each property independently: adding/removing a field or widening one side cannot hide in an object.
export type ViolationsBothWays = Assert<
  BothWays<WireSandbox['violations'], SandboxOutcome['violations']>
>
export type MoreBothWays = Assert<BothWays<WireSandbox['more'], SandboxOutcome['more']>>
export type AnyProtectedBothWays = Assert<
  BothWays<WireSandbox['anyProtected'], SandboxOutcome['anyProtected']>
>

const SESSION = '00000000-0000-4000-8000-000000000001'
const OUTCOME = {
  violations: [
    { kind: 'fs', target: '/work/a', release: 'path', protected: false, observed: false },
  ],
  more: 0,
  anyProtected: false,
} as const

describe('sandbox contracts', () => {
  it('04 验收 28: the allowlist schema refuses `*`, `*.com`, URLs, paths, unbracketed IPv6, port-less loopback, private and localhost entries and the 257th entry', () => {
    for (const entry of [
      '*',
      '*.com',
      'https://example.com',
      'example.com/a',
      '/work/a',
      '2001:db8::1',
      '2001:db8::1:443',
      '127.0.0.1',
      '127.2.3.4',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.1.2',
      'localhost',
      'a.localhost',
      '*.localhost',
      '[::1]',
      '[fc00::1]',
      '[fdff::1]',
      '[fe80::1]',
      '[febf::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:192.168.1.1]',
      'example.com:0',
      'example.com:0443',
      '127.0.0.1:00080',
      '[::1]:03000',
      'example.com:65536',
      'example.com:abc',
      '[invalid]:443',
    ])
      expect([entry, sandboxDomainSchema.safeParse(entry).success]).toEqual([entry, false])
    for (const entry of [
      'example.com',
      '*.example.com',
      'example.com:443',
      '8.8.8.8',
      'localhost:3000',
      'a.localhost:8080',
      '*.a.localhost:443',
      '127.0.0.1:3000',
      '10.0.0.1:80',
      '172.16.0.1:80',
      '192.168.0.1:80',
      '169.254.1.2:80',
      '[::1]:3000',
      '[fc00::1]:443',
      '[fe80::1]:80',
      '[2001:db8::1]',
      '[2001:db8::1]:443',
      '[::ffff:192.168.1.1]:80',
      '172.32.0.1',
      'example.com:65535',
    ])
      expect([entry, sandboxDomainSchema.safeParse(entry).success]).toEqual([entry, true])
    expect(
      sandboxAllowedDomainsSchema.safeParse(
        Array.from({ length: 256 }, (_, i) => `d${i}.example.com`),
      ).success,
    ).toBe(true)
    expect(
      sandboxAllowedDomainsSchema.safeParse(
        Array.from({ length: 257 }, (_, i) => `d${i}.example.com`),
      ).success,
    ).toBe(false)
    expect(sandboxAllowedDomainsSchema.parse(['EXAMPLE.COM', 'example.com'])).toEqual([
      'example.com',
    ])
  })

  it('carries exactly the sandbox outcome through the optional view member', () => {
    const view = {
      effect: 'external',
      state: 'completed',
      source: null,
      output: '',
      sandbox: OUTCOME,
    }
    expect(toolOutcomeViewSchema.parse(view)).toEqual(view)
    expect(toolOutcomeViewSchema.safeParse({ ...view, sandbox: undefined }).success).toBe(false)
    for (const key of ['kind', 'target', 'release', 'protected', 'observed']) {
      const violation = { ...OUTCOME.violations[0] } as Record<string, unknown>
      delete violation[key]
      expect(
        toolOutcomeViewSchema.safeParse({
          ...view,
          sandbox: { ...OUTCOME, violations: [violation] },
        }).success,
      ).toBe(false)
    }
  })

  it('declares the routes and event without adding settings to config.set', () => {
    expect(configSetRequestSchema.parse({ sandbox: { profile: 'read-only' } })).toEqual({})
    expect([
      sandboxGet.channel,
      sandboxSetSettings.channel,
      sandboxRelease.channel,
      sandboxChanged.channel,
    ]).toEqual(['sandbox.get', 'sandbox.setSettings', 'sandbox.release', 'sandbox.changed'])
    expect(
      sandboxSettingsSchema.parse({
        profile: 'read-only',
        allowedDomains: [],
        packageManagers: true,
      }),
    ).toEqual({ profile: 'read-only', allowedDomains: [], packageManagers: true })
    expect(sandboxSetSettings.request.parse({ profile: 'read-only' })).toEqual({
      profile: 'read-only',
    })
    expect(
      sandboxRelease.request.parse({
        sessionId: SESSION,
        callKey: 'call',
        action: 'allow-path',
        target: '/work/a',
      }),
    ).toEqual({ sessionId: SESSION, callKey: 'call', action: 'allow-path', target: '/work/a' })
  })
})
