export {
  defineEvent,
  defineRoute,
  invokeRoute,
  ipcErrorSchema,
  ipcResultSchema,
  registerRoute,
} from './route.js'
export type {
  EventDef,
  EventPayload,
  IpcError,
  IpcInvokerLike,
  IpcMainLike,
  IpcResult,
  RouteDef,
  RouteHandler,
  RouteRequest,
  RouteResponse,
} from './route.js'
export {
  chatEvent,
  chatEventSchema,
  chatNew,
  chatSend,
  chatStop,
  sessionIdSchema,
} from './ipc/chat.js'
export type { ChatEvent } from './ipc/chat.js'
export {
  configGet,
  configLocale,
  configPatchSchema,
  configSchema,
  configSet,
  localeSchema,
  localeSettingSchema,
} from './ipc/config.js'
export type { Config, ConfigPatch, Locale, LocaleSetting } from './ipc/config.js'
export {
  confirmKindSchema,
  confirmReasonSchema,
  confirmRequestEvent,
  confirmRequestEventPayloadSchema,
  confirmRequestSchema,
  requiredFactKeys,
} from './ipc/confirm.js'
export type { ConfirmRequestInput } from './ipc/confirm.js'
export {
  PROTOCOL_FRAME_TYPES,
  checkTenantAssertion,
  classifyFrameType,
  decodeFrame,
  derivedTenantIdFromCredential,
  frameEmptyBodySchema,
  frameEnvelopeSchema,
  frameErrorBodySchema,
  frameErrorCodeSchema,
  frameHelloBodySchema,
  frameWelcomeBodySchema,
  isProtocolFrameType,
  negotiateVersion,
} from './bridge/frame.js'
export type {
  DerivedTenantId,
  FrameCheck,
  FrameDecodeResult,
  FrameEnvelope,
  FrameErrorBody,
  FrameErrorCode,
  FrameHeader,
  FrameHelloBody,
  FrameNegotiationResult,
  FrameTypeKind,
  FrameWelcomeBody,
  ProtocolFrame,
  ProtocolFrameType,
  ProtocolSupport,
} from './bridge/frame.js'
export {
  EVENT_CHANNELS,
  ROUTE_CHANNELS,
  ipcEvents,
  ipcRoutes,
  isEventChannel,
  isRouteChannel,
} from './registry.js'

// Reading the stored conversation (spec 01 step 13): the two session routes and the message
// shapes they carry. Writing stays on `chat.send`.
export {
  SESSION_READ_LIMIT_MAX,
  contentBlockSchema,
  messageRowSchema,
  sessionLatest,
  sessionMessages,
} from './ipc/session.js'
export type { ContentBlockContract, MessageRowContract } from './ipc/session.js'
