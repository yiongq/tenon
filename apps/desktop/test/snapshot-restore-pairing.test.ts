import { absolutePath } from '@tenon-app/kernel'
import { expect, it } from 'vitest'
import { pairRestoreLeaves } from '../src/main/host/snapshot-restore.js'

type Leaf = Parameters<typeof pairRestoreLeaves>[0][number]
const origin: Leaf = {
  path: absolutePath('/work/Café.txt'),
  startKind: 'file',
  nowKind: null,
  object: '1:42',
  parentsExact: true,
}
const removal: Leaf = {
  ...origin,
  path: absolutePath('/work/Cafe\u0301.txt'),
  startKind: null,
  nowKind: 'file',
}

it.each([
  ['NFC/NFD', removal.path],
  ['case', absolutePath('/work/café.txt')],
  ['NFC/NFD and case', absolutePath('/work/CAFE\u0301.TXT')],
])(
  '05 验收 40: %s leaf aliases pair by current filesystem identity on every platform',
  (_, path) => {
    const other = { ...removal, path }
    expect(pairRestoreLeaves([origin, other])).toEqual([origin.path, path])
    expect(pairRestoreLeaves([other, origin])).toEqual([origin.path, path])
  },
)

const rejected: [string, Leaf[]][] = [
  ['one name', [origin]],
  ['three names', [origin, removal, { ...removal, path: absolutePath('/work/café.txt') }]],
  ['two restores', [origin, { ...removal, startKind: 'file' }]],
  ['two removals', [{ ...origin, startKind: null }, removal]],
  [
    'directory rename',
    [
      { ...origin, startKind: 'dir' },
      { ...removal, nowKind: 'dir' },
    ],
  ],
  ['other origin', [{ ...origin, startKind: 'other' }, removal]],
  ['other current object', [origin, { ...removal, nowKind: 'other' }]],
  ['directory replaces file', [origin, { ...removal, nowKind: 'dir' }]],
  ['different parents', [origin, { ...removal, path: absolutePath('/Work/Cafe\u0301.txt') }]],
  ['origin parent alias', [{ ...origin, parentsExact: false }, removal]],
  ['removal parent alias', [origin, { ...removal, parentsExact: false }]],
  ['origin identity unreadable', [{ ...origin, object: undefined }, removal]],
  ['removal identity unreadable', [origin, { ...removal, object: undefined }]],
  [
    'both identities unreadable',
    [
      { ...origin, object: undefined },
      { ...removal, object: undefined },
    ],
  ],
  ['different inode', [origin, { ...removal, object: '1:43' }]],
  ['different device', [origin, { ...removal, object: '2:42' }]],
  ['origin spelling still exists', [{ ...origin, nowKind: 'file' }, removal]],
  ['removal absent', [origin, { ...removal, nowKind: null }]],
]
it.each(rejected)('05 验收 40: %s must not qualify for a leaf rename', (_, group) => {
  expect(pairRestoreLeaves(group)).toBeUndefined()
})

it.each([
  ['file', 'file'],
  ['file', 'link'],
  ['link', 'file'],
  ['link', 'link'],
] as const)('05 验收 17、40: %s to %s is still a leaf pair', (startKind, nowKind) => {
  expect(
    pairRestoreLeaves([
      { ...origin, startKind },
      { ...removal, nowKind },
    ]),
  ).toEqual([origin.path, removal.path])
})
