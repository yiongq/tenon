/** Local reference dialects understood by CfWorker, using shared definitions rather than huge JSON. */
export function schemaChain(
  kind: 'anchor' | 'fragment-id' | 'dependencies' | 'tuple' | 'numeric-id' | 'empty-id',
) {
  const definitions: Record<string, unknown> = {}
  for (let i = 0; i <= 20; i++) {
    const next = kind === 'dependencies' ? `#/stash/d${i + 1}` : `#a${i + 1}`
    definitions[`d${i}`] = {
      ...(['anchor', 'tuple', 'numeric-id', 'empty-id'].includes(kind)
        ? { $anchor: `a${i}` }
        : kind === 'fragment-id'
          ? { $id: `#a${i}` }
          : {}),
      ...(i === 20
        ? { type: 'object' }
        : kind === 'dependencies'
          ? { dependencies: { x: { $ref: next }, y: { $ref: next } } }
          : kind === 'tuple'
            ? { items: [{ $ref: next }, { $ref: next }] }
            : { allOf: [{ $ref: next }, { $ref: next }] }),
    }
  }
  if (kind === 'numeric-id' || kind === 'empty-id') {
    // The incorrect id resolver looks under the root scope and follows these cheap decoys.
    const decoys = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`d${i}`, { $anchor: `a${i}` }]),
    )
    return {
      $id: 'https://decoy.test/schema',
      $defs: decoys,
      payload: {
        $id: kind === 'numeric-id' ? 123 : '',
        id: 'https://e.test/x',
        $defs: definitions,
        $ref: '#a0',
      },
      $ref: '#/payload',
    }
  }
  return kind === 'dependencies'
    ? { stash: definitions, $ref: '#/stash/d0', type: 'object' }
    : { $defs: definitions, $ref: '#a0', type: 'object' }
}
