import { approvalCurrent, approvalList, approvalRespond, approvalResume } from './ipc/approval.js'
import {
  chatContinue,
  chatEvent,
  chatNew,
  chatQueueAct,
  chatQueueEvent,
  chatSend,
  chatSendNow,
  chatStop,
} from './ipc/chat.js'
import { configGet, configLocale, configSet } from './ipc/config.js'
import { confirmRequestEvent } from './ipc/confirm.js'
import { providerConfigure, providerList, providerSelect } from './ipc/provider.js'
import { runStateEvent } from './ipc/run.js'
import {
  sessionFacts,
  sessionLatest,
  sessionMessages,
  sessionModelChoice,
  sessionSelectModel,
  sessionSelectProfile,
  workspacePick,
  workspaceRemove,
  workspaceUsePrefill,
} from './ipc/session.js'

/**
 * Every channel that may cross the renderer ↔ main boundary. The preload only forwards
 * channels listed here; main only registers handlers for routes listed here.
 */
export const ipcRoutes = {
  approvalCurrent,
  approvalList,
  approvalRespond,
  approvalResume,
  chatContinue,
  chatQueueAct,
  chatSend,
  chatSendNow,
  chatStop,
  configGet,
  configSet,
  providerConfigure,
  providerList,
  providerSelect,
  sessionFacts,
  sessionLatest,
  sessionMessages,
  sessionModelChoice,
  sessionSelectModel,
  sessionSelectProfile,
  workspacePick,
  workspaceRemove,
  workspaceUsePrefill,
} as const
export const ipcEvents = {
  chatEvent,
  chatNew,
  chatQueueEvent,
  configLocale,
  confirmRequestEvent,
  runStateEvent,
} as const

export const ROUTE_CHANNELS: readonly string[] = Object.values(ipcRoutes).map((r) => r.channel)
export const EVENT_CHANNELS: readonly string[] = Object.values(ipcEvents).map((e) => e.channel)

export function isRouteChannel(channel: string): boolean {
  return ROUTE_CHANNELS.includes(channel)
}

export function isEventChannel(channel: string): boolean {
  return EVENT_CHANNELS.includes(channel)
}
