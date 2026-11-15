// The room dialog's model (design-rooms.md §5 "The room view"), DOM-free so unit tests load it: RoomDialog.tsx draws
// from these. Input is main's `rooms.view` (shared/room-view.ts) plus this window's sessions snapshot, which is newer
// for a member's status: a status change is no `rooms.changed` (main tells the dialog only about the room's own
// record, log and docs), so the dialog follows `sessions.snapshot` for it.
//
// Untrusted text. Titles, member names, doc paths and every log entry's free fields are the owning plugin's and its
// members' words: this module only turns them into strings, which the dialog renders as React text nodes, never as
// markup, a link or a style. A free field that is not a string is shown as short JSON, never interpreted.
import type { TabStatus } from '../../shared/ipc'
import type { RoomView, RoomViewLogEntry, RoomViewMember } from '../../shared/room-view'

export interface RoomMemberRow {
  name: string
  coordinator: boolean
  tabId?: string
  status: TabStatus | 'no-tab'
  /** The status as words ("Working", "No tab"). */
  statusText: string
  held: number
  /** "3 held"; empty with none waiting. */
  heldText: string
}

export interface RoomDocRow {
  path: string
  sizeText: string
}

export interface RoomLogRow {
  seq: number
  /** HH:MM:SS, local time. */
  time: string
  text: string
}

/** What the dialog offers. `act`: Pause, Resume and Remove count from this view (main says the same). */
export interface RoomControls {
  state: 'active' | 'paused' | 'ended'
  /** One line under the title: the state and the owner. */
  stateText: string
  canPause: boolean
  canResume: boolean
  canRemove: boolean
  /** Reveal folder: the desktop only (a browser's host has no screen of its own to show it on, `rooms.reveal` is `no`). */
  canReveal: boolean
  /**
   * The desktop asks on screen before it removes (main removes a desktop's `rooms.remove` at once); a server's
   * browser gets the window's ApprovalDialog from main instead (`rooms.removeAsk`), so it asks nothing itself.
   */
  confirmRemove: boolean
  /** Why the controls are missing in a browser outside server mode (the desktop is the owner there). */
  readOnlyNote?: string
}

/** Which page draws the dialog: the desktop window, a browser view, a server's browser view (shell-kind.ts). */
export interface RoomViewer {
  webShell: boolean
  serverView: boolean
}

const STATUS_TEXT: Record<TabStatus | 'no-tab', string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  'needs-permission': 'Needs permission',
  waiting: 'Waiting for input',
  ended: 'Ended',
  'no-tab': 'No tab'
}

/** The longest text one log row shows (a message may be 20,000 characters; the plugin reads it all through its log). */
export const LOG_TEXT_MAX = 300

/** Statuses newer than the view's, by tab id (this window's sessions snapshot). */
export type LiveStatuses = ReadonlyMap<string, { status: TabStatus }>

/**
 * The members, coordinators first, then by name. A member's status comes from the sessions snapshot when its tab is
 * in it (newer than the view, which is read only on `rooms.changed`), else from the view.
 */
export function memberRows(view: RoomView, live?: LiveStatuses): RoomMemberRow[] {
  return [...view.members].sort(byCoordinatorThenName).map((m) => {
    const status = m.tabId !== undefined ? (live?.get(m.tabId)?.status ?? m.status) : m.status
    const held = Number.isInteger(m.held) && m.held > 0 ? m.held : 0
    return {
      name: m.name,
      coordinator: m.coordinator,
      ...(m.tabId !== undefined ? { tabId: m.tabId } : {}),
      status,
      statusText: STATUS_TEXT[status] ?? String(status),
      held,
      heldText: held === 0 ? '' : `${held} held`
    }
  })
}

function byCoordinatorThenName(a: RoomViewMember, b: RoomViewMember): number {
  if (a.coordinator !== b.coordinator) return a.coordinator ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** The docs by path (main sorts them already; sorted again so the dialog never depends on it). */
export function docRows(view: RoomView): RoomDocRow[] {
  return [...view.docs]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((d) => ({ path: d.path, sizeText: sizeText(d.size) }))
}

export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** The log, newest first (the view carries it oldest first), each entry as one line of plain text. */
export function logRows(view: RoomView): RoomLogRow[] {
  return [...view.log].reverse().map((e) => ({ seq: e.seq, time: timeText(e.at), text: logText(e) }))
}

export function timeText(at: number): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** A free field as text: a string as it is (capped), anything else as short JSON, a missing one as `?`. */
function field(value: unknown): string {
  if (value === undefined || value === null) return '?'
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : json(value)
  return text.length > LOG_TEXT_MAX ? `${text.slice(0, LOG_TEXT_MAX)}…` : text
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '?'
  } catch {
    return '?'
  }
}

/** One log entry as a line. Every type main writes (room-registry.ts, room-docs.ts, room-delivery.ts) has its words. */
export function logText(e: RoomViewLogEntry): string {
  switch (e.type) {
    case 'create':
      return `Room created: ${field(e.title)}`
    case 'invite':
      return `Invite for ${field(e.member)}${e.coordinator === true ? ' (coordinator)' : ''}`
    case 'join':
      return `${field(e.member)} joined${e.coordinator === true ? ' as coordinator' : ''}`
    case 'leave':
      return `${field(e.member)} left${e.why !== undefined ? ` (${field(e.why)})` : ''}`
    case 'end':
      return `Room ended${e.why !== undefined ? ` (${field(e.why)})` : ''}`
    case 'pause':
      return 'Paused'
    case 'auto-pause':
      return 'Paused automatically (many deliveries with no input from you)'
    case 'resume':
      return 'Resumed'
    case 'send':
      return `${field(e.from)} → ${field(e.to)}: ${field(e.text)}`
    case 'doc-read':
      return `${field(e.by)} read ${field(e.path)}`
    case 'doc-write':
      return `${field(e.by)} wrote ${field(e.path)}`
    case 'doc-refused':
      return `${field(e.by)}: ${field(e.op)} of ${field(e.path)} refused (${field(e.reason)})`
    case 'trimmed':
      return `Older events dropped (${field(e.dropped)})`
    default: {
      const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'seq' && k !== 'at' && k !== 'type'))
      const extra = Object.keys(rest).length > 0 ? ` ${field(rest)}` : ''
      return `${field(e.type)}${extra}`
    }
  }
}

export function roomControls(view: RoomView, viewer: RoomViewer): RoomControls {
  const state = view.endedAt !== undefined ? 'ended' : view.paused ? 'paused' : 'active'
  // A browser outside server mode reads only: main refuses its Pause, Resume and Remove (the `adapted` rule).
  const act = !viewer.webShell || viewer.serverView
  const live = state !== 'ended'
  const stateWord = state === 'ended' ? 'Ended' : state === 'paused' ? 'Paused: nothing is delivered' : 'Active'
  return {
    state,
    stateText: `${stateWord} · by ${view.pluginId}`,
    canPause: act && state === 'active',
    canResume: act && state === 'paused',
    canRemove: act && live,
    canReveal: !viewer.webShell,
    confirmRemove: !viewer.webShell,
    ...(act ? {} : { readOnlyNote: 'Read only here: pause, resume and remove on the desktop.' })
  }
}

/** The dialog's line for an empty part. */
export const NO_MEMBERS = 'No members'
export const NO_DOCS = 'No docs'
export const NO_LOG = 'No events yet'
