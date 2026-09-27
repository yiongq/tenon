import type { HostPolicy, PolicyState } from '@tenon-app/kernel'
import { EMPTY_POLICY } from '@tenon-app/kernel'

const PERSONAL_TENANT: PolicyState = { status: 'current', version: 'empty', snapshot: EMPTY_POLICY }

/**
 * The desktop is a personal tenant in phase 2 (spec 02 §`HostAdapter.policy`, D4): the policy is
 * always empty and never changes, so no listener is ever called. Fetching, caching and offline
 * fallback arrive with 6b, and reading an MDM-managed policy file only swaps this implementation.
 */
export class EmptyPolicy implements HostPolicy {
  current(): PolicyState {
    return PERSONAL_TENANT
  }

  subscribe(_listener: (state: PolicyState) => void): () => void {
    return () => {}
  }
}
