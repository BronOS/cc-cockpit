// Core notices: what the app itself has to tell the person, with no plugin behind it: a new device
// signed in to web access, a plugin the marketplace revoked, a newer release, many failed sign-ins,
// a `ccc web` change of who may get in (design-web.md §9.9).
//
// On the desktop each one is an OS notification, as before. In server mode there is no desktop to
// notify and no browser may be attached, so each is one line on stdout (the journal under systemd, the
// terminal otherwise) and is kept for `ccc web status`, which lists the recent ones. The ones about
// access (PAGE_KINDS: a new device, failed sign-ins, a `ccc web` change) are also an in-page notice in
// every browser view (`page`, the notifier's in-page backend, ViewRegistry.toBrowserViews), titled as
// the app's own: on a server the browsers are the only screen, and a device the person does not know,
// or access widened from a shell, must be seen where they look, not only in a journal. Every browser
// view of a server is a signed-in owner device that lists the devices on its own card (§9.6), so the
// device name reaches nobody new. The rest (a revoked plugin, an update) stay stdout lines.
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

/** The kinds that also go to every browser view as an in-page notice in server mode (see the header). */
export const PAGE_KINDS: readonly CoreNoticeKind[] = ['new-device', 'sign-in-failures', 'access-changed']
/** An in-page core notice's title when the caller gave none. */
export const CORE_PAGE_TITLE = 'cc-cockpit web access'

export interface CoreNoticesOptions {
  /** Main's `server` flag for the run. */
  server: boolean
  /** The desktop's OS notification (main's showNotification); not called in server mode. */
  desktop(text: string, title: string | undefined): void
  /**
   * Server mode: an in-page notice in every browser view (main's notifier with its in-page backend),
   * for PAGE_KINDS only. Absent: none (a test, or the desktop).
   */
  page?(text: string, title: string): void
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
    if (!PAGE_KINDS.includes(input.kind)) return
    try {
      this.options.page?.(text, input.title ?? CORE_PAGE_TITLE)
    } catch {
      // The stdout line and the status entry are written; a failed in-page copy must not undo them.
    }
  }

  /** The notices of this run, oldest first; empty on the desktop (its notices are the OS's). */
  list(): CoreNotice[] {
    return this.kept.map((n) => ({ ...n }))
  }
}
