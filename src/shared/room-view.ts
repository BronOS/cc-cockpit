// The room view's data (design-rooms.md §5 "The room view"): what `rooms.view` answers for the core dialog that
// "Room..." opens on a member tab. Plain data built by main (room-service.ts view) for a room of the sender's own
// project, so the renderer and a server's browsers get the same thing.
//
// Untrusted text. A room's title, its member names, doc paths and every log entry's fields come from the plugin that
// owns the room and from its members (a message's text, a doc path a member chose, a leave's reason). Main passes
// them on as data, never as markup: the dialog renders every string as plain text (React text nodes), never as HTML,
// a link or a style, and never reads a log entry's free fields as anything but text to show.
import type { TabStatus } from './ipc'

/** The newest log events a view carries (design-rooms.md §5: "the last 200 log events"). */
export const ROOM_VIEW_LOG_LIMIT = 200

/**
 * At most this many bytes of log entries (JSON) in one view: a message may be 20,000 characters, so 200 of them would
 * make a reply of several MiB, past what a browser view's socket takes in one frame. Past it the oldest are left out
 * (and `logMore` says so).
 */
export const ROOM_VIEW_LOG_MAX_BYTES = 1024 * 1024

export interface RoomViewMember {
  name: string
  coordinator: boolean
  /** The member's tab now (one of this project's tabs); absent while it has none (after a quit, until a restore). */
  tabId?: string
  /** The tab's Claude status now; `no-tab` while the member has none. */
  status: TabStatus | 'no-tab'
  /** Messages waiting for the member. */
  held: number
}

export interface RoomViewDoc {
  /** `shared/...` or `members/<name>/...` (room-docs.ts). */
  path: string
  /** Bytes. */
  size: number
}

/** One log event (room-log.ts RoomLogEntry): `seq`, `at` and `type` are main's; the other fields are free and untrusted. */
export interface RoomViewLogEntry {
  seq: number
  at: number
  type: string
  [key: string]: unknown
}

export interface RoomView {
  id: string
  title: string
  /** The plugin that owns the room. */
  pluginId: string
  createdAt: number
  /** Set once the room ended (its members left it; the record and docs stay until the plugin deletes it). */
  endedAt?: number
  paused: boolean
  /** In the registry's order (join order); the dialog sorts. */
  members: RoomViewMember[]
  /** Every doc of the room, sorted by path (the person sees every folder). */
  docs: RoomViewDoc[]
  /** The newest events, oldest first (ROOM_VIEW_LOG_LIMIT, ROOM_VIEW_LOG_MAX_BYTES). */
  log: RoomViewLogEntry[]
  /** Older events than `log` exist (the plugin reads them through ctx.rooms.log). */
  logMore: boolean
}

/**
 * The `rooms.remove` confirm put to every view of the window when a server's browser asks to remove a member
 * (design-rooms.md §5: through an ApprovalDialog; main/asks/shared-asks.ts). `title` and `name` are plain text.
 */
export interface RoomRemoveAsk {
  requestId: string
  roomId: string
  title: string
  name: string
}
