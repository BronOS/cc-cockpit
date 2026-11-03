// System notifications: `ccc notify`, a revoked plugin's notice, and ctx.notify (design §5
// "Notifications"). Pure logic over a NoticeBackend: Electron's `Notification` is only in
// electron-notification.ts (CLAUDE.md: Electron-only modules behind adapters), a test run uses the
// RecordingNoticeBackend below, and unit tests drive both with fake timers.
//
//   show   fire and forget (no listeners, nothing kept)
//   wait   a notification with an action: resolves true on a click on it or its button, false when
//          the OS says it closed or failed, when `waitMs` passes (then it is closed too, so a stale
//          one cannot be clicked into nothing), or when the caller's signal aborts (the plugin's ctx
//          ended, its host stopped). Settles once; every listener goes with the reference to it.
//
// Why the native object is kept in a Set while waiting: Electron drops a Notification's click
// handler once the JS object is garbage collected, and a reminder clicked after a GC would then
// never answer.
//
// The chime (ChimeGate): an OS notification sound is unreliable (most Linux daemons play none,
// macOS and Windows follow the person's per-app settings), so `sound: true` rings the person's
// picked sound (the "Sound" setting: a built-in tone or an OS sound file, system-sounds.ts) in the
// project window's renderer instead, the same on every OS, and the OS notification is made
// silent so there are never two sounds. Gated by the app setting "Notification sounds" (read at
// each ring, default on) and to one chime per NOTIFY_CHIME_INTERVAL_MS per window.
//
// Which sound (NotifySounds): `sound: true` is the picked one; a plugin may instead pass a sound id
// the person picked in its settings (`"format": "sound"`). That id is a claim like any request: it
// rings only when the app itself offers it now (a built-in, or a system file in a fresh listing,
// system-sounds.ts), else the picked sound rings and main logs it once. So a plugin reaches no file
// the Settings dropdown would not list, and a reminder never goes silent over a stale id.
import { NOTIFY_ACTION_WAIT_MS, NOTIFY_CHIME_INTERVAL_MS, type CleanNotifyOptions } from '../../shared/notify'
import { parseSoundId } from '../../shared/notify-sound'

/** What the OS is asked to show. */
export interface NoticeSpec {
  title: string
  body: string
  /** true: no OS sound. Absent: the platform's default, as before ctx.notify had options. */
  silent?: boolean
  /** One button (macOS and Windows show it; on Linux a click on the notification is the action). */
  actionLabel?: string
  /** Stays on screen until clicked or dismissed (Linux, Windows `timeoutType: 'never'`). */
  persistent?: boolean
}

/** One shown notification, as the backend hands it out. */
export interface NativeNotice {
  show(): void
  close(): void
  /** A click on the notification or on its button. */
  onClick(listener: () => void): void
  /** It closed (dismissed, timed out on the OS side) or could not be shown. */
  onClose(listener: () => void): void
}

export interface NoticeBackend {
  isSupported(): boolean
  create(spec: NoticeSpec): NativeNotice
}

/** A ctx.notify request as main checked it (host-manager.ts notifyFromHost). */
export interface PluginNotice extends CleanNotifyOptions {
  text: string
}

export class Notifier {
  /** Waiting notifications, held so the native object (and its click handler) lives until settled. */
  private readonly waiting = new Set<NativeNotice>()

  constructor(
    private readonly backend: NoticeBackend,
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {}

  /** Show and forget. A backend that throws is logged: a notice never breaks its caller. */
  show(spec: NoticeSpec): void {
    if (!this.backend.isSupported()) return
    try {
      this.backend.create(spec).show()
    } catch (err) {
      this.log(`notification failed: ${String(err)}`)
    }
  }

  /** Show and wait for a click (true) or its end (false); see the file header. Never rejects. */
  wait(spec: NoticeSpec, signal?: AbortSignal, waitMs = NOTIFY_ACTION_WAIT_MS): Promise<boolean> {
    if (signal?.aborted || !this.backend.isSupported()) return Promise.resolve(false)
    let notice: NativeNotice
    try {
      notice = this.backend.create(spec)
    } catch (err) {
      this.log(`notification failed: ${String(err)}`)
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      let done = false
      const settle = (clicked: boolean, close: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiting.delete(notice)
        if (close) {
          try {
            notice.close()
          } catch {
            // Already gone on the OS side; nothing to close.
          }
        }
        resolve(clicked)
      }
      const onAbort = (): void => settle(false, true)
      const timer = setTimeout(() => settle(false, true), waitMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      notice.onClick(() => settle(true, false))
      notice.onClose(() => settle(false, false))
      this.waiting.add(notice)
      try {
        notice.show()
      } catch (err) {
        this.log(`notification failed: ${String(err)}`)
        settle(false, false)
      }
    })
  }

  /** Notifications waiting for a click now (tests: nothing is left behind). */
  get pending(): number {
    return this.waiting.size
  }
}

/** The OS notification for a plugin's request; `fallbackTitle` is what a title-less one shows. */
export function pluginNoticeSpec(notice: PluginNotice, fallbackTitle: string): NoticeSpec {
  return {
    title: notice.title ?? fallbackTitle,
    body: notice.text,
    // The app's own chime is the sound (ChimeGate); an OS sound on top would ring twice where
    // the platform plays one. Without `sound` nothing changes from before options existed.
    ...(notice.sound !== false ? { silent: true } : {}),
    ...(notice.action ? { actionLabel: notice.action.label, persistent: true } : {})
  }
}

export interface ChimeGateDeps {
  /** The app setting "Notification sounds" (default on), read at each ring. */
  enabled(): boolean
  /** Tell this window's renderer to play the sound with this id (`notify.chime`). */
  ring(windowId: number, sound: string): void
  intervalMs?: number
  now?: () => number
}

/** One chime per window per interval, only while the setting is on. */
export class ChimeGate {
  private readonly last = new Map<number, number>()
  private readonly intervalMs: number
  private readonly now: () => number

