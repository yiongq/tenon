export type {
  AbsolutePath,
  ChildHandle,
  ConfirmReason,
  ConfirmRequest,
  FetchLike,
  HostAdapter,
  HostClock,
  HostConfirm,
  HostFs,
  HostIdentity,
  HostNetwork,
  HostProcess,
  HostSandbox,
  HostSecrets,
  SandboxRequest,
  SandboxViolation,
  SpawnSpec,
} from './host/adapter.js'
export { CONFIRM_FACT_KEYS, HostNetworkDeniedError } from './host/adapter.js'
export { absolutePath, isAbsolutePath, joinPath } from './host/path.js'
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
  sha256Hex,
} from './tape/hash.js'
export type { HashEntryFields } from './tape/hash.js'
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
  ToolSpec,
  Usage,
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
export { applyThinkingDecision, decideThinking, thinkingModelId } from './provider/thinking.js'
export type { ThinkingApplication, ThinkingBlock, ThinkingTarget } from './provider/thinking.js'
export { createProviderRegistry } from './provider/registry.js'
