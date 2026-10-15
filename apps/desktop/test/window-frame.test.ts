/**
 * The window frame per platform (UX diagnosis N01): macOS hides the system title bar and insets the
 * traffic lights over the sidebar's header; Windows and Linux keep the native frame, byte for byte.
 */
import { describe, expect, it } from 'vitest'
import { TRAFFIC_LIGHT_POSITION, windowFrame } from '../src/main/window-theme.js'

describe('windowFrame', () => {
  it('hides the title bar on macOS and places the traffic lights', () => {
    expect(windowFrame('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    })
  })

  it('adds nothing on Windows and Linux', () => {
    expect(windowFrame('win32')).toEqual({})
    expect(windowFrame('linux')).toEqual({})
  })
})
