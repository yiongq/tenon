import { config } from 'zod'

/**
 * MEASURED under Tenon's exact CSP (`script-src 'self'`): zod v4 probes for JIT support with
 * `new Function('')` inside a try/catch. The throw is swallowed, so nothing breaks — but the
 * browser still files one `securitypolicyviolation` report per page load, which fails any
 * "no CSP violations" gate and shows up in Electron's console. zod's own source documents
 * this and gates the probe behind `jitless`.
 *
 * This module must be imported FIRST in the renderer entry: ES module evaluation follows
 * import order, so it has to run before anything that builds a zod schema (i.e. before
 * @tenon-app/contracts). Cost: zod validates via its interpreted path, which is irrelevant
 * for payloads the size of a chat event.
 */
config({ jitless: true })
