// The send-text gate: when text may be typed into a Claude session, and the queue it waits in
// until then (plan: Technical Details > Send-text gate; design §3 "Sending text into a session").
//
// THE core safety rule of the app (CLAUDE.md): never type into a Claude session unless its status
// is *waiting for input*. Any other screen may be a dialog that a keystroke answers: the
// permission prompt or a question / plan-approval dialog (needs-permission; a dialog tool's
// PreToolUse enters it, status-reducer.ts), the trust-folder dialog right after start (starting,
// idle: "Idle is not sendable" in the plan), a turn in progress (working). So:
//   - the ONLY state that may receive text is `waiting`, and only while no earlier paste is still
//     in flight (`delivering`);
//   - a delivery happens on exactly two occasions: a `send` that finds the tab sendable, and a
//     `Stop` (one queue item per Stop; the rest wait for later Stops);
//   - nothing else delivers: not an idle Notification that promotes a tab to waiting, not the
//     `delivering` timeout, not a restart.
//
// `delivering` closes the window between our paste and Claude's UserPromptSubmit for it. The
// status is still `waiting` then, so without the flag a second Stop (or a second send) would type
// a second message into the input box on top of the first. It clears on the next
// UserPromptSubmit, or after DELIVERING_TIMEOUT_MS (the registry owns that timer and logs it).
//
// Pure: no clock, no ids, no I/O. The registry hands in item ids, applies the returned entry and
// writes `write` to the PTY. What it never allows is a write in any status but waiting.
//
// Residuals the gate cannot see (Task 27 and the plugin docs must not assume more than this):
//   - a typing user can race a delivery (no view of keystrokes); the plan accepts that;
//   - delivery is synchronous inside our Stop hook. If another Stop hook of the user returns
//     decision "block" (loop-style plugins), Claude keeps working and the paste lands mid-turn;
//   - a permission dialog raised while the main agent is waiting (background task, subagent) is on
//     screen before its Notification(permission_prompt) reaches main, possibly seconds before
//     (claude 2.1.314 has a 6 s notify timer for it). The tool's PreToolUse fires BEFORE the permission check and the
//     reducer moves any live status to working on it, so once main has read that hook the gate
//     holds the text; no extra "recent PreToolUse" rule is needed. What is left: a send that main
//     handles between the hook's write and its read, a PreToolUse that never arrived (no socket,
//     `ccc hook` gave up at its 500 ms cap) and a dialog no tool hook precedes (an MCP
//     elicitation). A send there lands in the dialog, and NOT harmlessly: the paste is one chunk,
//     but pasteBytes puts the Enter AFTER the end marker, so it is a real key that confirms the
//     highlighted option, which can approve a permission;
//   - an item can stay queued while the tab sits in waiting with nothing in flight: the delivering
//     timeout, a failed PTY write (item re-queued) and an idle_prompt promotion deliver nothing
//     (Claude is already at its prompt, so no Stop comes until the user runs a turn). This is a
//     deliberate safety choice: idle-Notification waiting is sendable by a direct send(), but never
//     auto-delivers; a later send() then types the older head and reports delivered:false for its
//     own item.
import type { ReducerEvent, QueuedText, SessionEntry } from './status-reducer'

/** Bracketed paste markers (xterm): what is between them arrives as one paste, not as keys. */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

/** How long a delivery may wait for its UserPromptSubmit before the flag is dropped (logged). */
export const DELIVERING_TIMEOUT_MS = 10_000

/**
 * Not in the plan: plugins reach `send` in later tasks, and a queue is held in main per tab, so
 * neither the item count nor the text size may grow without bound. A bigger text is refused, not
 * cut: a silently truncated prompt is worse than an error.
 */
export const MAX_QUEUE = 50
export const MAX_TEXT_CHARS = 100_000

/** What one gate step decided. The registry applies `entry`, then writes `write` (if any). */
export interface GateStep {
  entry: SessionEntry
  /** Bytes for the tab's PTY: one framed paste plus Enter. Present only when status is waiting. */
  write?: string
  /** The queue item `write` carries (so the registry can put it back if the write fails). */
  delivered?: QueuedText
  /** Items thrown away because the session ended, oldest first. */
  dropped?: QueuedText[]
}

/**
 * Remove every paste marker. An embedded end marker would end the paste early and the rest would
 * be typed as KEYS (an Enter in it would submit, a `1` could answer a prompt). Removing one marker
 * can join the pieces of another (`ESC[20` + `ESC[200~` + `0~` collapses to `ESC[200~`), so a
 * single replace is not enough.
 *
 * One pass over a stack, linear in the input: each character is pushed once and popped at most
 * once. After every push the output so far holds no marker (a new one can only end at the char
 * just pushed, and popping it returns to an earlier, already marker-free state), so none survives.
 * It replaced a replace-until-stable loop, which nested markers (`ESC[20` x n + `0~` x n) drove
 * through n passes: a 440 KB plugin `send` held main's event loop, and every window, for 9 s.
 */
export function stripMarkers(text: string): string {
  const out: string[] = []
  // Both markers are ESC [ 2 0 x ~ with x = '0' (start) or '1' (end).
  const len = PASTE_START.length
  for (const ch of text) {
    out.push(ch)
    const n = out.length
    if (
      ch === '~' &&
      n >= len &&
      out[n - 6] === '\x1b' &&
      out[n - 5] === '[' &&
      out[n - 4] === '2' &&
      out[n - 3] === '0' &&
      (out[n - 2] === '0' || out[n - 2] === '1')
    ) {
      out.length = n - len
    }
  }
  return out.join('')
}

