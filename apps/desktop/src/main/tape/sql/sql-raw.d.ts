/**
 * The migration SQL travels as a `?raw` import so that ONE code path works in vitest and in the
 * electron-vite main bundle: both are Vite, both inline the text at build time. Reading the file from
 * disk relative to the bundle would be a second path — and the one that breaks inside app.asar.
 *
 * Vite ships the `*?raw` declaration in `vite/client`, which the main process's tsconfig deliberately
 * does not include (its lib is `es2024`, with no DOM), so the narrow declaration lives here.
 */
declare module '*.sql?raw' {
  const sql: string
  export default sql
}
