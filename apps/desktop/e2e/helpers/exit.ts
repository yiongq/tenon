/**
 * Main's native confirm on close and quit (spec 02 §停止与退出, §e2e 接缝): replaced through
 * `electronApp.evaluate`, as the seam says — main calls `dialog.showMessageBox(...)` on the dialog
 * object, so the replacement is what it calls. Every confirm main shows is written, one JSON line
 * each, to a file of this launch's: a quit test reads it once the app is gone.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@playwright/test'

/** The buttons' order, src/main/shutdown.ts's EXIT_CONFIRM_STOP and EXIT_CONFIRM_CANCEL. */
const RESPONSE = { stop: 0, cancel: 1 } as const

/** One confirm main showed: its text and its buttons, as the catalogue gave them. */
export interface ExitConfirm {
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
}

/**
 * From now on main's confirm answers `answer` at once, and records itself in `record` (the file of
 * the launch; kept from the first call when a later one leaves it out). A case with a Run in
 * progress presets `stop` again before its teardown, or the quit would wait on the confirm.
 */
export async function stubExitConfirm(
  app: ElectronApplication,
  answer: keyof typeof RESPONSE,
  record?: string,
): Promise<void> {
  await app.evaluate(
    ({ dialog }, stub) => {
      const store = globalThis as { tenonExitRecord?: string }
      if (stub.record !== undefined) store.tenonExitRecord = stub.record
      const file = store.tenonExitRecord
      const fs = process.getBuiltinModule('node:fs')
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = (args.length > 1 ? args[1] : args[0]) as {
          message: string
          detail: string
          buttons: string[]
        }
        const line = { message: options.message, detail: options.detail, buttons: options.buttons }
        if (file !== undefined) fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
        return { response: stub.response, checkboxChecked: false }
      }) as unknown as typeof dialog.showMessageBox
    },
    { response: RESPONSE[answer], record },
  )
}

/** The confirms recorded in `record` so far, in the order main showed them. */
export function exitConfirmsIn(record: string): ExitConfirm[] {
  if (!existsSync(record)) return []
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ExitConfirm)
}
