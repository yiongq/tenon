'use strict'
// PROBE (probe/packaging, never merged): what Electron's main process does with an unhandled
// Promise rejection and an uncaught exception (error-logs P2). One scenario per process:
//
//   electron main-errors.cjs <trigger> <listener>
//     trigger:  reject | throw | both
//     listener: none | uncaught (a process 'uncaughtException' listener) | rejection (a process
//               'unhandledRejection' listener)
//
// uncaughtExceptionMonitor is always registered (it only observes) and dialog.showErrorBox is
// always replaced by a recorder, so nothing blocks on a real dialog. The script prints one
// P2-RESULT line after 2 s and exits; no such line means the process was gone before that.
const { app, dialog } = require('electron')

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('main-errors.cjs')) + 1)
const trigger = args[0] || 'both'
const listener = args[1] || 'none'
const events = []

process.on('uncaughtExceptionMonitor', (error, origin) => {
  events.push({ monitor: true, origin, message: String(error && error.message) })
})
dialog.showErrorBox = (title, content) => {
  events.push({ showErrorBox: true, title, content: String(content).split('\n')[0] })
}
if (listener === 'uncaught') {
  process.on('uncaughtException', (error) => {
    events.push({ uncaughtException: true, message: String(error && error.message) })
  })
}
if (listener === 'rejection') {
  process.on('unhandledRejection', (reason) => {
    events.push({ unhandledRejection: true, message: String(reason && reason.message) })
  })
}

const started = {
  trigger,
  listener,
  electron: process.versions.electron,
  node: process.versions.node,
  uncaughtExceptionListeners: process.listenerCount('uncaughtException'),
  unhandledRejectionListeners: process.listenerCount('unhandledRejection'),
}

if (trigger === 'reject' || trigger === 'both') {
  Promise.reject(new Error('P2-rejection'))
}
if (trigger === 'throw' || trigger === 'both') {
  setTimeout(() => {
    throw new Error('P2-timer-throw')
  }, 300)
}
setTimeout(() => {
  process.stdout.write(`P2-RESULT ${JSON.stringify({ ...started, events })}\n`)
  app.exit(0)
}, 2000)
