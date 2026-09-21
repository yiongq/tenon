/**
 * Where ids come from. `runId`, `messageId` and `incarnationId` are all canonical
 * UUIDs, and every kernel service takes an `IdSource` as a constructor argument
 * (`createSessionService({ host, tape, ids })`): the kernel never draws randomness
 * itself, otherwise fixtures and the tape conformance suite would not be reproducible.
 *
 * `ids` is deliberately NOT a HostAdapter member — the adapter carries environment
 * capabilities, while this is a service-construction port. Desktop passes
 * `crypto.randomUUID()`; tests pass the counter from @tenon-app/kernel/testing.
 */
export interface IdSource {
  uuid(): string
}

/** Lowercase 8-4-4-4-12 hex. Uppercase, braces and urn: prefixes are not canonical. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value)
}
