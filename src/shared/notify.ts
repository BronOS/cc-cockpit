// ctx.notify(text, options): what a plugin may ask of a system notification (design §5
// "Notifications"). One rule for both sides, like panel-header.ts: the host checks a call here so
// the plugin gets a TypeError at its call site, and main checks the same request again with the
// same function, because main never trusts what a host sends. The OS gets only main's cleaned copy.
//
// Kept free of Node and DOM imports: the host bundle, main and the tests all import it.
import { isPlainObject } from './guards'
import { APP_DEFAULT_SOUND, MAX_SOUND_ID_LENGTH } from './notify-sound'

/** Notification body as main shows it; longer text is cut (with an ellipsis), not refused. */
export const MAX_NOTIFY_TEXT = 500
/** `options.title`; a longer one is refused (a TypeError), like a panel header's action title. */
export const MAX_NOTIFY_TITLE = 80
/** `options.action.label`: one short button text ("Join"). */
export const MAX_NOTIFY_ACTION_LABEL = 40
/**
 * How long main waits for a click on a notification with an `action` before it closes it and the
 * call resolves `{ clicked: false }`. Bounded because the OS does not always say a notification went
 * away (Electron: `close` "is not guaranteed to be emitted"), and an unbounded wait would keep the
 * call, its listeners and the native object alive for as long as the window is open.
 */
export const NOTIFY_ACTION_WAIT_MS = 10 * 60_000
/** At most one chime per window in this long: ten plugins reminding at 09:00 make one sound. */
export const NOTIFY_CHIME_INTERVAL_MS = 5_000
/**
 * In-page notices main keeps per window in server mode (design-web.md §9.9; notifier.ts
 * PageNoticeBackend), and as many again for the app-wide ones (`ccc notify` naming no project): a
 * notice stays until it is clicked, dismissed or timed out, so a browser that joins later still sees
 * it, and the cap bounds what main holds and replays. A new one past the cap ends the oldest of its
 * window as a dismissal would (`{ clicked: false }`).
 */
export const MAX_PAGE_NOTICES = 20

/**
 * One in-page notice as a browser view gets it (`notices.show`, the `ready` snapshot's `notices`).
 * Plain text only: the page renders the strings as text, never as HTML.
 */
export interface PageNotice {
  requestId: string
  title: string
  text: string
  /** The action button's label; absent: the notice has only its ✕. */
  action?: string
}

/**
 * Checked options; `sound` is always there: false (none), true (the app's sound) or the sound id a
 * plugin asked for. That id is only spelled within MAX_SOUND_ID_LENGTH here: whether it is one of
 * the app's sounds is main's question at the ring (notifier.ts NotifySounds), so an id this app
 * does not know (a built-in of a later release, a sound file that went away) rings the app's sound
 * instead of failing the call.
 */
export interface CleanNotifyOptions {
  title?: string
  sound: boolean | string
  action?: { label: string }
}

/** What a plugin's call resolves with. */
export interface NotifyOutcome {
  clicked: boolean
}

/** Control characters out: a newline in a title or a button label would break it. Each becomes a space. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
}

/** `text` with at most `max` characters, the last one an ellipsis when it was cut. */
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * The texts of an in-page notice as main sends them: each control character a space, except that the
 * body keeps its line breaks (the page shows them, as an OS notification does); the body cut at
 * MAX_NOTIFY_TEXT, the title at MAX_NOTIFY_TITLE and the label at MAX_NOTIFY_ACTION_LABEL. A plugin's
 * request was already checked (parseNotifyOptions refuses a long title); `ccc notify` and the core
 * notices were not, so the cut is applied to every notice here, once.
 */
export function pageNoticeTexts(spec: { title: string; body: string; actionLabel?: string }): Omit<PageNotice, 'requestId'> {
  // eslint-disable-next-line no-control-regex
  const body = spec.body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').trim()
  const out: Omit<PageNotice, 'requestId'> = {
    title: cut(plain(spec.title), MAX_NOTIFY_TITLE) || 'cc-cockpit',
    text: cut(body, MAX_NOTIFY_TEXT)
  }
  if (spec.actionLabel !== undefined) {
    const label = cut(plain(spec.actionLabel), MAX_NOTIFY_ACTION_LABEL)
    if (label !== '') out.action = label
  }
  return out
}

function fail(message: string): never {
  throw new TypeError(`notify: ${message}`)
}

/** A short single-line text: non-empty after the control characters go, at most `max` chars. */
function shortText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') fail(`${what} must be a string`)
  const text = plain(value)
  if (text === '') fail(`${what} must not be empty`)
  if (text.length > max) fail(`${what} is over ${max} characters`)
  return text
}

/**
 * The options of a `ctx.notify(text, options)` call, checked. `undefined` is no options. Throws a
 * TypeError naming the broken rule: not an object, a title that is not a string, empty or over 80
 * characters, a `sound` that is neither a boolean nor a string of at most MAX_SOUND_ID_LENGTH, an
 * `action` that is not `{ label }` with a label of 1 to 40 characters. Unknown keys are ignored, as
 * in plugin.json, so a later release can add some. `sound: ""` is `true`: it is what a
 * `"format": "sound"` settings field left at "App default" holds, passed on as it is.
 */
export function parseNotifyOptions(value: unknown): CleanNotifyOptions {
  if (value === undefined) return { sound: false }
  if (!isPlainObject(value)) fail('options must be an object')
  const { title, sound, action } = value
  const out: CleanNotifyOptions = { sound: false }
  if (title !== undefined) out.title = shortText(title, 'title', MAX_NOTIFY_TITLE)
  if (sound !== undefined) {
    if (typeof sound === 'string') {
      if (sound.length > MAX_SOUND_ID_LENGTH) fail(`sound is over ${MAX_SOUND_ID_LENGTH} characters`)
      out.sound = sound === APP_DEFAULT_SOUND ? true : sound
    } else if (typeof sound === 'boolean') out.sound = sound
    else fail('sound must be true, false or a sound id (a "format": "sound" setting\'s value)')
  }
  if (action !== undefined) {
    if (!isPlainObject(action)) fail('action must be an object { label }')
    out.action = { label: shortText(action.label, 'action.label', MAX_NOTIFY_ACTION_LABEL) }
  }
  return out
}

/** Main's answer to a `notify` request, as the host reads it: anything but `{ clicked: true }` is not a click. */
export function notifyOutcomeOf(value: unknown): NotifyOutcome {
  return { clicked: isPlainObject(value) && value.clicked === true }
}
