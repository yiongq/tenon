import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Workspace packages are bundled into main/preload: a packaged app has no node_modules
// next to out/, so a bare `import ... from '@tenon-app/kernel'` would fail there.
const workspaceDeps = ['@tenon-app/kernel', '@tenon-app/contracts']

// electron-vite 5's version table stops at Electron 39. Electron 44.4.1 embeds
// Node 24.21 / Chrome 152; revisit these targets on every Electron major bump.
const nodeTarget = 'node24'
const chromeTarget = 'chrome152'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspaceDeps },
      target: nodeTarget,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload can only require 'electron' and a few built-ins, so every
      // dependency (contracts, zod) must be bundled into it.
      externalizeDeps: false,
      target: nodeTarget,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // sandbox: true preloads run as plain scripts; an ESM preload never loads.
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      target: chromeTarget,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
