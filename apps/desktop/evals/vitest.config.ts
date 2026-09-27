import { defineConfig } from 'vitest/config'

// The `evals` project (spec 02 §评测集与测试宿主). Plain `pnpm test` runs its format checks only:
// the live runs wait for TENON_EVAL (`pnpm eval`), the gate for TENON_EVALS_GATE (`pnpm evals:gate`).
export default defineConfig({
  test: {
    name: 'evals',
    environment: 'node',
    include: ['*.test.ts'],
  },
})
