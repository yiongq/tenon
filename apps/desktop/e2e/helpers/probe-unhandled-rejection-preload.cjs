// 临时探针，plan 2.0，段二前删除 (docs/features/error-logs/plan.md, spec §开放问题 1).
//
// Loaded into the main process of the development build through NODE_OPTIONS=--require, so that
// no line of the app's own source is touched. In mode `listener` it first registers an empty
// `unhandledRejection` listener; in both modes it later makes one unhandled Promise rejection and
// then quits the app the ordinary way. It prints what it does to stderr, so the probe's record
// shows whether it ran at all.
if (process.type === 'browser') {
  const mode = process.env.PROBE_MODE === 'listener' ? 'listener' : 'plain'
  const { app } = require('electron')
  process.stderr.write(`[probe] preload ran in the main process, mode=${mode}\n`)
  if (mode === 'listener') process.on('unhandledRejection', () => {})
  app.whenReady().then(() => {
    setTimeout(() => {
      process.stderr.write('[probe] making an unhandled rejection now\n')
      Promise.reject(new Error('probe-unhandled-rejection'))
      setTimeout(() => {
        process.stderr.write('[probe] quitting the app\n')
        app.quit()
      }, 1500)
    }, 1500)
  })
}
