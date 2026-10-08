/** Local reference dialects understood by CfWorker, using shared definitions rather than huge JSON. */
export function schemaChain(
  kind: 'anchor' | 'fragment-id' | 'dependencies' | 'tuple' | 'numeric-id' | 'empty-id',
  depth = 20,
) {
  const definitions: Record<string, unknown> = {}
  for (let i = 0; i <= depth; i++) {
    const next = kind === 'dependencies' ? `#/stash/d${i + 1}` : `#a${i + 1}`
    definitions[`d${i}`] = {
      ...(['anchor', 'tuple', 'numeric-id', 'empty-id'].includes(kind)
        ? { $anchor: `a${i}` }
        : kind === 'fragment-id'
          ? { $id: `#a${i}` }
          : {}),
      ...(i === depth
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
      Array.from({ length: depth + 1 }, (_, i) => [`d${i}`, { $anchor: `a${i}` }]),
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

/** Reference/resolver spellings from the review families; all stay physically small. */
export function hostileSchemaShapes(
  depth = 32,
): { name: string; schema: unknown; instance: unknown }[] {
  const shapes: { name: string; schema: unknown; instance: unknown }[] = [
    'anchor',
    'fragment-id',
    'dependencies',
    'tuple',
    'numeric-id',
    'empty-id',
  ].map((kind) => ({
    name: kind,
    schema: schemaChain(kind as Parameters<typeof schemaChain>[0], depth),
    instance: { x: 1, y: 1 },
  }))

  const tupleDefs = Object.fromEntries(
    Array.from({ length: depth + 1 }, (_, i) => [
      'd' + i,
      i === depth
        ? {}
        : {
            items: [{ allOf: [{ $ref: '#/$defs/d' + (i + 1) }, { $ref: '#/$defs/d' + (i + 1) }] }],
          },
    ]),
  )
  let tupleInstance: unknown = 0
  for (let i = 0; i < depth; i++) tupleInstance = [tupleInstance]
  shapes[3] = {
    name: 'tuple',
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $defs: tupleDefs,
      $ref: '#/$defs/d0',
    },
    instance: tupleInstance,
  }
  const base = schemaChain('anchor', depth) as Record<string, unknown>
  shapes.push({
    name: 'legacy-id',
    schema: JSON.parse(JSON.stringify(base).replaceAll('"$anchor":"a', '"id":"#a')),
    instance: { x: 1, y: 1 },
  })
  shapes.push({
    name: 'pointer',
    schema: {
      ...base,
      $ref: '#/$defs/d0',
      $defs: Object.fromEntries(
        Object.entries(base.$defs as Record<string, unknown>).map(([key, value]) => [
          key,
          JSON.parse(JSON.stringify(value).replace(/#a(\d+)/g, '#/$defs/d$1')),
        ]),
      ),
    },
    instance: { x: 1, y: 1 },
  })
  let recursiveInstance: unknown = {}
  for (let i = 0; i < depth; i++) recursiveInstance = { next: recursiveInstance }
  shapes.push({
    name: 'recursive-ref',
    schema: {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $recursiveAnchor: true,
      type: 'object',
      properties: { next: { allOf: [{ $recursiveRef: '#' }, { $recursiveRef: '#' }] } },
    },
    instance: recursiveInstance,
  })
  for (const [name, id] of [
    ['boolean-id', true],
    ['object-id', {}],
    ['zero-id', 0],
  ] as const) {
    const original = schemaChain('numeric-id', depth) as Record<string, unknown>
    shapes.push({
      name,
      schema: {
        ...original,
        payload: { ...(original.payload as Record<string, unknown>), $id: id },
      },
      instance: { x: 1, y: 1 },
    })
  }
  // Recursive refs at the same position multiply with the instance depth as well.
  const recursive = {
    type: 'object',
    properties: { next: { allOf: [{ $ref: '#' }, { $ref: '#' }] } },
  }
  let instance: Record<string, unknown> = {}
  for (let i = 0; i < depth; i++) instance = { next: instance }
  shapes.push({ name: 'instance-recursion', schema: recursive, instance })
  shapes.push({
    name: 'duplicate-anchor',
    schema: { ...base, decoy: { $anchor: 'a0' }, $ref: '#a1' },
    instance: { x: 1, y: 1 },
  })
  for (const [name, id] of [
    ['nested-id', 'https://nested.example/schema'],
    ['relative-id', 'inner'],
  ] as const) {
    shapes.push({
      name,
      schema: { $id: 'https://root.example/schema', properties: { payload: { ...base, $id: id } } },
      instance: { payload: { x: 1, y: 1 } },
    })
  }
  return shapes
}
