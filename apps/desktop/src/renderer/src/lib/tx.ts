import type { TFunction } from 'i18next'

/**
 * A catalogue key built from data — a reason, a code, a tool name — with its slots. The compiler
 * cannot check such a key; the copy-coverage test walks every value the data can take and checks
 * both catalogues instead.
 */
export function tx(t: TFunction, key: string, values?: Readonly<Record<string, unknown>>): string {
  return String(values === undefined ? t(key as never) : t(key as never, { ...values } as never))
}
