export type {
  AbsolutePath,
  ChildHandle,
  ConfirmReason,
  ConfirmRequest,
  ConfirmTarget,
  FetchLike,
  HostAdapter,
  HostClock,
  HostConfirm,
  HostFs,
  HostIdentity,
  HostNetwork,
  HostPolicy,
  HostProcess,
  HostSandbox,
  HostSecrets,
  Reversibility,
  SandboxRequest,
  SandboxViolation,
  SpawnSpec,
} from './host/adapter.js'
export { CONFIRM_FACT_KEYS, HostNetworkDeniedError } from './host/adapter.js'
export { EMPTY_POLICY } from './host/policy.js'
export type { PolicyState, TenantPolicy, ToolPolicyRule } from './host/policy.js'
export type { FlaggedCategory, InspectorCategory } from './permission/inspector.js'
export { absolutePath, isAbsolutePath, isWithin, joinPath, normalizePath } from './host/path.js'
export { KEY_SEPARATOR, keyFor } from './host/key.js'
export {
  PROFILE_CONFIG_FILE,
  PROFILE_SUBDIRS,
  assertProfileId,
  profileDirFor,
} from './host/profile.js'
export { createMemoryHost } from './host/memory.js'
export type { MemoryHost, MemoryHostOptions } from './host/memory.js'
export { isCanonicalUuid } from './ids.js'
export type { IdSource } from './ids.js'
export { ChildStdioTransport } from './mcp/stdio-transport.js'
export type { ChildStdioTransportOptions } from './mcp/stdio-transport.js'
export { connectStdioServer } from './mcp/connection.js'
export type {
  McpCallToolResult,
  McpConnection,
  McpStdioServerSpec,
  McpToolList,
} from './mcp/connection.js'

// Tape — the pure core: entry model, canonical JSON, hash chain, provenance keys, name table.
export type {
  AppendResult,
  AssistantMessagePayload,
  AttemptCompletedPayload,
  AttemptRequestSnapshot,
  ForkOrigin,
  MessagePayload,
  MessageRetractedPayload,
  MessageStatus,
  ModelSelectedPayload,
  NewEntry,
  SessionStartPayload,
  SideEffectClass,
  SnapshotCoordinate,
  TapeEntry,
  TapeKind,
  TapeSourceType,
  UserMessagePayload,
} from './tape/entry.js'
export { TAPE_KINDS, TAPE_SOURCE_TYPES, TapeIntegerRangeError } from './tape/entry.js'
export {
  CANONICAL_JSON_MAX_DEPTH,
  CanonicalJsonError,
  canonicalJson,
} from './tape/canonical-json.js'
export {
  HASH_BYTE_LENGTH,
  HASH_VER,
  KNOWN_HASH_VERS,
  TapeHashRecipeError,
  bytesEqual,
  bytesToHex,
  contentHash,
  hashEntry,
  hexToBytes,
  isKnownHashVer,
  isStoredEntryProvable,
  sha256Hex,
} from './tape/hash.js'
export type { HashEntryFields, StoredEntryFields } from './tape/hash.js'
export {
  DECLARED_TAPE_NAMES,
  EXT_NAMESPACE,
  RESERVED_NAMESPACES,
  TAPE_NAME_MAX_LENGTH,
  TapeAppendAuthorizationError,
  TapeNameSyntaxError,
  assertAppendAuthorized,
  assertTapeName,
  createEntryWriter,
  declaredTapeName,
  isReservedNamespace,
} from './tape/names.js'
export type {
  AppendAuthorizationInput,
  DeclaredSourceSeq,
  DeclaredTapeName,
  DeclaredTapeNameId,
  SliceEntryFields,
  TapeEntryWriter,
  TapeSlice,
} from './tape/names.js'
export {
  PROVENANCE_KEY_MAX_LENGTH,
  TapeProvenanceSyntaxError,
  assertProvenanceKey,
  attemptCompletedKey,
  isValidProvenanceKey,
  messageRetractedKey,
  messageRevisionKey,
  modelSelectedKey,
  parseProvenanceKey,
  sessionStartKey,
} from './tape/provenance.js'
export type { ParsedProvenanceKey } from './tape/provenance.js'
export type {
  CompleteResult,
  ConfigKey,
  ContentBlock,
  EncodedRequest,
  InternalMessage,
  ModelInfo,
  Provider,
  ProviderDefinition,
  ProviderErrorCode,
  ProviderId,
  ProviderRegistry,
  ProviderRequest,
  RequestIdentity,
  SendContext,
  StopReason,
  StreamEvent,
  ThinkingDecision,
  ThinkingSpec,
  ToolSpec,
  Usage,
  VendorSource,
} from './provider/types.js'
export {
  ProviderAlreadyRegisteredError,
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  isRetryableByDefault,
  retryAfterMs,
} from './provider/errors.js'
export type { HeaderLookup } from './provider/errors.js'
export { BaseProvider, createBlockAccumulator, withTerminalEvent } from './provider/base.js'
export type {
  BlockAccumulator,
  BlockAccumulatorOptions,
  TerminalStreamOptions,
} from './provider/base.js'
export {
  applyThinkingDecision,
  decideThinking,
  decideVendorBlock,
  decideVendorFields,
  thinkingModelId,
} from './provider/thinking.js'
export type {
  ThinkingApplication,
  ThinkingBlock,
  ThinkingTarget,
  VendorBlock,
} from './provider/thinking.js'
export { createProviderRegistry } from './provider/registry.js'

