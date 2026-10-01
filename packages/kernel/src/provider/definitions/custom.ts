/**
 * Custom vendors (M6 §实例描述与通用工厂): an instance is one generic factory plus pure data, never a
 * definition file per vendor (Q3; ADR-003 decision 3).
 */

/**
 * An instance id (T1): `custom-` and a lowercase canonical UUID, minted by the main process and
 * never reused. 43 characters, inside `providerIdSchema`'s 64 and provenance's identity segment.
 * Contracts restates it as `CUSTOM_ID_REGEX`; a contracts test holds the two to the same source.
 */
export const CUSTOM_PROVIDER_ID_PATTERN =
  /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
