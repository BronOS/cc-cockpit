// The text Discuss with Claude sends (design-next §3.5), pure: no clock but the one passed in, no
// I/O; at the end, the target check and the send that overlay Discuss and a page tab's Ask Claude
// share (they take main's DiscussSessions). overlay-manager.ts asks the opener for its context, then
// builds the message here:
//
//   About: <title>
//   <the type as one line: File: src/x.ts | Item: <source> <id> | name: key=value ...>
//
//   <the opener's context text>
//
// then the question asked from a page tab (Ask Claude, design-editor.md §4) and the person's own closing
// prompt (Settings, optional), at most MAX_DISCUSS_TEXT characters, the context cut
// to fit (the head is short and capped, the question and the prompt are never cut). It always starts
// with `About:`, so the send gate's refusal of a leading `/`, `!`, `#` or `&` (a slash command or a
// bash line typed into Claude) can never fire on it, whatever the title or context say.
import {
  DISCUSS_NEW_WINDOW_MS,
  MAX_DISCUSS_NEW_SESSIONS,
  MAX_DISCUSS_PROMPT,
  MAX_DISCUSS_QUESTION,
  MAX_DISCUSS_TEXT,
  MAX_DISCUSS_TYPE_LINE,
  type DiscussTarget
} from '../../shared/discuss'
import { errorText } from '../../shared/error-text'
import type { DiscussAnswer } from '../../shared/ipc'
import type { CleanOverlayType } from '../../shared/overlay-buttons'
import type { ViewId } from '../../shared/views'
import type { DiscussSessions } from './overlay-manager'

/**
 * A write guest's Discuss (03e A, B; design-guests §4): the router builds it from the caller it bound. The text is
 * sent only if `allowed` still holds right before the send (the guest kicked, made read-only or the target tab
 * unshared while its plugin was asked: nothing goes), and a queued text carries `id` so the session registry checks
 * again when the gate dequeues it. A new session opens through `openTab` (IpcRouter.openGuestTab: D-21's cap and
 * reservation, tagged as the guest's, noted after a re-check). The tab is then selected in `viewId` only.
 */
export interface DiscussGuest {
  id: string
  viewId: ViewId
  /** Still a write guest of the project that sees `target` (a tab) now; false on any doubt. */
  allowed(target: DiscussTarget): boolean
  /**
   * An overlay's Discuss (IpcRouter.discussGuest with the overlay): still this write guest, and the overlay still
   * visible to it (guest-wiring.ts overlayVisibleOf: its origin, every plugin of its `via`, its hides), read live.
   * The opener's context may arrive after `via` grew with a plugin hidden from the guest (its copy released), and
   * that plugin's content must not reach a shared tab through the guest's Send (codex review, finding 3). Absent on
   * an overlay's Discuss: refused (OverlayManager.discuss, fail closed).
   */
  seesOverlay?(): boolean
  openTab<T>(liveTabs: readonly string[], create: () => Promise<T>, idOf: (tab: T) => string, close: (tabId: string) => void): Promise<T | null>
}

/** What a guest's Discuss answers when its access changed before the send. */
export const GUEST_DISCUSS_REFUSED = 'Not sent: your access changed'

