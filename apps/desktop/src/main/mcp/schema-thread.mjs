// Worker messages use structured clone, without a browser targetOrigin.
// oxlint-disable unicorn/require-post-message-target-origin
import { parentPort } from 'node:worker_threads'
import { Validator } from '@cfworker/json-schema'
parentPort.on('message', ({ schema, instance }) => {
  parentPort.postMessage({ type: 'started' })
  try {
    const result = new Validator(schema).validate(instance)
    parentPort.postMessage({
      type: 'result',
      verdict: result.valid
        ? { ok: true }
        : { ok: false, errors: result.errors.map((error) => error.error) },
    })
  } catch {
    parentPort.postMessage({ type: 'result', verdict: { ok: false, unusable: 'schema' } })
  }
})
