/**
 * @tenon-app/kernel/testing — fixtures shared by kernel, contracts and app tests.
 *
 * It lives under src/, so the kernel lint gate applies here too: no timers, no Node
 * built-ins, no DOM globals. Nothing in here may be imported by shipped kernel code —
 * the no-restricted-imports pattern on testing paths in .oxlintrc.json enforces it.
 */
export { createCounterIds } from './fake-ids.js'
export type { CounterIds, CounterIdsOptions } from './fake-ids.js'
export { createStreamGate, fakeNetwork } from './fake-network.js'
export type {
  ConnectionFailureExchange,
  DeniedExchange,
  FakeExchange,
  FakeNetwork,
  JsonExchange,
  RecordedRequest,
  SseExchange,
  StreamGate,
  TextExchange,
} from './fake-network.js'

// The shared TapeStore conformance suite: framework-free cases a vitest file maps onto it().
export { TapeConformanceFailure, tapeConformanceCases } from './tape-conformance.js'
export type {
  TapeConformanceCase,
  TapeStoreFactory,
  TapeStoreFactoryOptions,
} from './tape-conformance.js'

// A scripted provider: the real Anthropic wire encode() with a stream a case writes down. What the
// session service's tape properties are checked with, here and in the conformance suite.
export { createScriptedProvider, scriptedTurn, stopEvent } from './scripted-provider.js'
export type {
  ScriptedProvider,
  ScriptedProviderOptions,
  ScriptedTurnOptions,
} from './scripted-provider.js'
