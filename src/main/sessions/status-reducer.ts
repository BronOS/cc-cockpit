// Tab status as a pure reducer: `(entry, event) -> entry` (plan: Technical Details > Tab status
// and session registry; design §3). No Electron, no I/O, no clock: the registry feeds it hook
// events in the order main received them and PTY exits.
//
// Ordering. Hook events carry no timestamp or sequence number. They arrive in Claude's order only
// because every hook in hooks.json is synchronous (hooks-file.ts: Claude waits for `ccc`, which
// exits after its write is in the kernel). So the caller must apply this reducer synchronously at
// dispatch, before any `await`, and nothing here sorts or compares times. If `async` is ever
// switched on for a hook, this file needs a reliable ordering first.
//
// Deliberately absent: any "ignore tool events while needs-permission / waiting" rule.
// `PreToolUse` fires BEFORE the permission check, so after an approval the next event is the
// tool's `PostToolUse` (file tools only, per the matcher) or the next tool's `PreToolUse`; if
// those were ignored the tab would stay in needs-permission for the rest of the turn. A rule like
// that would only paper over a reordering that synchronous hooks already rule out.
//
// Leaving needs-permission at the approval itself. Claude has no hook for a dialog being answered
// (claude 2.1.314 lists PermissionRequest, which fires when the dialog opens, and
// PermissionDenied, for an auto-mode refusal; nothing on approval), and PostToolUse fires when the
// tool ENDS. So after the user approves a 10-minute `npm test`, no hook arrives for 10 minutes and
// the strip would keep sorting the tab first as blocked on the user. Registering PostToolUse for
// every tool (a review suggestion) would not help that case and would cost ~90 ms per tool call.
// The one signal main has is the keystroke that answers the dialog, typed in the tab's terminal:
// the `answer` event (isAnswerKey). Both states are non-sendable, so a wrong guess can never make
// the gate type anything; the next Notification(permission_prompt) puts the tab back.
//
// Dialog tools (AskUserQuestion, ExitPlanMode: shared/hooks.ts DIALOG_TOOLS). Their call is a
// dialog the user answers, so their PreToolUse enters needs-permission right away (the incident:
// the strip showed "working · AskUserQuestion" while Claude sat blocked on a question, and a
// plugin's send would have been typed into it had the status been waiting). No Notification
// arrives for them, so the PreToolUse is the only signal. They leave it on their own PostToolUse
// (registered for them: the tool ends the moment the dialog is answered) or on any later hook,
// like a permission prompt, but NOT on an answer key: a question dialog with several questions
// takes one Enter per question plus a submit screen, and a multi-select toggles with Enter, so
// the first key proves nothing. The known gap: a PreToolUse/PostToolUse of a BACKGROUND subagent
// while the dialog is up moves the tab to working (no ignore rule, as above). Working is not
// sendable either, so this costs display accuracy, never a keystroke.
import { SESSION_ID } from '../tabs/claude-argv'
import { isPlainObject } from '../../shared/guards'
import { isDialogTool, type HookEvent } from '../../shared/hooks'
import { unwrapPastes } from './paste-wrappers'
import type { TabStatus } from '../../shared/ipc'
import type { TabKind } from '../../shared/types'

export type { TabStatus }

/** Text queued for a tab until the send gate may deliver it (send-gate.ts). */
export interface QueuedText {
  id: string
  text: string
}

export interface SessionEntry {
  tabId: string
  projectId: string
  /** Only Claude tabs have a registry entry (a shell tab has no status to track). */
  kind: TabKind
  cwd: string
  sessionId?: string
  status: TabStatus
  tool?: string
  lastPrompt?: string
  /** Free-form notes (plugins add them in later tasks); capped at MAX_NOTES x MAX_NOTE_CHARS. */
  notes: string[]
  steps?: { done: number; total: number }
  /** Files changed this tab, in the order first reported, as reported (never resolved). */
  files: string[]
  queue: QueuedText[]
  /**
   * A paste was written and its UserPromptSubmit has not arrived yet: nothing more may be typed
   * (send-gate.ts). The reducer never touches it; the gate step after each event does.
   */
  delivering: boolean
  /** Set by a PTY exit; an ended entry with an exit code is final (see reduce). */
  exitCode?: number
}

/** Caps for text a hook (or a plugin) hands us: a token only proves WHICH tab sent it. */
export const MAX_PROMPT_CHARS = 2048
export const MAX_TOOL_CHARS = 100
export const MAX_FILES = 500
export const MAX_NOTES = 20
export const MAX_NOTE_CHARS = 500
/** Largest `total` (and `done`) of `ccc session steps`: a progress counter, not a data channel. */
export const MAX_STEPS = 1_000_000
/** Not in the plan: 500 files of up to 1 MiB each (the request line cap) would still be 500 MiB. */
export const MAX_PATH_CHARS = 4096

