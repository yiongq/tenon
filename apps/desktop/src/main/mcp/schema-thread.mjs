// Worker messages use structured clone, without a browser targetOrigin.
// oxlint-disable unicorn/require-post-message-target-origin
import { parentPort } from 'node:worker_threads'
import { Validator } from '@cfworker/json-schema'
parentPort.on('message', ({ schema, instance }) => {
  parentPort.postMessage({ type: 'started' })
  try {
    if (schema === null || typeof schema !== 'object') throw new Error('invalid schema')
    const uri = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : null
    let draft = '2020-12'
    if (uri !== null) {
      const match =
        /^https?:\/\/json-schema\.org\/(draft\/(2020-12|2019-09)|draft-(07|06))\/schema$/.exec(uri)
      if (!match) throw new Error('unsupported dialect')
      draft = match[2] ?? '7'
    }
    const result = new Validator(schema, draft).validate(instance)
    parentPort.postMessage({
      type: 'result',
      verdict: result.valid
        ? { ok: true }
        : {
            ok: false,
            errors: [
              result.errors.map((error) => `${error.instanceLocation}: ${error.error}`).join('; '),
            ],
          },
    })
  } catch {
    parentPort.postMessage({ type: 'result', verdict: { ok: false, unusable: 'schema' } })
  }
})
