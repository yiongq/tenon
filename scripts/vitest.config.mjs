import { defineConfig } from 'vitest/config'

// The repo's lint-gate scripts are plain .mjs, so their tests are too — nothing here is
// typechecked by `tsc -b`, and nothing here may import from packages/ or apps/.
export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['*.test.mjs'],
  },
})
