import type { ProviderEndpoint } from '@tenon-app/contracts'

/**
 * The model menu's two data-flow decisions (spec 02 §模型选择「数据去向」; A9, 验收 34), pure so they
 * are tested without the menu.
 *
 * What a choice is compared with is where the session's history last went — `session.facts`'
 * `lastEndpoint`, the origin the kernel's own check compares with — never the choice in effect: a
 * session that never chose follows its profile's default, which a pick elsewhere can move to a
 * public host while every message so far went to this machine.
 */

/**
 * The host to confirm before this choice sends the history there, or null when there is nothing to
 * ask. `last` is where the history went (null: no Run has sent anything; undefined: it could not be
 * read, and then only a session with history on screen asks, as if it had stayed on this side).
 * `target` is where the chosen row's provider sends now.
 */
export function confirmHostFor(
  last: ProviderEndpoint | null | undefined,
  target: ProviderEndpoint | undefined,
  hasHistory: boolean,
): string | null {
  if (target === undefined || target.reach !== 'public') return null
  if (last === undefined) return hasHistory ? target.host : null
  return last !== null && last.reach !== 'public' ? target.host : null
}

/**
 * The host a held round's confirmation names: where the choice 「切换」 commits sends now. The
 * kernel's `held.host` is the one it held for, which a default moved since then no longer is — the
 * user would confirm one host and send to another (s19-safety-3).
 */
export function heldConfirmHost(heldHost: string, target: ProviderEndpoint | undefined): string {
  return target?.host ?? heldHost
}
