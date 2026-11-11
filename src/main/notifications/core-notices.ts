// Core notices: what the app itself has to tell the person, with no plugin behind it: a new device
// signed in to web access, a plugin the marketplace revoked, a newer release (design-web.md §9.9).
//
// On the desktop each one is an OS notification, as before. In server mode there is no desktop to
// notify and no browser may be attached, so each is one line on stdout (the journal under systemd, the
// terminal otherwise) and is kept for `ccc web status`, which lists the recent ones. Never an in-page
// notice there: those are for plugins (`ctx.notify`, `ccc notify`, notifier.ts), and a core notice must
// not be taken for one, nor widen who reads a device name.
//
// A line holds only what main made or checked itself: a device's name (the browser's own text, made
// plain here), a plugin id, a version. Never an access link, a token, a password, or text a plugin or
// a marketplace index wrote (a revocation's reason stays in the Plugins page).
import type { WebCliNotice } from '../../shared/web-access'
import { plainText } from '../web/access-log'

/** One notice as `ccc web status` lists it: one plain line, a time, and a new device's id. */
export type CoreNotice = WebCliNotice
export type CoreNoticeKind = CoreNotice['kind']

/** What a caller passes: `title` is the desktop notification's, `device` the new device's id. */
export interface CoreNoticeInput {
  kind: CoreNoticeKind
  text: string
  title?: string
  device?: string
}

/** Notices kept for `status`, newest last; a long-running server must not grow without bound. */
export const MAX_CORE_NOTICES = 50
/** Longest line: a device name is capped by the store, the rest is ours, so this is only a bound. */
export const MAX_CORE_NOTICE_LINE = 300
/** The prefix of a stdout line, so a journal line says whose it is. */
export const CORE_NOTICE_PREFIX = 'cc-cockpit: '

export interface CoreNoticesOptions {
  /** Main's `server` flag for the run. */
  server: boolean
  /** The desktop's OS notification (main's showNotification); not called in server mode. */
  desktop(text: string, title: string | undefined): void
  /** One stdout line (console.log); not called on the desktop. */
  out(line: string): void
  now?: () => number
}

export class CoreNotices {
  private readonly kept: CoreNotice[] = []
  private readonly now: () => number

  constructor(private readonly options: CoreNoticesOptions) {
    this.now = options.now ?? Date.now
  }

  show(input: CoreNoticeInput): void {
    if (!this.options.server) {
      this.options.desktop(input.text, input.title)
      return
    }
    const text = plainText(input.text, MAX_CORE_NOTICE_LINE)
    if (text === '') return
    const notice: CoreNotice = { kind: input.kind, text, at: this.now() }
    if (input.device !== undefined) notice.device = plainText(input.device)
    this.kept.push(notice)
    if (this.kept.length > MAX_CORE_NOTICES) this.kept.splice(0, this.kept.length - MAX_CORE_NOTICES)
    this.options.out(`${CORE_NOTICE_PREFIX}${text}`)
  }

  /** The notices of this run, oldest first; empty on the desktop (its notices are the OS's). */
  list(): CoreNotice[] {
    return this.kept.map((n) => ({ ...n }))
  }
}
