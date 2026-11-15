// What `ccc room` prints (design-rooms.md §4). Plain text for a Claude session reading it, like web-format.ts: the
// reply is main's, but a room title and a message's words reach it from other people's sessions, so every value goes
// through the caller's `plain` (control characters become spaces) and a reply of the wrong shape prints as little as
// it can instead of throwing. (A `read` prints main's fenced text as it is: the fence already escapes controls, and
// `plain` would flatten its lines.)
import { isPlainObject } from '../shared/guards'

type Plain = (text: unknown) => string

const text = (value: unknown, plain: Plain): string => plain(typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** `ccc room [status]` without --json: the caller's room and its members, or that there is none. */
export function formatRoomStatus(result: unknown, plain: Plain): string {
  if (!isPlainObject(result) || !isPlainObject(result.room)) return 'not in a room\n'
  const lines = [`room "${text(result.room.title, plain)}"${result.room.paused === true ? ' (paused)' : ''}`]
  const me = `${text(result.name, plain)}${result.coordinator === true ? ' (coordinator)' : ''}`
  lines.push(`you: ${me}, ${count(result.held)} message(s) held for you`)
  const members = Array.isArray(result.members) ? result.members : []
  lines.push('members:')
  for (const m of members) {
    if (!isPlainObject(m)) continue
    const tags = [m.coordinator === true ? 'coordinator' : '', m.you === true ? 'you' : ''].filter((t) => t !== '')
    const held = count(m.held)
    lines.push(`  ${text(m.name, plain)}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}: ${text(m.status, plain)}${held > 0 ? `, ${held} held` : ''}`)
  }
  return `${lines.join('\n')}\n`
}

/** Why a message waits (rooms/room-delivery.ts HeldWhy), in words for the sender. */
const HELD_WHY: Readonly<Record<string, string>> = {
  paused: 'the room is paused',
  'no-tab': 'it has no tab right now',
  typed: 'the person is typing in its tab',
  capped: 'it had 5 room pointers in a row; it waits for the person',
  draft: 'there is a draft in its prompt box',
  'not-waiting': 'it is busy'
}

/** `ccc room send`: one line per recipient, saying what happened to the message. */
export function formatRoomSend(result: unknown, plain: Plain): string {
  const delivery = isPlainObject(result) && Array.isArray(result.delivery) ? result.delivery : []
  const lines: string[] = []
  for (const a of delivery) {
    if (!isPlainObject(a)) continue
    const to = text(a.to, plain)
    switch (a.path) {
      case 'delivered':
        lines.push(`${to}: delivered`)
        break
      case 'held': {
        const why = typeof a.why === 'string' ? (HELD_WHY[a.why] ?? plain(a.why)) : ''
        lines.push(`${to}: held${why === '' ? '' : ` (${why})`}; it reads the message with ccc room read`)
        break
      }
      case 'gone':
        lines.push(`${to}: gone (no member by that name; nothing sent)`)
        break
      case 'refused':
        lines.push(`${to}: refused (${text(a.why, plain)})`)
        break
      default:
        lines.push(`${to}: ${text(a.path, plain)}`)
    }
  }
  return lines.length === 0 ? 'nobody else is in the room; nothing sent\n' : `${lines.join('\n')}\n`
}

/** `ccc room doc ls`: one `path<TAB>bytes` line per doc this tab may read. */
export function formatRoomDocs(result: unknown, plain: Plain): string {
  const docs = isPlainObject(result) && Array.isArray(result.docs) ? result.docs : []
  const lines: string[] = []
  for (const d of docs) if (isPlainObject(d)) lines.push(`${text(d.path, plain)}\t${count(d.size)}`)
  return lines.length === 0 ? 'no docs\n' : `${lines.join('\n')}\n`
}

/** `ccc room join` / `leave`: one line. */
export function formatRoomJoin(result: unknown, plain: Plain): string {
  const name = isPlainObject(result) ? text(result.name, plain) : ''
  const title = isPlainObject(result) ? text(result.title, plain) : ''
  return `joined room "${title}" as ${name}${isPlainObject(result) && result.coordinator === true ? ' (coordinator)' : ''}\n`
}

export function formatRoomLeave(result: unknown, plain: Plain): string {
  const title = isPlainObject(result) ? text(result.title, plain) : ''
  return `left room "${title}"\n`
}