export interface DiscussParts {
  /** The overlay's title (any text: it is made one line here). */
  title: string
  /** The overlay's type, if it has one. */
  type?: CleanOverlayType
  /** What the opener's onDiscuss answered (absent or empty: no extra context). */
  context?: string
  /**
   * The person's question (Ask Claude from a page tab, design-editor.md §4), after the context and
   * before the closing prompt; never cut (the box caps it at MAX_DISCUSS_QUESTION). Blank: none.
   */
  question?: string
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
  const question = parts.question?.trim() ? parts.question.trim().slice(0, MAX_DISCUSS_QUESTION) : undefined
  if (context !== undefined) {
    // What the head, the question, the prompt and the blank lines around the context leave for it.
    const fixed =
      headText.length + 2 + (question !== undefined ? question.length + 2 : 0) + (prompt !== undefined ? prompt.length + 2 : 0)
    const room = MAX_DISCUSS_TEXT - fixed
    if (context.length > room) {
      const keep = room - CUT_MARK.length
      context = keep > 0 ? `${context.slice(0, keep).trimEnd()}${CUT_MARK}` : undefined
    }
  }
  return [headText, context, question, prompt].filter((p): p is string => p !== undefined).join('\n\n')
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

/**
 * Why `target` would not take a Discuss text now, or undefined. Checked when the request arrives and
 * again just before the send: the context ask may take seconds, and the tab may close meanwhile.
 * One rule for overlay Discuss and a page tab's Ask Claude (page-tab-discuss.ts).
 */
export function discussTargetProblem(sessions: DiscussSessions, windowId: number, target: DiscussTarget): string | undefined {
  if (target.kind !== 'tab') return undefined
  if (!sessions.isClaudeTab(windowId, target.tabId)) return 'That Claude tab is gone; pick another'
  if (sessions.notReady(target.tabId)) return 'That session is idle and would not take the text until you run a prompt in it; pick another'
  return undefined
}

/**
 * The context in a plugin's Discuss answer: `{ text }` is the text, null or undefined is none
 * (`{ context: undefined }`); any other shape is undefined, and the caller sends nothing.
 */
export function discussContextOf(answer: unknown): { context: string | undefined } | undefined {
  if (answer === null || answer === undefined) return { context: undefined }
  const text = (answer as { text?: unknown }).text
  if (typeof answer !== 'object' || typeof text !== 'string') return undefined
  return { context: text }
}

/**
 * The send itself, shared by overlay Discuss and a page tab's Ask Claude: a tab target goes through
 * the send gate as `core` origin (the person typed the question and pressed Send, so their own
 * typing in the tab neither refuses it nor drops it from the queue, send-gate.ts takenOver); a new
 * session is taken from `budget` (refunded when the open fails) and gets the text as its first argv,
 * so it waits for Claude to start, never in the gate (`queued` false). The caller selects the tab.
 */
export async function deliverDiscuss(
  sessions: DiscussSessions,
  budget: DiscussSessionBudget,
  windowId: number,
  target: DiscussTarget,
  text: string,
  guest?: DiscussGuest
): Promise<DiscussAnswer> {
  // A guest's access is read again right before the send (03e A): what changed while its plugin was asked counts.
  if (guest !== undefined && !guest.allowed(target)) return { ok: false, error: GUEST_DISCUSS_REFUSED }
  if (target.kind === 'tab') {
    try {
      const sent = guest === undefined ? sessions.send(target.tabId, text, 'core') : sessions.send(target.tabId, text, 'core', guest.id)
      return { ok: true, tabId: target.tabId, queued: !sent.delivered }
    } catch (err) {
      return { ok: false, error: `Not sent: ${errorText(err)}` }
    }
  }
  if (!budget.take(windowId)) return { ok: false, error: 'Too many new sessions from Discuss in the last minute; try again shortly' }
  try {
    if (guest === undefined) return { ok: true, tabId: (await sessions.openSession(windowId, text)).tabId, queued: false }
    // D-21 (03e B): the guest's new session is one of its tabs, under its cap, tagged and noted as such.
    const { liveTabs, closeTab } = sessions
    if (!liveTabs || !closeTab) throw new Error('not available')
    const opened = await guest.openTab(
      liveTabs(windowId),
      () => sessions.openSession(windowId, text, guest.id),
      (o) => o.tabId,
      (tabId) => closeTab(windowId, tabId)
    )
    if (opened === null) throw new Error('nothing opened')
    return { ok: true, tabId: opened.tabId, queued: false }
  } catch (err) {
    budget.refund(windowId)
    return { ok: false, error: `No new session: ${errorText(err)}` }
  }
}
