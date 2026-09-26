/**
 * Every inspector the desktop registers only asks (spec 02 §Inspector 接口与合议, §不变量 权限; F1,
 * F9). A change that makes this fail must also ship overriding a block from its receipt.
 */
import { describe, expect, it } from 'vitest'
import { desktopInspectors } from '../src/main/inspectors.js'

describe('the desktop’s inspectors', () => {
  it('all register ceiling ask, and none registers the after-result hook', () => {
    for (const inspector of desktopInspectors()) {
      expect({
        id: inspector.id,
        ceiling: inspector.ceiling,
        afterResult: inspector.afterResult,
      }).toEqual({
        id: inspector.id,
        ceiling: 'ask',
        afterResult: undefined,
      })
    }
    expect(desktopInspectors().length).toBeLessThanOrEqual(1)
  })
})
