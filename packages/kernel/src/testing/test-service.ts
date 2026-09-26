/**
 * `createTestSessionService` (spec 02 §主进程与 kernel 的循环接口「测试与 6b」): the same construction
 * as `createSessionService`, plus the test tool registry — every builtin tool is a candidate, each with
 * a fake executor unless a case says `'real'` or `null` — and layer-3 readings, which phase 2 has no
 * producer for. The product entry exports neither, and `SessionServiceOptions` carries neither.
 *
 * Each builtin tool reaches kernel tests through this before it joins the product table (Read, Glob
 * and Grep at plan step 18; Write, Edit and Bash at 22; AskUserQuestion 26; WebSearch 28; WebFetch
 * 29; Agent 31).
 */
import { constructSessionService } from '../session/service.js'
import type {
  SessionService,
  SessionServiceOptions,
  TestServiceExtras,
  TestToolRegistry,
} from '../session/service.js'

export type { TestServiceExtras, TestToolRegistry }

export function createTestSessionService(
  options: SessionServiceOptions,
  test: TestServiceExtras = {},
): SessionService {
  return constructSessionService(options, { ...test, tools: test.tools ?? {} })
}