// Tape — the storage port, the in-memory store, the projection reducer, folding, replay, the facade.
export {
  MAX_READ_LIMIT,
  TapeBusyError,
  TapeProvenanceConflictError,
  TapeReadLimitError,
  TapeSessionNotFoundError,
  TapeStaleIncarnationError,
  TapeTenantMismatchError,
  assertReadKinds,
  assertReadLimit,
} from './tape/store.js'
export type {
  MessageRow,
  SessionHead,
  SessionSummary,
  TapeAppendBatch,
  TapeListMessagesQuery,
  TapeListSessionsQuery,
  TapeReadBySourceQuery,
  TapeReadRangePage,
  TapeReadRangeQuery,
  TapeReader,
  TapeResetSessionQuery,
  TapeStore,
  TapeVerifyChainPage,
  TapeVerifyChainQuery,
} from './tape/store.js'
export {
  PROJECTION_TABLES,
  PROJECTION_VERSION,
  TapeProjectionError,
  parseMessagePayload,
  parseRetractedMessageId,
  project,
} from './tape/projection.js'
export type {
  MessageProjectionInsertOnly,
  MessageProjectionKey,
  MessageProjectionValues,
  ProjectionOp,
  ProjectionReducer,
  ProjectionTable,
  SessionProjectionInsertOnly,
  SessionProjectionKey,
  SessionProjectionValues,
  TapeAssistantMessagePayload,
  TapeAttemptCompletedPayload,
  TapeAttemptError,
  TapeAttemptStop,
  TapeMessagePayload,
  TapePayloadByName,
  TapeUserMessagePayload,
} from './tape/projection.js'
export { REPLAY_KINDS, effectiveMessages, rebuildProviderContext } from './tape/replay.js'
export type { EffectiveMessage, RebuildProviderContextQuery } from './tape/replay.js'
export { createMemoryTapeStore } from './tape/memory-store.js'
export type { MemoryTapeStoreOptions } from './tape/memory-store.js'
export { createTape } from './tape/tape.js'
export type {
  Tape,
  TapeAppendEntriesBatch,
  TapeFact,
  TapeWriteBatch,
  TapeWriter,
} from './tape/tape.js'