/** The bytes one delivery writes: the text as a single bracketed paste, then Enter to submit. */
export function pasteBytes(text: string): string {
  return PASTE_START + stripMarkers(text) + PASTE_END + '\r'
}

/**
 * Defense in depth on top of the markers: a prompt never needs ESC or other control bytes, and the
 * only thing that keeps pasted text from being read as keys is Claude's paste parser. Remove all C0
 * controls except tab and newline, DEL and the C1 range (U+009B is an 8-bit CSI). CR and CRLF
 * become a newline first. Plugin text can be third-party content (a Jira or Gmail body).
 */
export function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

/**
 * Policy for a leading Claude input-mode prefix: text whose first non-blank character is `/`
 * (slash command, may run a pre-approved custom command), `!` (bash mode, no permission prompt),
 * `#` (memory: written into a CLAUDE.md, where it steers every later session) or `&` (hand the
 * prompt to a background/remote session) is REFUSED. Which prefixes the installed Claude honours
 * varies by version, so the list errs wide: each acts without a permission prompt, only a
 * `waiting` status is needed to submit it, and the gate is the chokepoint for every programmatic
 * send. The cost is that a plugin cannot send text opening with a Markdown `#` heading; it can
 * lead with any other character. Refusing beats rewriting: a caller that really wants a command
 * must say so through a future explicit API, not through free text.
 */
const MODE_PREFIX = /^\s*[/!#&]/

/**
 * Validate and clean text handed to `send`. Throws for anything that must not be queued: not a
 * string, empty after stripping (an empty paste plus Enter does nothing useful), starting with a
 * slash-command, bash-mode, memory or background prefix (MODE_PREFIX), or too long.
 *
 * The length cap applies to the text as given, before any cleaning: what main spends on cleaning
 * is then bounded by the cap rather than by the RPC size, and text that would only fit after
 * markers or control bytes are stripped is refused, not cut (a CRLF text near the cap included).
 */
export function prepareText(text: unknown): string {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (text.length > MAX_TEXT_CHARS) throw new Error(`text is longer than ${MAX_TEXT_CHARS} characters`)
  const clean = stripMarkers(stripControls(stripMarkers(text)))
  if (clean.trim() === '') throw new Error('text is empty')
  if (MODE_PREFIX.test(clean)) throw new Error('text must not start with "/", "!", "#" or "&"')
  return clean
}

/** The one question that guards every PTY write of this module. */
export function maySend(entry: SessionEntry): boolean {
  return entry.status === 'waiting' && !entry.delivering && entry.exitCode === undefined
}

/**
 * Queue `item` (already prepared), then deliver the queue head if the tab may take text now.
 * Appending first keeps the order: an older item queued while busy goes before this one. Throws
 * when the session has ended (the item would only be dropped) or the queue is full.
 */
export function send(entry: SessionEntry, item: QueuedText): GateStep {
  if (entry.status === 'ended') throw new Error('the session has ended')
  if (entry.queue.length >= MAX_QUEUE) throw new Error(`the queue is full (${MAX_QUEUE} items)`)
  return deliverHead({ ...entry, queue: [...entry.queue, item] })
}

/** Remove a queued item by id; undefined when no such item is queued (already sent, or never). */
export function cancel(entry: SessionEntry, itemId: string): GateStep | undefined {
  const queue = entry.queue.filter((q) => q.id !== itemId)
  if (queue.length === entry.queue.length) return undefined
  return { entry: { ...entry, queue } }
}

/**
 * Gate step after the reducer applied `event` (`entry` is the reduced entry). In order:
 *   - an ended session drops its queue and any delivery in flight (reported as `dropped`);
 *     `ended` covers a PTY exit and a SessionEnd (plan: "queue cleared when the tab ends"),
 *   - UserPromptSubmit closes the delivery in flight,
 *   - Stop delivers the queue head when the tab may take text.
 * Every other event only passes the entry through: a Notification never delivers, even when it
 * moves the tab to waiting (idle_prompt) and the queue is not empty; the next Stop does.
 */
export function afterEvent(entry: SessionEntry, event: ReducerEvent): GateStep {
  if (entry.status === 'ended') {
    if (entry.queue.length === 0 && !entry.delivering) return { entry }
    const step: GateStep = { entry: { ...entry, queue: [], delivering: false } }
    if (entry.queue.length > 0) step.dropped = entry.queue
    return step
  }
  if (event.type !== 'hook') return { entry }
  if (event.event === 'UserPromptSubmit') {
    return entry.delivering ? { entry: { ...entry, delivering: false } } : { entry }
  }
  if (event.event === 'Stop') return deliverHead(entry)
  return { entry }
}

/**
 * The delivery got no UserPromptSubmit in time (the paste landed somewhere Claude did not submit,
 * or the hook was lost). Only the flag clears; this must not deliver the next item by itself, or a
 * stuck paste would be followed by a second one into the same input box. The next Stop (or send)
 * decides again.
 */
export function deliveringTimedOut(entry: SessionEntry): SessionEntry {
  return entry.delivering ? { ...entry, delivering: false } : entry
}

function deliverHead(entry: SessionEntry): GateStep {
  const [head, ...rest] = entry.queue
  if (head === undefined || !maySend(entry)) return { entry }
  return {
    entry: { ...entry, queue: rest, delivering: true },
    write: pasteBytes(head.text),
    delivered: head
  }
}
