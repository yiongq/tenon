/**
 * @tenon-app/kernel/testing — fixtures shared by kernel, contracts and app tests.
 *
 * It lives under src/, so the kernel lint gate applies here too: no timers, no Node
 * built-ins, no DOM globals. Nothing in here may be imported by shipped kernel code —
 * the no-restricted-imports pattern on testing paths in .oxlintrc.json enforces it.
 *
 * NAMING CONVENTION for spec 02's invariant tests: a test that proves one of spec 02 §不变量 puts
 * 「02 不变量 N」 in its name — `it('02 不变量 23: every call has one result before the next user
 * text', …)` — spelled out in full for each number it proves (`02 不变量 3, 02 不变量 10`, never
 * `02 不变量 3、10`), so the acceptance audit (plan step 35) finds every invariant's tests with
 * `grep -rnE '02 不变量 N([^0-9]|$)'`. The unit tests of the helpers below do NOT carry the tag:
 * they prove a helper, not the kernel.
 */
export { createCounterIds } from './fake-ids.js'
export type { CounterIds, CounterIdsOptions } from './fake-ids.js'
export { createStreamGate, fakeNetwork } from './fake-network.js'
export type {
  ConnectionFailureExchange,
  DeniedExchange,
  FakeExchange,
  FakeNetwork,
  FakeNetworkOptions,
  JsonExchange,
  RecordedRequest,
  SseExchange,
  StreamGate,
  TextExchange,
} from './fake-network.js'

// Request-body assertions over a RecordedRequest, meant for FakeNetworkOptions.checkRequest.
export {
  RequestAssertionError,
  assertHeaderNamesAllowed,
  assertImagesInline,
  assertLastTurnIsUser,
  assertToolPairing,
  requestWire,
} from './request-assertions.js'
export type { AllowedHeaderNames, RequestWire } from './request-assertions.js'

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