// The port's own rules, as functions every store implementation calls instead of re-deriving them:
// the append gate, the batch gate, the idempotency comparison and the incarnation check (§存储端口).
export {
  assertBatchAllowed,
  assertCurrentIncarnation,
  assertEntryAllowed,
  assertTapeId,
  idempotentAppendResult,
} from './tape/store.js'
export type { StoredEntryIdentity } from './tape/store.js'
// The two wire protocols' pure encode() halves, plus the request-snapshot helpers the session
// service shares with them (step 9; the adapter classes of steps 10 and 11 delegate here).
export { encodeAnthropicMessages } from './provider/wire/anthropic-messages.js'
export type {
  AnthropicContentBlock,
  AnthropicRawBlock,
  AnthropicResultBlock,
  AnthropicToolDefinition,
  AnthropicWireMessage,
} from './provider/wire/anthropic-messages.js'
export { encodeOpenAIChat } from './provider/wire/openai-chat.js'
export type {
  OpenAIAssistantMessage,
  OpenAIContent,
  OpenAIContentPart,
  OpenAIToolCall,
  OpenAIToolDefinition,
  OpenAIWireMessage,
} from './provider/wire/openai-chat.js'
export {
  NO_SYSTEM_PROMPT_HASH,
  WIRE_MODEL_FIELDS,
  effectiveMaxTokens,
  encoderOf,
  modelWireHash,
  requestSnapshot,
  systemHash,
} from './provider/wire/shared.js'
export type { EncoderInfo } from './provider/wire/shared.js'

// The Anthropic Messages adapter's I/O half (step 10): the SDK client, the raw-event
// normalisation and the error mapping. The provider definition that constructs it is step 11's.
export { AnthropicMessagesProvider } from './provider/wire/anthropic-messages.js'
export type { AnthropicMessagesProviderOptions } from './provider/wire/anthropic-messages.js'

// The OpenAI-compatible adapter's I/O half plus the three builtin provider definitions (step 11).
// A definition is data and a `create()`: registering one is all it takes to add a provider
// (acceptance 1), which is why nothing below this line is a switch over provider ids.
export { OpenAIChatProvider } from './provider/wire/openai-chat.js'
export type { OpenAIChatProviderOptions } from './provider/wire/openai-chat.js'
export {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_PROVIDER_ID,
  anthropicDefinition,
} from './provider/definitions/anthropic.js'
export {
  ZHIPU_DEFAULT_BASE_URL,
  ZHIPU_PROVIDER_ID,
  zhipuDefinition,
} from './provider/definitions/zhipu.js'
export {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_PROVIDER_ID,
  ollamaDefinition,
} from './provider/definitions/ollama.js'
export { BUILTIN_PROVIDERS, registerBuiltinProviders } from './provider/definitions/builtin.js'

// The kernel session service: creates / resets / deletes sessions, reads the projections back, and
// owns the agent loop (spec 02 §主进程与 kernel 的循环接口). It takes the store as an INSTANCE and
// wraps it in the Tape facade itself, so no caller above it holds `TapeStore.append`. Spec 02 removed
// phase 1's `runRequest`, `RunRequestQuery` and `RunResult`: a request is what a Run sends.
export { createSessionService } from './session/service.js'
export type {
  AnswerResult,
  ContinueRunResult,
  CreateSessionQuery,
  LatestSession,
  ListMessagesQuery,
  RecoverResult,
  ResumeResult,
  SendQuery,
  SendResult,
  SessionIncarnation,
  SessionMessageRow,
  SessionService,
  SessionServiceOptions,
} from './session/service.js'
export type { RowCall } from './loop/calls.js'
// The fold read out of a store, ids and ordinals kept: what a caller that needs a message's id and
// revision reads, and what `rebuildProviderContext` is the provider-facing projection of.
export { readEffectiveMessages } from './tape/replay.js'
export type { ReadEffectiveMessagesQuery } from './tape/replay.js'
// One more port rule every store owes (it belongs beside `assertBatchAllowed` above; it is here so
// the two tracks writing this file can be merged): only a batch that opens with `session/start` may
// create a session's head row.
export { assertBatchOpensIncarnation } from './tape/store.js'

