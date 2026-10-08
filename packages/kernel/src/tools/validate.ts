/**
 * Argument validation (spec 02 §内置工具与参数「参数校验与失败」; open question 16): after the call's
 * tool is found in the frozen table and before any permission decision. A call that fails is not
 * decided, not shown on a card and not dispatched: it closes as blocked / not-run with source
 * `invalid-input`, and the reason goes back as the result's second text block.
 *
 * One validator for builtin and connector tools alike: `CfWorkerJsonSchemaValidator` from the MCP SDK
 * the kernel already depends on. It dispatches on `$schema` (2020-12 when absent), generates no code
 * and never evals. A connector's schema that cannot be used at all — an unsupported dialect when the
 * validator is built, a bad `pattern` or an unresolvable `$ref` when it runs — is not the model's
 * fault: that call closes as `tool-unavailable`, with `MODEL_NOTES.schemaUnusable` as the reason.
 */
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { schemaProblem } from '../mcp/definition.js'
import { MODEL_NOTES } from '../prompts/index.js'
import { BUILTIN_TOOLS, isBuiltinToolName } from './builtin/index.js'
import type { ToolTableItem } from './registry.js'

export type ValidationVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly source: 'invalid-input' | 'tool-unavailable'
      /** The second text block of the result: the validator's message, a fixed check, or the note. */
      readonly reason: string
    }

export interface ArgumentValidator {
  check(
    item: Pick<ToolTableItem, 'source' | 'originalName' | 'spec'>,
    args: unknown,
  ): ValidationVerdict
}

type Compiled = (input: unknown) => { valid: boolean; errorMessage: string | undefined }

export type SchemaVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] }
  | { readonly ok: false; readonly unusable: 'timeout' | 'schema' }
export interface SchemaValidatorPort {
  validate(q: {
    readonly schema: unknown
    readonly instance: unknown
    readonly signal: AbortSignal
  }): Promise<SchemaVerdict>
}
export interface AsyncArgumentValidator {
  check(
    item: Pick<ToolTableItem, 'source' | 'originalName' | 'spec'>,
    args: unknown,
  ): Promise<ValidationVerdict> | ValidationVerdict
}
export function createArgumentValidator(): ArgumentValidator
export function createArgumentValidator(
  port: SchemaValidatorPort | undefined,
  signal: AbortSignal,
): AsyncArgumentValidator
export function createArgumentValidator(
  port?: SchemaValidatorPort,
  signal?: AbortSignal,
): AsyncArgumentValidator {
  const engine = new CfWorkerJsonSchemaValidator()
  // Per spec object: a table's specs are fixed once it is frozen, so a Run compiles each once.
  const compiled = new WeakMap<object, Compiled | Error>()

  function compile(schema: Record<string, unknown>): Compiled | Error {
    const cached = compiled.get(schema)
    if (cached !== undefined) return cached
    let result: Compiled | Error
    try {
      if (schemaProblem(schema) !== null) throw new Error('Unsafe MCP schema')
      // A copy: the engine annotates the schema object it is given, and this one is a frozen fact.
      result = engine.getValidator(structuredClone(schema)) as Compiled
    } catch (error) {
      result = error instanceof Error ? error : new Error(String(error))
    }
    compiled.set(schema, result)
    return result
  }

  return {
    check(item, args): ValidationVerdict | Promise<ValidationVerdict> {
      if (item.source === 'mcp' && port) {
        if (schemaProblem(item.spec.inputSchema) !== null) return unusable()
        return port
          .validate({ schema: item.spec.inputSchema, instance: args, signal: signal! })
          .then<ValidationVerdict>((verdict) =>
            verdict.ok
              ? { ok: true }
              : 'unusable' in verdict
                ? unusable()
                : { ok: false, source: 'invalid-input', reason: verdict.errors.join('; ') },
          )
      }
      const validator = compile(item.spec.inputSchema)
      if (validator instanceof Error) return unusable()
      let outcome: ReturnType<Compiled>
      try {
        outcome = validator(args)
      } catch {
        return unusable()
      }
      if (!outcome.valid) {
        return { ok: false, source: 'invalid-input', reason: outcome.errorMessage ?? 'invalid' }
      }
      if (item.source === 'builtin' && isBuiltinToolName(item.originalName)) {
        const reason = BUILTIN_TOOLS[item.originalName].check(args as Record<string, unknown>)
        if (reason !== null) return { ok: false, source: 'invalid-input', reason }
      }
      return { ok: true }
    },
  }
}

function unusable(): ValidationVerdict {
  return { ok: false, source: 'tool-unavailable', reason: MODEL_NOTES.schemaUnusable }
}

export function synchronousSchemaVerdict(schema: unknown, instance: unknown): SchemaVerdict {
  try {
    if (schemaProblem(schema) !== null) return { ok: false, unusable: 'schema' }
    const result = new CfWorkerJsonSchemaValidator().getValidator(
      structuredClone(schema) as Record<string, unknown>,
    )(instance)
    return result.valid ? { ok: true } : { ok: false, errors: [result.errorMessage ?? 'invalid'] }
  } catch {
    return { ok: false, unusable: 'schema' }
  }
}