  constructor(private readonly deps: ChimeGateDeps) {
    this.intervalMs = deps.intervalMs ?? NOTIFY_CHIME_INTERVAL_MS
    this.now = deps.now ?? Date.now
  }

  /** Ring `sound` in `windowId` unless the setting is off or it rang there within the interval. True when it rang. */
  ring(windowId: number, sound: string): boolean {
    if (!this.deps.enabled()) return false
    const now = this.now()
    const last = this.last.get(windowId)
    if (last !== undefined && now - last < this.intervalMs) return false
    // Entries older than the interval decide nothing any more: dropped, so the map holds only the
    // windows that rang recently, however many windows came and went.
    for (const [id, at] of this.last) if (now - at >= this.intervalMs) this.last.delete(id)
    this.last.set(windowId, now)
    this.deps.ring(windowId, sound)
    return true
  }
}

export interface NotifySoundsDeps {
  /** The app setting "Sound", default applied (notificationSoundOf), read at each call. */
  appSound(): string
  /** Whether a system id is in a fresh listing of the OS sound folders (SystemSounds.has). */
  systemHas(id: string): Promise<boolean>
  log?: (message: string) => void
}

/** Distinct refused (plugin, id) pairs remembered for the log-once rule; past it, nothing more is logged. */
const MAX_LOGGED_SOUNDS = 200

/** The sound a ctx.notify rings (see the file header). */
export class NotifySounds {
  private readonly logged = new Set<string>()

  constructor(private readonly deps: NotifySoundsDeps) {}

  /** The id to ring for `sound` (true or a plugin's id). Never rejects: any doubt rings the app's sound. */
  async resolve(sound: true | string, pluginId: string): Promise<string> {
    if (sound === true) return this.deps.appSound()
    const parsed = parseSoundId(sound)
    if (parsed?.kind === 'builtin') return sound
    let listed = false
    if (parsed?.kind === 'system') {
      try {
        listed = await this.deps.systemHas(sound)
      } catch {
        // A listing that failed is a sound not offered now.
      }
    }
    if (listed) return sound
    const key = `${pluginId}\n${sound}`
    if (!this.logged.has(key) && this.logged.size < MAX_LOGGED_SOUNDS) {
      this.logged.add(key)
      const log = this.deps.log ?? ((m: string) => console.warn(m))
      // The id as JSON: one line, whatever the plugin put in it.
      log(`notification sound ${JSON.stringify(sound.slice(0, 200))} of plugin ${pluginId} is not one the app offers now; the app's sound rings instead`)
    }
    return this.deps.appSound()
  }
}

/** One notification a test run recorded instead of showing (RecordingNoticeBackend). */
export interface RecordedNotice extends NoticeSpec {
  /** Still on screen as far as the backend knows (not clicked, closed or dismissed). */
  open: boolean
}

/**
 * The backend of a test run: nothing reaches the developer's screen; the e2e reads what would
 * have been shown and clicks or dismisses it through the test hooks.
 */
export class RecordingNoticeBackend implements NoticeBackend {
  private readonly shown: { record: RecordedNotice; click: (() => void)[]; close: (() => void)[] }[] = []

  isSupported(): boolean {
    return true
  }

  create(spec: NoticeSpec): NativeNotice {
    const entry = { record: { ...spec, open: false }, click: [] as (() => void)[], close: [] as (() => void)[] }
    return {
      show: () => {
        entry.record.open = true
        this.shown.push(entry)
      },
      close: () => {
        entry.record.open = false
      },
      onClick: (listener) => entry.click.push(listener),
      onClose: (listener) => entry.close.push(listener)
    }
  }

  /** Everything shown so far, oldest first (copies). */
  records(): RecordedNotice[] {
    return this.shown.map((e) => ({ ...e.record }))
  }

  /** Click the `index`-th notification shown. False when there is none or it is no longer open. */
  click(index: number): boolean {
    return this.end(index, 'click')
  }

  /** Dismiss the `index`-th notification shown, as the person closing it would. */
  dismiss(index: number): boolean {
    return this.end(index, 'close')
  }

  private end(index: number, how: 'click' | 'close'): boolean {
    const entry = this.shown[index]
    if (!entry?.record.open) return false
    entry.record.open = false
    for (const listener of entry[how]) listener()
    return true
  }
}
