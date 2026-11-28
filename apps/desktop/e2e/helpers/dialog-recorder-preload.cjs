// Loaded into the main process of the development build through NODE_OPTIONS=--require
// (e2e/helpers/app-process.ts, `preload`), so that no line of the app's own source is touched.
//
// It replaces Electron's `dialog.showErrorBox` with a function that writes what it was given to a
// file and returns at once, as a box the user has closed would: the real call blocks the main
// process until someone closes it, and nobody does in a test. The file is named by
// TENON_E2E_BOX_FILE; one JSON object a line: { at, title, content }, `at` the epoch milliseconds.
//
// A --require preload runs before Electron has set up its own modules: `dialog` is not there yet
// (the probe that first tried this died on it), so it waits until it is. The box is shown only
// after the app is ready, long after this has run.
if (process.type === 'browser') {
  const { appendFileSync } = require('node:fs')
  const install = () => {
    const { dialog } = require('electron')
    if (dialog === undefined) {
      setTimeout(install, 20)
      return
    }
    dialog.showErrorBox = (title, content) => {
      appendFileSync(
        process.env.TENON_E2E_BOX_FILE,
        `${JSON.stringify({ at: Date.now(), title, content })}\n`,
      )
    }
  }
  setTimeout(install, 0)
}
