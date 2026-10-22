import { invokeRoute, sandboxChanged, sandboxGet, sandboxSetSettings } from '@tenon-app/contracts'
import type { IpcInvokerLike, RouteRequest, SandboxView } from '@tenon-app/contracts'

export type SandboxSettingsError =
  | { code: 'invalid-domain'; index: number }
  | { code: 'too-many' | 'write-failed' | 'load-failed' }

export function showsSandboxStatus(view: SandboxView): boolean {
  return (
    view.posture.state === 'degraded' ||
    view.posture.state === 'unavailable' ||
    view.reasons.some(({ code }) => code === 'test-seam')
  )
}

/** Only the contracts bridge is used; raw host diagnostics never become executable actions. */
export function observeSandbox(
  bridge: IpcInvokerLike & {
    on(channel: string, listener: (payload: unknown) => void): () => void
  },
  publish: (view: SandboxView) => void,
  failed: () => void,
) {
  let disposed = false
  let revision = 0
  const detach = bridge.on(sandboxChanged.channel, (payload) => {
    const next = sandboxChanged.payload.safeParse(payload)
    if (!disposed && next.success) {
      revision++
      publish(next.data)
    }
  })
  const refresh = async () => {
    const at = ++revision
    try {
      const result = await invokeRoute(bridge, sandboxGet, {})
      if (disposed || at !== revision) return
      if (result.ok) publish(result.data)
      else failed()
    } catch {
      if (!disposed && at === revision) failed()
    }
  }
  return {
    refresh,
    dispose: () => {
      disposed = true
      detach()
    },
  }
}

export async function writeSandboxSettings(
  bridge: IpcInvokerLike,
  patch: RouteRequest<typeof sandboxSetSettings>,
): Promise<SandboxSettingsError | null> {
  try {
    const result = await invokeRoute(bridge, sandboxSetSettings, patch)
    if (!result.ok) return { code: 'write-failed' }
    return result.data.ok ? null : result.data
  } catch {
    return { code: 'write-failed' }
  }
}

/** Entries have already passed the contract schema. This warning is about proxy reach only. */
export function needsProxyWarning(entry: string): boolean {
  let host: string
  try {
    host = new URL(`http://${entry.replace(/^\*\./, '')}`).hostname
  } catch {
    // A stored name URL cannot read must not take the whole pane down; it gets no warning.
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address)
    if (mapped) {
      const high = parseInt(mapped[1]!, 16),
        low = parseInt(mapped[2]!, 16)
      return needsProxyWarning(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}:1`)
    }
    return address === '::' || address === '::1' || /^f[cd]|^fe[89ab]/.test(address)
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false
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

/** Display-only AppArmor instructions; the absolute bwrap path comes from the host's diagnosis. */
export function usernsFixCommands(detail: string | null): string | null {
  const path = /^bwrap=(\/[^\r\n]+)$/m.exec(detail ?? '')?.[1]
  if (!path || !/^\/[\w./-]+$/.test(path)) return null
  return `sudo tee /etc/apparmor.d/bwrap <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap ${path} flags=(unconfined) {\n  userns,\n}\nEOF\nsudo systemctl reload apparmor`
}
