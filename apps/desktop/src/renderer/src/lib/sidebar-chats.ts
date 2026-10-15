/**
 * What the sidebar's chats section shows. There is no list of sessions yet (spec 02 leaves it to a
 * later phase), so the section has exactly one thing it can truthfully say: that there is nothing
 * here. Once any chat exists — a stored one the window restored or went back to, or one this window
 * has sent a message in — it says nothing at all, rather than 「还没有对话」 under a conversation.
 */
export interface SidebarChats {
  /** The section's heading. */
  readonly heading: boolean
  /** 「还没有对话」. */
  readonly emptyHint: boolean
}

export function sidebarChats(hasChats: boolean): SidebarChats {
  return { heading: !hasChats, emptyHint: !hasChats }
}