// Spec 02 plan step 8 — Tape 修补与新名字. One block at the end, so the tracks writing this file in
// parallel can be merged: the phase-2 payload types and the types they reference (declared only; the
// steps that implement them do not change the shapes), the new port errors and queries, the
// pending-approval projection, the memory store's shared backing and the phase-2 key builders.
export type { BlockReason, ClosureSource, ExecutionState } from './loop/closure.js'
export type { SpillRecord } from './loop/spill.js'
export type { HandoffCall, SubagentHandoff } from './loop/subagent.js'
export type { RunEndReason } from './loop/terminal.js'
export type { Decision } from './permission/decide.js'
export type { InspectorFinding } from './permission/inspector.js'
export type {
  DecisionRecord,
  DecisionSource,
  DecisionStep,
  DecisionSummary,
  DecisionSummaryCode,
} from './permission/record.js'
export type {
  ApprovalResolvedPayload,
  CompactionAnchorPayload,
  AskAnswerRecord,
  ContinuationPayload,
  EnvironmentPayload,
  DispatchCommittedPayload,
  FactWriter,
  GrantScope,
  ModelChoiceSetPayload,
  ParentLinkPayload,
  PermissionDecidedPayload,
  ProfileSetPayload,
  RunStartedPayload,
  RunTerminalPayload,
  RunUsageLine,
  SessionProfile,
  ToolCallPayload,
  ToolExclusionCode,
  ToolOrigin,
  ToolOutcomePayload,
  ToolResultPayload,
  ToolTablePayload,
  ToolsWithheldPayload,
  ViewAssembledPayload,
  ViewContentPayload,
  WorkspaceSetPayload,
} from './tape/entry.js'
export { TapeClosedError, TapeMessageRetractedError, assertEntryIdCursor } from './tape/store.js'
export type { PendingApprovalRow, TapeListPendingApprovalsQuery } from './tape/store.js'
export type {
  PendingApprovalProjectionInsertOnly,
  PendingApprovalProjectionKey,
  PendingApprovalProjectionValues,
} from './tape/projection.js'
export { createMemoryTapeBacking } from './tape/memory-store.js'
export type { MemoryTapeBacking } from './tape/memory-store.js'
export {
  approvalResolvedKey,
  assembledKey,
  compactionAnchorKey,
  dispatchCommittedKey,
  modelChoiceSetKey,
  parentLinkKey,
  permissionDecidedKey,
  profileSetKey,
  runStartedKey,
  runTerminalKey,
  toolCallKey,
  toolOutcomeKey,
  toolResultKey,
  toolTableKey,
  toolsWithheldKey,
  viewContentKey,
  workspaceSetKey,
} from './tape/provenance.js'

// Spec 02 plan step 9 — 所有权骨架. The loop's ports and events, the commands' types, and the types
// they reference, declared exactly as §主进程与 kernel 的循环接口 writes them (M1: frozen from here;
// a host-implemented port only gains optional members after ①).
export type {
  CapabilitySource,
  LoopPorts,
  McpToolSource,
  ModelChoice,
  QueuedMessage,
  RunAbortCause,
  RunAssembly,
  RunConnector,
  RunLease,
  RunOrigin,
} from './loop/ports.js'
export type { SessionEvent, ToolOutcomeView } from './loop/events.js'
export type { AnswerCommand } from './loop/waiting.js'
export type { PendingCard, PendingRoot } from './loop/answer.js'
// Plan step 18: the home page's choices and the workspace, as the session service answers them.
export type {
  SelectModelQuery,
  SelectProfileQuery,
  SelectProfileResult,
  SessionFactsView,
  WorkspaceChange,
  WorkspaceResult,
} from './loop/mailbox.js'
export { INSPECTOR_TIMEOUT_MS } from './permission/inspector.js'
export type { AskOpinion, DenyOpinion, InspectorRegistration } from './permission/inspector.js'
export type {
  AfterResultInput,
  BeforeCallInput,
  InspectedCall,
  ResultMarker,
  SessionView,
} from './permission/session-view.js'
export { BUILTIN_SERVER_ID } from './tools/registry.js'
export type { ToolTableItem } from './tools/registry.js'
export type {
  SearchBackend,
  SearchBackendDefinition,
  SearchHit,
  SearchOutcome,
} from './tools/search/types.js'
export type { CommandShell } from './tools/builtin/bash.js'

// Spec 02 plan step 11 — 工作区判定与决策表. Where a path falls, resolved the one way both the kernel
// and the desktop (which resolves the protected shell files) use.
export { locatePath, placeOf, resolvePath } from './permission/workspace.js'
export type { PathPlace, PathScope, PathVerdict, ResolvedPath } from './permission/workspace.js'
