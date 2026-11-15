// The room pointer (design-rooms.md §2): the one fixed text that tells a member tab it has room messages, pasted by
// the send gate and given as the Stop hook's block reason. Shared by main (rooms/room-delivery.ts, room-stop.ts) and
// `ccc hook Stop` (cli/client.ts), which prints a block only when its reason is exactly this text: a reply is only as
// trustworthy as whatever owns the socket, and nothing but the count may ever reach Claude's context that way.

/** The pointer for `count` waiting messages: fixed text, the count only, never room text. */
export function pointerText(count: number): string {
  return count === 1 ? '1 room message waiting: run ccc room read' : `${count} room messages waiting: run ccc room read`
}

/** Most digits a count may have in a pointer `ccc` accepts; a queue is far smaller. */
const MAX_COUNT_DIGITS = 6

/** True when `text` is exactly `pointerText(n)` for some count n ≥ 1 (no leading zero, at most six digits). */
export function isPointerText(text: unknown): text is string {
  if (typeof text !== 'string') return false
  const space = text.indexOf(' ')
  if (space < 1 || space > MAX_COUNT_DIGITS) return false
  const digits = text.slice(0, space)
  for (const c of digits) if (c < '0' || c > '9') return false
  if (digits[0] === '0') return false
  return text === pointerText(Number(digits))
}
