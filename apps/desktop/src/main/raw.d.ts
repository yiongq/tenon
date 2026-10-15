// `?raw` imports (Vite): the file's text, inlined into the bundle. electron-vite's own `node.d.ts`
// declares `?nodeWorker`, `?asset` and friends but not this one.
declare module '*?raw' {
  const content: string
  export default content
}