export type ReducerEvent =
  | { type: 'hook'; event: HookEvent; payload: unknown }
  | { type: 'exit'; code: number }
  /** The user pressed a key that answers a permission dialog (isAnswerKey). */
  | { type: 'answer' }

/**
 * Whether one renderer input chunk is a key that answers Claude's permission dialog: Enter
 * (confirms the highlighted option) or a lone digit 1-9 (picks an option). xterm sends a typed key
 * as its own chunk, so the whole chunk must be that key: arrow keys (`ESC [ A`), focus reports
 * (`ESC [ I`, sent just by switching to the tab) and mouse reports only move or look, and a paste
 * is not an answer. Esc is left out on purpose: it denies and drops Claude back to its prompt, and
 * `working` would then hide a tab that is waiting for the user, which `needs-permission` at least
 * flags until the next turn. An Enter on "No" has the same gap; accepted.
 */
export function isAnswerKey(data: string): boolean {
  return data === '\r' || /^[1-9]$/.test(data)
}

/** A fresh entry for a tab whose process was just started. */
export function newEntry(init: {
  tabId: string
  projectId: string
  kind: TabKind
  cwd: string
  sessionId?: string
}): SessionEntry {
  const entry: SessionEntry = {
    tabId: init.tabId,
    projectId: init.projectId,
    kind: init.kind,
    cwd: init.cwd,
    status: 'starting',
    notes: [],
    files: [],
    queue: [],
    delivering: false
  }
  if (init.sessionId !== undefined) entry.sessionId = init.sessionId
  return entry
}

export function reduce(entry: SessionEntry, event: ReducerEvent): SessionEntry {
  if (event.type === 'exit') return exited(entry, event.code)
  // Only out of needs-permission: from any other status the key was ordinary typing (a prompt's
  // Enter is followed by UserPromptSubmit anyway), and an ended entry stays ended. Not out of a
  // dialog tool's needs-permission either: one key may not finish that dialog (header).
  if (event.type === 'answer') {
    return entry.status === 'needs-permission' && !isDialogTool(entry.tool)
      ? { ...entry, status: 'working' }
      : entry
  }
  // An entry that ended with an exit code belongs to a dead process: nothing a late hook says
  // revives it (a restart makes a new entry). One that ended through SessionEnd alone may still
  // continue: `/clear` fires SessionEnd and then SessionStart in the same process.
  if (entry.status === 'ended') {
    if (entry.exitCode !== undefined || event.event !== 'SessionStart') return entry
  }
  const payload = isPlainObject(event.payload) ? event.payload : {}

  switch (event.event) {
    case 'SessionStart': {
      // Auto-compaction fires SessionStart with `source: "compact"` in the middle of a turn (the
      // hook has no matcher, so every source reaches us). The turn goes on, so a working tab
      // stays working with its tool: `idle` would show it as quiet until the next PreToolUse or
      // Stop, possibly a long model turn later. Verified in claude 2.1.314 (no live session):
      // the source enum is startup|resume|clear|compact|fork, and the compact call passes no
      // session id, so the payload carries the live session's own id and
      // TabManager.sessionStarted sees a repeat (no resume-id change). Only `working` is kept:
      // when a manual `/compact` fires it relative to the prompt is not established, so other
      // statuses go to the non-sendable `idle` as before.
      const compactMidTurn = payload.source === 'compact' && entry.status === 'working'
      const next: SessionEntry = compactMidTurn ? { ...entry } : { ...entry, status: 'idle', tool: undefined }
      const id = payload.session_id
      // Same check as claude-argv: a bad id stored here would make the tab impossible to restart.
      if (typeof id === 'string' && SESSION_ID.test(id)) next.sessionId = id
      return next
    }
    case 'UserPromptSubmit': {
      const next: SessionEntry = { ...entry, status: 'working', tool: undefined }
      const prompt = payload.prompt
      // Unwrapped before the cap: a long paste would lose its closing tag to the cut, and the
      // opener would then stay.
      if (typeof prompt === 'string') next.lastPrompt = cap(unwrapPastes(prompt), MAX_PROMPT_CHARS)
      return next
    }
    case 'PreToolUse': {
      const tool = payload.tool_name
      // A dialog tool blocks on the user from this very event (header): never `working`, and
      // never anything sendable.
      const next: SessionEntry = { ...entry, status: isDialogTool(tool) ? 'needs-permission' : 'working' }
      if (typeof tool === 'string' && tool !== '') next.tool = cap(tool, MAX_TOOL_CHARS)
      return next
    }
    case 'PostToolUse': {
      const next: SessionEntry = { ...entry, status: 'working' }
      // The dialog was answered and Claude goes on thinking: "working · AskUserQuestion" would
      // read as the question still being up. Other tools keep their name until the next one, as
      // before (a file tool's PostToolUse is the only other one registered).
      if (isDialogTool(payload.tool_name) && entry.tool === payload.tool_name) next.tool = undefined
      const file = changedFile(payload)
      if (file !== undefined && !entry.files.includes(file) && entry.files.length < MAX_FILES) {
        next.files = [...entry.files, file]
      }
      return next
    }
    case 'Notification': {
      const status = notificationStatus(payload, entry.status)
      return status === undefined ? entry : { ...entry, status }
    }
    case 'Stop':
      return { ...entry, status: 'waiting', tool: undefined }
    case 'SessionEnd':
      return { ...entry, status: 'ended', tool: undefined }
    default:
      // Not a HookEvent (the socket handler refuses those first); a future Claude event must
      // not move a tab by guesswork.
      return entry
  }
}

