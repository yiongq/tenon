import { expect, it } from 'vitest'
import {
  inspectorRelease,
  ipcRoutes,
  flaggedCategorySchema,
  decisionSummaryCodeSchema,
} from '../src/index.js'

it('inspector.release is registered with a strict request and the five receipt statuses', () => {
  expect(Object.values(ipcRoutes)).toContain(inspectorRelease)
  expect(inspectorRelease.channel).toBe('inspector.release')
  const request = { sessionId: '11111111-1111-4111-8111-111111111111', callKey: 'opaque:call:key' }
  expect(inspectorRelease.request.parse(request)).toEqual(request)
  expect(inspectorRelease.request.safeParse({ ...request, inspectorIds: ['forged'] }).success).toBe(
    false,
  )
  expect(
    inspectorRelease.request.safeParse({ ...request, sessionId: 'not-a-session' }).success,
  ).toBe(false)
  expect(inspectorRelease.request.safeParse({ ...request, callKey: '' }).success).toBe(false)
  for (const status of ['released', 'already-released', 'stale', 'not-found', 'refused'])
    expect(inspectorRelease.response.parse({ status })).toEqual({ status })
  expect(inspectorRelease.response.safeParse({ status: 'allowed' }).success).toBe(false)
  expect(flaggedCategorySchema.parse('hidden-characters')).toBe('hidden-characters')
  expect(flaggedCategorySchema.parse('control-characters')).toBe('control-characters')
  expect(decisionSummaryCodeSchema.parse('inspector-flagged')).toBe('inspector-flagged')
})
