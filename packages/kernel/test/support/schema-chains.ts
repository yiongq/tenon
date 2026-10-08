/** Local reference dialects understood by CfWorker, using shared definitions rather than huge JSON. */
export function schemaChain(kind: 'anchor' | 'fragment-id' | 'dependencies') {
  const definitions: Record<string, unknown> = {}
  for (let i = 0; i <= 20; i++) {
    const next = kind === 'dependencies' ? `#/stash/d${i + 1}` : `#a${i + 1}`
    definitions[`d${i}`] = {
      ...(kind === 'anchor'
        ? { $anchor: `a${i}` }
        : kind === 'fragment-id'
          ? { $id: `#a${i}` }
          : {}),
      ...(i === 20
        ? { type: 'object' }
        : kind === 'dependencies'
          ? { dependencies: { x: { $ref: next }, y: { $ref: next } } }
          : { allOf: [{ $ref: next }, { $ref: next }] }),
    }
  }
  return kind === 'dependencies'
    ? { stash: definitions, $ref: '#/stash/d0', type: 'object' }
    : { $defs: definitions, $ref: '#a0', type: 'object' }
}
