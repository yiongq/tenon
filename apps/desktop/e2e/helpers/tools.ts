/**
 * What the tool, card and end-card specs share: a task session with a folder picked through main's
 * own dialog (stubbed, as spec 02 §停止与退出 lets e2e replace `dialog`), the scripted replies the
 * fake endpoint streams, and the kernel's answers read over the renderer's own bridge.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { ScriptedReply, ScriptedStep } from '../../test/support/fake-anthropic.js'
import { ORIGIN_MAP_ENV } from './app-env.js'
import { expect } from './test.js'

/** The official origins the fakes stand in for (M6 §点名 (a): the builtins take no other). */
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
export const ZHIPU_ORIGIN = 'https://open.bigmodel.cn'

/**
 * The origin map test seam's variable (M6 §点名「测试接缝」): each https origin in `to` sent to the
 * fake server standing in for it (its base URL; the map takes its origin). The app keeps the real
 * address — what it shows, binds a key to and judges — and only the transport reaches this machine.
 */
export function originMap(to: Readonly<Record<string, string>>): Record<string, string> {
  const pairs = Object.entries(to).map(([from, url]) => `${from}=${new URL(url).origin}`)
  return { [ORIGIN_MAP_ENV]: pairs.join(',') }
}

/**
 * anthropic at api.anthropic.com with a test key, sent to the fake at `baseURL`; `also` maps more
 * origins in the same variable (zhipu's fake, say).
 */
export function providerEnv(
  baseURL: string,
  also: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: 'e2e-test-key',
    ...originMap({ [ANTHROPIC_ORIGIN]: baseURL, ...also }),
  }
}

/**
 * A folder tree for one test, reached through a symbolic link: `real` is where the files are,
 * `link` a link to it, so every path under `link` is one whose real form differs (spec 02 §「在不在
 * 工作区里」: everything is compared, and shown, as real paths). `workspace` and `outside` sit side by
 * side under both. Removed by `dispose`.
 */
export interface FolderTree {
  readonly real: string
  readonly link: string
  dispose(): void
}

export function makeFolderTree(tag: string, files: Readonly<Record<string, string>>): FolderTree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `tenon-e2e-${tag}-`)))
  const real = join(base, 'real')
  const link = join(base, 'link')
  for (const [path, content] of Object.entries(files)) {
    const file = join(real, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  mkdirSync(real, { recursive: true })
  symlinkSync(real, link, 'dir')
  return {
    real,
    link,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** main's directory dialog answers `folders`, as if the user had picked them. */
export async function stubFolderDialog(
  app: ElectronApplication,
  folders: readonly string[],
): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [...picked],
    })) as unknown as typeof dialog.showOpenDialog
  }, folders)
}

/**
 * The session on screen becomes a task (ModeSwitch) whose one folder is `folder`, picked through the
 * FolderChip — main's dialog, stubbed. Before the first message, as the switch requires.
 */
export async function startTask(
  app: ElectronApplication,
  page: Page,
  folder: string,
): Promise<void> {
  await page.getByTestId('mode-cowork').click()
  await expect(page.getByTestId('mode-switch')).toHaveAttribute('data-profile', 'cowork')
  await expect(page.getByTestId('folder-chip')).toBeVisible()
  await stubFolderDialog(app, [folder])
  await page.getByTestId('folder-add').click()
  await expect(page.getByTestId('folder-item')).toHaveCount(1)
  await expect(page.getByTestId('folder-item')).toHaveAttribute('title', realpathSync(folder))
}

export async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').fill(text)
  await page.keyboard.press('Enter')
}

/** A `Read` call as the model asks for it. */
export function readCall(id: string, filePath: string, extra: Record<string, unknown> = {}) {
  return { type: 'tool_use', id, name: 'Read', input: { file_path: filePath, ...extra } } as const
}

/** A `Write` call as the model asks for it: the whole content of `filePath`. */
export function writeCall(id: string, filePath: string, content: string) {
  return { type: 'tool_use', id, name: 'Write', input: { file_path: filePath, content } } as const
}

/** An `Edit` call as the model asks for it. */
export function editCall(
  id: string,
  filePath: string,
  oldString: string,
  newString: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'tool_use',
    id,
    name: 'Edit',
    input: { file_path: filePath, old_string: oldString, new_string: newString, ...extra },
  } as const
}

/** A `Bash` call as the model asks for it; it runs in the workspace's first folder. */
export function bashCall(id: string, command: string, extra: Record<string, unknown> = {}) {
  return { type: 'tool_use', id, name: 'Bash', input: { command, ...extra } } as const
}

/** A reply of tool calls only (stop reason `tool_use`). */
export function callsReply(...calls: ScriptedStep[]): ScriptedReply {
  return { steps: calls, delayMs: 5 }
}

/** A reply of text only, one delta per chunk (stop reason `end_turn`). */
export function textReply(...chunks: string[]): ScriptedReply {
  return { steps: [{ type: 'text', text: chunks }], delayMs: 5 }
}

/** What `approval.current` answers for an approval (spec 02 §答复与投递, §调用的键与读写的数据). */
export interface CurrentApproval {
  readonly waitKind: 'approval'
  readonly callKey: string
  readonly anchorCallKey: string
  readonly allowScope: 'once' | 'session'
  readonly card: {
    readonly requestId: string
    readonly sessionId: string
    readonly reason: string
    readonly facts: Readonly<Record<string, string>>
    readonly target: { readonly type: string; readonly path?: string }
  }
}

/** The one session waiting on an approval (`approval.list`), and its card (`approval.current`). */
export async function waitingApproval(page: Page): Promise<CurrentApproval> {
  let found: CurrentApproval | null = null
  await expect
    .poll(async () => {
      found = await page.evaluate(async () => {
        const list = (await window.tenon.invoke('approval.list', { limit: 20 })) as {
          ok: boolean
          data: Array<{ sessionId: string; waitKind: string }>
        }
        const row = list.data.find((candidate) => candidate.waitKind === 'approval')
        if (row === undefined) return null
        const current = (await window.tenon.invoke('approval.current', {
          sessionId: row.sessionId,
        })) as { ok: boolean; data: unknown }
        return current.ok ? (current.data as CurrentApproval | null) : null
      })
      return found !== null
    })
    .toBe(true)
  if (found === null) throw new Error('no approval waits')
  return found
}

/**
 * Every push main sends a window from now on, captured in main by channel (`confirm.request`,
 * `chat.event`, `run.state`…): what the renderer was told, read without going through it.
 */
export async function recordPushes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const store = globalThis as unknown as {
      pushes?: Array<{ channel: string; payload: unknown }>
    }
    store.pushes = []
    for (const win of BrowserWindow.getAllWindows()) {
      const contents = win.webContents
      const original = contents.send.bind(contents)
      contents.send = (channel: string, ...args: unknown[]) => {
        store.pushes?.push({ channel, payload: args[0] })
        original(channel, ...args)
      }
    }
  })
}

/** The payloads `recordPushes` captured on `channel`, in the order main sent them. */
export async function pushesOf<T>(app: ElectronApplication, channel: string): Promise<T[]> {
  return (await app.evaluate(
    (_electron, wanted) =>
      (
        (globalThis as unknown as { pushes?: Array<{ channel: string; payload: unknown }> })
          .pushes ?? []
      )
        .filter((push) => push.channel === wanted)
        .map((push) => push.payload),
    channel,
  )) as T[]
}

/** Delivers `payload` on `confirm.request` again, as the kernel's redelivery does (§HostConfirm 可重复投递). */
export async function redeliver(app: ElectronApplication, payload: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, card) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('confirm.request', card)
  }, payload)
}
