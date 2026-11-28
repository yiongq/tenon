// The test's own entry script for the positive control of docs/features/error-logs acceptance 15:
// it starts the crash reporter, then loads the main process's bundle (TENON_E2E_MAIN_BUNDLE, an
// absolute path), so the app runs as it does, only with crash collection on. Nothing of this is in
// `apps/desktop/src/main`: the app itself never starts the reporter, and a test that wants to know
// whether a crash would leave a dump has to turn it on from outside.
//
// `uploadToServer: false` keeps the dump on this machine and sends nothing anywhere; the dump
// goes where Electron puts it by default, under the user data folder.
const { crashReporter } = require('electron')
const { pathToFileURL } = require('node:url')

crashReporter.start({ uploadToServer: false })
import(pathToFileURL(process.env.TENON_E2E_MAIN_BUNDLE).href).catch((error) => {
  process.stderr.write(`[crash-reporter-entry] the main bundle did not load: ${error}\n`)
  process.exit(1)
})
