// The tab strip's room parts (design-rooms.md §5), DOM-free so unit tests load them: TabBar.tsx draws from these.
// A member tab gets a marker (the room's title and the member's name in its tooltip) and, while messages wait for
// it, the held badge; its context menu gets "Deliver room messages automatically" (the person's mark) and "Room...".
//
// Two sources, each the authority on its part: TabInfo.room is the tab record (membership and the mark, which main
// writes only on the person's `tabs.roomMark`), SessionDetail.room / held / typed are the session registry's mirror
// of the room registry (title, held count). The marker needs the tab record: a tab main says is in no room shows none
// even while a late snapshot still has the room.
import type { SessionDetail, TabInfo } from '../../shared/ipc'
import type { DeliverHeldWhy } from '../../shared/tab-room'

export interface RoomMarker {
  /** The member's name, drawn on the marker. */
  name: string
  /** Room title, name and role: the marker's tooltip and accessible description. */
  tooltip: string
}

export interface HeldBadge {
  /** The count as drawn ("99+" past 99, so a flood does not widen the tab). */
  text: string
  /** What the count is, why it waits, what a click does. */
  tooltip: string
  /** The badge button's accessible name. */
  label: string
}

/** One room entry of the tab's context menu. */
export type RoomMenuItem =
  | { id: 'mark'; label: string; checked: boolean; description: string }
  | { id: 'room'; label: string }

export const MARK_LABEL = 'Deliver room messages automatically'
export const ROOM_VIEW_LABEL = 'Room…'

/** The most a badge draws as a number. */
const BADGE_MAX = 99

/** The marker of a member tab; undefined for a tab in no room (by its tab record). */
export function roomMarker(tab: TabInfo, detail: SessionDetail | undefined): RoomMarker | undefined {
  if (tab.kind !== 'claude' || !tab.room) return undefined
  const { name, coordinator } = tab.room
  const title = detail?.room?.title
  const role = coordinator ? ', coordinator' : ''
  // The title is the plugin's text (checked by main: no control, quote, bracket or bidi characters); React sets it
  // as a plain attribute, so it can never be markup.
  const head = title === undefined ? `In a room as ${name}${role}` : `Room "${title}" as ${name}${role}`
  return { name, tooltip: tab.room.mark ? `${head}\nRoom messages are delivered automatically` : head }
}

/** The held badge: only for a member tab with messages waiting. */
export function heldBadge(tab: TabInfo, detail: SessionDetail | undefined): HeldBadge | undefined {
  if (tab.kind !== 'claude' || !tab.room) return undefined
  const held = detail?.held
  if (held === undefined || !Number.isInteger(held) || held < 1) return undefined
  const what = held === 1 ? '1 room message waiting' : `${held} room messages waiting`
  // The reason the person would otherwise have to guess: a typed tab without the mark gets no pointer of its own
  // (design-rooms.md §2), so the count waits for them; any other tab gets it at its next chance.
  // A marked typed tab: the gate pastes only while nothing the person typed may be unsent (the draft bit, which the
  // strip cannot see), so "waits for input" alone would promise a delivery that may not come.
  const typed = detail?.typed === true
  const why =
    typed && !tab.room.mark
      ? `Held: you typed in this tab, so room messages wait for you. Turn on "${MARK_LABEL}" in the tab menu to let them in.`
      : typed
        ? 'Claude gets them when it next stops, or when it waits for input with nothing you typed unsent.'
        : 'Claude gets them when it next stops or waits for input.'
  return {
    text: held > BADGE_MAX ? `${BADGE_MAX}+` : String(held),
    tooltip: `${what}\n${why}\nClick to have Claude read them now.`,
    label: `${what}: deliver now`
  }
}

/** The room entries of a tab's context menu: none for a tab in no room. "Room..." only when the view can open it. */
export function roomMenuItems(tab: TabInfo, options: { roomView: boolean }): RoomMenuItem[] {
  if (tab.kind !== 'claude' || !tab.room) return []
  const items: RoomMenuItem[] = [
    {
      id: 'mark',
      label: MARK_LABEL,
      checked: tab.room.mark,
      description: tab.room.mark
        ? 'Room messages reach this tab even though you typed in it'
        : 'Off: once you type in this tab, room messages wait behind its badge'
    }
  ]
  if (options.roomView) items.push({ id: 'room', label: ROOM_VIEW_LABEL })
  return items
}

/** The strip's button after a `draft` answer: the person's choice to deliver on top of what is in the box. */
export const DELIVER_ANYWAY_LABEL = 'Deliver anyway'

/** What the strip says when the badge's click put nothing in (rooms.deliverHeld's `why`). */
export function deliverHeldText(why: DeliverHeldWhy): string {
  switch (why) {
    case 'no-room':
      return 'This tab is no longer in a room.'
    case 'nothing-held':
      return 'No room messages are waiting for this tab any more.'
    case 'paused':
      return 'The room is paused: resume it in the room view to deliver its messages.'
    case 'draft':
      // Main cannot see the box: the person may have cleared it, or it may hold a half-typed prompt.
      return `You typed in this tab since your last prompt, so the box may hold unsent text. Send it first, or "${DELIVER_ANYWAY_LABEL}" adds the pointer to whatever is in the box and sends both.`
    case 'ended':
      return 'Claude is not running in this tab: restart it to deliver room messages.'
    case 'permission':
      return 'Claude is waiting for your answer to a prompt in this tab: answer it, then click the badge again.'
    case 'busy':
      return 'Claude is busy in this tab: click the badge again once it waits for input.'
  }
}