function exited(entry: SessionEntry, code: number): SessionEntry {
  if (entry.status === 'ended' && entry.exitCode !== undefined) return entry
  return { ...entry, status: 'ended', tool: undefined, exitCode: code }
}

/**
 * Which status a Notification asks for, or undefined to leave it alone.
 *
 * Verified against claude 2.1.312 (the hook input schema embedded in the binary; no network and
 * no live session): the Notification input is `{ hook_event_name, message, title?,
 * notification_type }`, `notification_type` a string. Values seen in that binary: `permission_prompt`
 * and `idle_prompt` (the two we act on), `worker_permission_prompt`, `agent_needs_input`,
 * `elicitation_*`, `auth_*`, `computer_use_*`, `agent_completed`, `plugin_notification`,
 * `push_notification`. Only a field that is absent falls back to matching "permission" in
 * `message`; a present but unknown kind leaves the status unchanged, so a new kind can never make
 * a tab look permission-blocked (or, worse, sendable) by accident.
 */
function notificationStatus(payload: Record<string, unknown>, from: TabStatus): TabStatus | undefined {
  const kind = payload.notification_type
  if (typeof kind === 'string') {
    if (kind === 'permission_prompt') return 'needs-permission'
    // idle_prompt only promotes a quiet tab: it must never move needs-permission (or working)
    // to waiting, the one state in which the app types into the session. An interrupted prompt
    // recovers through the next Stop/UserPromptSubmit instead.
    if (kind === 'idle_prompt') {
      return from === 'starting' || from === 'idle' || from === 'waiting' ? 'waiting' : undefined
    }
    return undefined
  }
  const message = payload.message
  if (kind === undefined && typeof message === 'string' && /permission/i.test(message)) {
    return 'needs-permission'
  }
  return undefined
}

/**
 * The file a PostToolUse changed: `tool_input.file_path`, or `tool_input.notebook_path` for
 * NotebookEdit (its input has no `file_path`). Non-string, empty and absurdly long values are
 * ignored, not coerced. The path is kept exactly as reported: it is only displayed, and anything
 * that later runs a command on it passes it after `--` (a path may start with `-`).
 */
function changedFile(payload: Record<string, unknown>): string | undefined {
  const input = payload.tool_input
  if (!isPlainObject(input)) return undefined
  const path = payload.tool_name === 'NotebookEdit' ? input.notebook_path : input.file_path
  if (typeof path !== 'string' || path === '' || path.length > MAX_PATH_CHARS) return undefined
  return path
}

/**
 * Append a note (`ccc session note`). Text is trimmed and cut to MAX_NOTE_CHARS; blank text is
 * refused (throws). At MAX_NOTES the OLDEST note goes, so the list always ends with the newest
 * (the CLI's contract: "notes capped at 20, newest last").
 */
export function withNote(entry: SessionEntry, text: string): SessionEntry {
  const note = cap(text.trim(), MAX_NOTE_CHARS)
  if (note === '') throw new Error('note is empty')
  return { ...entry, notes: [...entry.notes, note].slice(-MAX_NOTES) }
}

/** Set the progress counter (`ccc session steps 3/5`); throws unless 0 <= done <= total, total >= 1. */
export function withSteps(entry: SessionEntry, done: unknown, total: unknown): SessionEntry {
  if (
    !Number.isSafeInteger(done) ||
    !Number.isSafeInteger(total) ||
    (done as number) < 0 ||
    (total as number) < 1 ||
    (done as number) > (total as number) ||
    (total as number) > MAX_STEPS
  ) {
    throw new Error(`steps must be done/total with 0 <= done <= total <= ${MAX_STEPS}`)
  }
  return { ...entry, steps: { done: done as number, total: total as number } }
}

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return text.slice(0, end)
}
