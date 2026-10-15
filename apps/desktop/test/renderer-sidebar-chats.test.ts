/**
 * The sidebar says 「还没有对话」 only while there is no chat. It used to say it under a conversation
 * the user was in the middle of: the section was a static placeholder.
 */
import { describe, expect, it } from 'vitest'
import { sidebarChats } from '../src/renderer/src/lib/sidebar-chats.js'

describe('sidebarChats', () => {
  it('shows the heading and the empty hint when no chat exists', () => {
    expect(sidebarChats(false)).toEqual({ heading: true, emptyHint: true })
  })

  it('shows neither once a chat exists: there is no list to put under a heading yet', () => {
    expect(sidebarChats(true)).toEqual({ heading: false, emptyHint: false })
  })
})
