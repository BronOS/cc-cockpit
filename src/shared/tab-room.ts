// A Claude tab's room membership as the tab keeps it (design-rooms.md §1 "Restart", §2 "The mark"):
// `{ id, name, coordinator, mark }`, saved with the tab (TabRecord.room, restore.ts) because a restored
// tab gets a new id (tab-manager.ts, randomUUID) and the room registry binds tabs in memory only. The
// registry stays the authority on who is a member: a saved membership is matched by room id and name
// (RoomRegistry.rebind), never by the tab id, and lost when the room no longer has it.
//
// `mark` ("Deliver room messages automatically") is the person's alone, like the flag (tab-flag.ts):
// written only by TabManager.setRoomMark from the shell page; no host API, hook or `ccc` path. It is
// bound to (tab, room): a new membership starts unmarked and leaving drops it with the membership.
//
// The projects file is user-writable, so the saved value is read leniently: anything off loses the
// membership (the tab still comes back), never the tab.
import { isRoomId, isRoomName } from './room-names'

export interface TabRoom {
  /** The room's id (RoomRegistry, randomUUID). */
  id: string
  /** The member's name in the room. */
  name: string
  /** May write the shared docs and read every member's folder (design-rooms.md §1). */
  coordinator: boolean
  /** The person's mark: room messages reach this tab even though the person typed in it (design-rooms.md §2). */
  mark: boolean
}

/** A saved membership (TabRecord.room), or undefined when any field is off. `mark` reads as false unless it is `true`. */
export function tabRoomOf(raw: unknown): TabRoom | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { id, name, coordinator, mark } = raw as Record<string, unknown>
  if (!isRoomId(id) || !isRoomName(name) || typeof coordinator !== 'boolean') return undefined
  // A damaged mark is no mark: it lets messages into a tab the person typed in, so only an explicit true counts.
  return { id, name, coordinator, mark: mark === true }
}

/** Two memberships (or none) say the same: what the tab manager compares before reporting a change. */
export function sameTabRoom(a: TabRoom | undefined, b: TabRoom | undefined): boolean {
  return a?.id === b?.id && a?.name === b?.name && a?.coordinator === b?.coordinator && a?.mark === b?.mark
}
