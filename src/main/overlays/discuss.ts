// The text Discuss with Claude sends (design-next §3.5), pure: no clock but the one passed in, no
// I/O. overlay-manager.ts asks the opener for its context, then builds the message here:
//
//   About: <title>
//   <the type as one line: File: src/x.ts | Item: <source> <id> | name: key=value ...>
//
//   <the opener's context text>
//
// then the person's own closing prompt (Settings, optional), at most MAX_DISCUSS_TEXT characters, the context cut
// to fit (the head is short and capped, the prompt is never cut). It always starts
// with `About:`, so the send gate's refusal of a leading `/`, `!`, `#` or `&` (a slash command or a
// bash line typed into Claude) can never fire on it, whatever the title or context say.
import {
  DISCUSS_NEW_WINDOW_MS,
  MAX_DISCUSS_NEW_SESSIONS,
  MAX_DISCUSS_PROMPT,
  MAX_DISCUSS_TEXT,
  MAX_DISCUSS_TYPE_LINE
} from '../../shared/discuss'
import type { CleanOverlayType } from '../../shared/overlay-buttons'

export interface DiscussParts {
  /** The overlay's title (any text: it is made one line here). */
  title: string
  /** The overlay's type, if it has one. */
  type?: CleanOverlayType
  /** What the opener's onDiscuss answered (absent or empty: no extra context). */
  context?: string
  /** The person's closing prompt (shared/discuss.ts effectiveDiscussPrompt); blank or absent: none. */
  prompt?: string
}

/** Shown where the context was cut to fit, so Claude knows it did not get all of it. */
export const CUT_MARK = '\n[… cut to fit]'

/** Whitespace runs (newlines, tabs) to one space: a title or a type line must stay on its line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A value of a type's data as the generic line shows it: a string as itself, the rest as JSON. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '?'
  }
}

/**
 * The type as one short line. The well-known types read as words (`file` `{ path }` is
 * `File: <path>`, `inbox-item` `{ source, id }` is `Item: <source> <id>`); any other type, or a
 * well-known one whose data has another shape, is `<name>: key=value ...` (data that is not an
 * object: `<name>: <JSON>`). At most MAX_DISCUSS_TYPE_LINE characters.
 */
export function discussTypeLine(type: CleanOverlayType): string {
  const data = type.data
  const obj = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
  let line: string
  if (type.name === 'file' && typeof obj?.path === 'string' && obj.path !== '') {
    line = `File: ${obj.path}`
  } else if (type.name === 'inbox-item' && typeof obj?.source === 'string' && typeof obj.id === 'string') {
    line = `Item: ${obj.source} ${obj.id}`
  } else if (obj) {
    const pairs = Object.entries(obj).map(([k, v]) => `${k}=${valueText(v)}`)
    line = pairs.length > 0 ? `${type.name}: ${pairs.join(' ')}` : type.name
  } else {
    line = `${type.name}: ${valueText(data)}`
  }
  return clip(oneLine(line), MAX_DISCUSS_TYPE_LINE)
}

/** The message for Claude (see the top of the file). */
export function composeDiscuss(parts: DiscussParts): string {
  const head = [`About: ${oneLine(parts.title) || 'Overlay'}`]
  if (parts.type) head.push(discussTypeLine(parts.type))
  const headText = head.join('\n')
  let context = parts.context?.trim() ? parts.context.trim() : undefined
  // The head and the prompt are fixed; only the context gives way (never the person's own words).
  // Capped again here: the caller's value is a stored string, but this function must hold the limit alone.
  const prompt = parts.prompt?.trim() ? parts.prompt.trim().slice(0, MAX_DISCUSS_PROMPT) : undefined
  if (context !== undefined) {
    // What the head, the prompt and the blank lines around the context leave for it.
    const fixed = headText.length + 2 + (prompt !== undefined ? prompt.length + 2 : 0)
    const room = MAX_DISCUSS_TEXT - fixed
    if (context.length > room) {
      const keep = room - CUT_MARK.length
      context = keep > 0 ? `${context.slice(0, keep).trimEnd()}${CUT_MARK}` : undefined
    }
  }
  return [headText, context, prompt].filter((p): p is string => p !== undefined).join('\n\n')
}

/**
 * Discuss's own budget for New session, per window (design-next §3.5: 5 a minute, not counted
 * against the opener plugin's ctx.sessions.open budget). A sliding window of start times.
 */
export class DiscussSessionBudget {
  private readonly starts = new Map<number, number[]>()

  constructor(
    private readonly max = MAX_DISCUSS_NEW_SESSIONS,
    private readonly windowMs = DISCUSS_NEW_WINDOW_MS
  ) {}

  /** Take one for `windowId`; false when its budget is spent. */
  take(windowId: number, now = Date.now()): boolean {
    const recent = (this.starts.get(windowId) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.starts.set(windowId, recent)
      return false
    }
    recent.push(now)
    this.starts.set(windowId, recent)
    return true
  }

  /** Give back the newest one: the tab was refused before it started. */
  refund(windowId: number): void {
    this.starts.get(windowId)?.pop()
  }

  /** The window closed. */
  forget(windowId: number): void {
    this.starts.delete(windowId)
  }
}
