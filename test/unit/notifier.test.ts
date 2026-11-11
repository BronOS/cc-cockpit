// notifications/notifier.ts: show and wait over a fake backend, the plugin notice's OS spec, the
// chime gate (setting, per-window throttle), which sound a notice rings (NotifySounds) and the test
// run's recording backend, and server mode's in-page backend (PageNoticeBackend, design-web.md §9.9).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChimeGate,
  chimeRinger,
  Notifier,
  NotifySounds,
  PageNoticeBackend,
  pluginNoticeSpec,
  RecordingNoticeBackend,
  type NativeNotice,
  type NoticeBackend,
  type NoticeSpec
} from '../../src/main/notifications/notifier'
import { ViewRegistry, type ViewSink } from '../../src/main/views/view-registry'
import {
  MAX_NOTIFY_ACTION_LABEL,
  MAX_NOTIFY_TEXT,
  MAX_NOTIFY_TITLE,
  MAX_PAGE_NOTICES,
  NOTIFY_ACTION_WAIT_MS,
  NOTIFY_CHIME_INTERVAL_MS,
  pageNoticeTexts
} from '../../src/shared/notify'
import { remoteViewId } from '../../src/shared/views'

/** A backend whose notices the test clicks, closes or fails by hand. */
class FakeBackend implements NoticeBackend {
  supported = true
  failCreate = false
  readonly made: { spec: NoticeSpec; shown: boolean; closed: number; click: () => void; close: () => void }[] = []

  isSupported(): boolean {
    return this.supported
  }

  create(spec: NoticeSpec): NativeNotice {
    if (this.failCreate) throw new Error('no daemon')
    const clicks: (() => void)[] = []
    const closes: (() => void)[] = []
    const entry = {
      spec,
      shown: false,
      closed: 0,
      click: () => clicks.forEach((l) => l()),
      close: () => closes.forEach((l) => l())
    }
    this.made.push(entry)
    return {
      show: () => {
        entry.shown = true
      },
      close: () => {
        entry.closed++
      },
      onClick: (l) => clicks.push(l),
      onClose: (l) => closes.push(l)
    }
  }
}

const SPEC: NoticeSpec = { title: 'cc-cockpit: a.one', body: 'Standup in 2 min', actionLabel: 'Join', persistent: true }

describe('Notifier', () => {
  let backend: FakeBackend
  let log: ReturnType<typeof vi.fn<(m: string) => void>>
  let notifier: Notifier

  beforeEach(() => {
    vi.useFakeTimers()
    backend = new FakeBackend()
    log = vi.fn<(m: string) => void>()
    notifier = new Notifier(backend, log)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows and forgets; an unsupported or failing backend is not an error for the caller', () => {
    notifier.show({ title: 't', body: 'b' })
    expect(backend.made[0]).toMatchObject({ spec: { title: 't', body: 'b' }, shown: true })
    backend.failCreate = true
    expect(() => notifier.show({ title: 't', body: 'b' })).not.toThrow()
    expect(log).toHaveBeenCalledWith('notification failed: Error: no daemon')
    backend.supported = false
    backend.failCreate = false
    notifier.show({ title: 't', body: 'b' })
    expect(backend.made).toHaveLength(1)
  })

  it('resolves true on a click and lets the notification be (the OS removes a clicked one)', async () => {
    const result = notifier.wait(SPEC)
    expect(notifier.pending).toBe(1)
    backend.made[0]?.click()
    await expect(result).resolves.toBe(true)
    expect(backend.made[0]?.closed).toBe(0)
    expect(notifier.pending).toBe(0)
  })

  it('resolves false when the OS closes it, and settles only once', async () => {
    const result = notifier.wait(SPEC)
    backend.made[0]?.close()
    backend.made[0]?.click()
    await expect(result).resolves.toBe(false)
    expect(notifier.pending).toBe(0)
  })

  it('closes it and resolves false after the wait bound', async () => {
    const result = notifier.wait(SPEC)
    await vi.advanceTimersByTimeAsync(NOTIFY_ACTION_WAIT_MS - 1)
    expect(notifier.pending).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe(false)
    expect(backend.made[0]?.closed).toBe(1)
    expect(notifier.pending).toBe(0)
    // A late click (from a notification centre) answers nobody and leaves nothing behind.
    backend.made[0]?.click()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes it and resolves false when the caller aborts; an aborted signal shows nothing', async () => {
    const ctl = new AbortController()
    const result = notifier.wait(SPEC, ctl.signal)
    ctl.abort()
    await expect(result).resolves.toBe(false)
    expect(backend.made[0]?.closed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await expect(notifier.wait(SPEC, ctl.signal)).resolves.toBe(false)
    expect(backend.made).toHaveLength(1)
  })

  it('resolves false at once when notifications cannot be shown', async () => {
    backend.supported = false
    await expect(notifier.wait(SPEC)).resolves.toBe(false)
    backend.supported = true
    backend.failCreate = true
    await expect(notifier.wait(SPEC)).resolves.toBe(false)
    expect(notifier.pending).toBe(0)
  })
})

describe('pluginNoticeSpec', () => {
  it('uses the fallback title, and leaves the OS sound as it was without options', () => {
    expect(pluginNoticeSpec({ text: 'hi', sound: false }, 'cc-cockpit: a.one')).toEqual({ title: 'cc-cockpit: a.one', body: 'hi' })
  })

  it('carries the plugin host\'s window when given one (the in-page backend places the notice there)', () => {
    expect(pluginNoticeSpec({ text: 'hi', sound: false }, 'cc-cockpit: a.one', 4)).toEqual({ windowId: 4, title: 'cc-cockpit: a.one', body: 'hi' })
  })

  it("silences the OS for `sound` (the app's chime is the sound) and makes an action persistent", () => {
    expect(
      pluginNoticeSpec({ text: 'Standup', title: 'Calendar', sound: true, action: { label: 'Join' } }, 'cc-cockpit: a.one')
    ).toEqual({ title: 'Calendar', body: 'Standup', silent: true, actionLabel: 'Join', persistent: true })
  })
})

describe('ChimeGate', () => {
  it('rings at most once per window per interval, each window on its own', () => {
    let now = 1_000
    const rung: number[] = []
    const sounds: string[] = []
    const gate = new ChimeGate({
      enabled: () => true,
      ring: (id, sound) => {
        rung.push(id)
        sounds.push(sound)
      },
      now: () => now
    })
    expect(gate.ring(1, 'builtin:chime')).toBe(true)
    // Another plugin's own sound in the same window is still the one chime per interval.
    expect(gate.ring(1, 'builtin:bell')).toBe(false)
    expect(gate.ring(2, 'builtin:bell')).toBe(true)
    now += NOTIFY_CHIME_INTERVAL_MS - 1
    expect(gate.ring(1, 'builtin:chime')).toBe(false)
    now += 1
    expect(gate.ring(1, 'builtin:ping')).toBe(true)
    expect(rung).toEqual([1, 2, 1])
    expect(sounds).toEqual(['builtin:chime', 'builtin:bell', 'builtin:ping'])
  })

  it('never rings while the setting is off, read at each ring', () => {
    let on = false
    const rung: number[] = []
    const gate = new ChimeGate({ enabled: () => on, ring: (id) => void rung.push(id), now: () => 0 })
    // Off silences a plugin's own sound as much as the app's.
    expect(gate.ring(1, 'builtin:bell')).toBe(false)
    on = true
    // The refused ring did not start the interval.
    expect(gate.ring(1, 'builtin:bell')).toBe(true)
    expect(rung).toEqual([1])
  })
})

describe('NotifySounds', () => {
  const LISTED = 'system:0:freedesktop/stereo/bell.oga'
  function make(app = 'builtin:marimba'): { sounds: NotifySounds; log: string[]; asked: string[] } {
    const log: string[] = []
    const asked: string[] = []
    const sounds = new NotifySounds({
      appSound: () => app,
      systemHas: async (id) => {
        asked.push(id)
        if (id === 'system:1:broken.oga') throw new Error('EACCES')
        return id === LISTED
      },
      log: (m) => log.push(m)
    })
    return { sounds, log, asked }
  }

  it("rings the app's sound for `true`, and a plugin's built-in id as it is", async () => {
    const { sounds, log, asked } = make()
    expect(await sounds.resolve(true, 'a.one')).toBe('builtin:marimba')
    expect(await sounds.resolve('builtin:bell', 'a.one')).toBe('builtin:bell')
    expect(asked).toEqual([])
    expect(log).toEqual([])
  })

  it('rings a system id only when the fresh listing has it', async () => {
    const { sounds, log, asked } = make()
    expect(await sounds.resolve(LISTED, 'a.one')).toBe(LISTED)
    expect(await sounds.resolve('system:0:gone.oga', 'a.one')).toBe('builtin:marimba')
    // A listing that throws is a sound not offered, never a rejected notify.
    expect(await sounds.resolve('system:1:broken.oga', 'a.one')).toBe('builtin:marimba')
    expect(asked).toEqual([LISTED, 'system:0:gone.oga', 'system:1:broken.oga'])
    expect(log).toHaveLength(2)
  })

  it("rings the app's sound for an id that is no sound of this app, logged once per plugin and id", async () => {
    const { sounds, log, asked } = make()
    for (const bad of ['builtin:kazoo', '/etc/passwd', 'system:0:../../etc/passwd', 'chime']) {
      expect(await sounds.resolve(bad, 'a.one')).toBe('builtin:marimba')
    }
    // A path is never a listing question: only a well-spelled system id reaches systemHas.
    expect(asked).toEqual([])
    expect(await sounds.resolve('builtin:kazoo', 'a.one')).toBe('builtin:marimba')
    expect(log).toHaveLength(4)
    expect(log[0]).toContain('"builtin:kazoo" of plugin a.one')
    await sounds.resolve('builtin:kazoo', 'b.two')
    expect(log).toHaveLength(5)
  })
})

describe('RecordingNoticeBackend', () => {
  it('records what was shown and clicks or dismisses it through the notifier', async () => {
    vi.useFakeTimers()
    try {
      const rec = new RecordingNoticeBackend()
      const notifier = new Notifier(rec)
      notifier.show({ title: 'cc-cockpit', body: 'build finished' })
      const clicked = notifier.wait(SPEC)
      const dismissed = notifier.wait(SPEC)
      expect(rec.click(1)).toBe(true)
      expect(rec.click(1)).toBe(false)
      expect(rec.dismiss(2)).toBe(true)
      await expect(clicked).resolves.toBe(true)
      await expect(dismissed).resolves.toBe(false)
      expect(rec.records().map((r) => [r.body, r.open])).toEqual([
        ['build finished', true],
        ['Standup in 2 min', false],
        ['Standup in 2 min', false]
      ])
      expect(rec.click(9)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A view's sink that records the events it got; `broken` makes a send throw. */
class RecordingSink implements ViewSink {
  events: Array<{ channel: string; payload: unknown }> = []
  closed = false
  broken = false
  send(channel: string, payload: unknown): void {
    if (this.broken) throw new Error('render frame was disposed')
    this.events.push({ channel, payload })
  }
  isClosed(): boolean {
    return this.closed
  }
  /** The notices this view shows now: shown and not gone, in order. */
  showing(): string[] {
    const up: string[] = []
    for (const e of this.events) {
      const id = (e.payload as { requestId: string }).requestId
      if (e.channel === 'notices.show') up.push(id)
      if (e.channel === 'notices.gone') up.splice(up.indexOf(id), 1)
    }
    return up
  }
}

describe('PageNoticeBackend (server mode)', () => {
  /**
   * Two windows over a real ViewRegistry: each has its desktop view (the hidden page) and a browser;
   * window 1 has a second browser. Log lines of the registry and the notifier are kept.
   */
  function setup(cap?: number) {
    const logs: string[] = []
    const views = new ViewRegistry({ windowIdOf: () => undefined, log: (m) => logs.push(m) })
    const hidden1 = new RecordingSink()
    const hidden2 = new RecordingSink()
    const phone = new RecordingSink()
    const laptop = new RecordingSink()
    const other = new RecordingSink()
    views.addDesktop(1, hidden1)
    views.addDesktop(2, hidden2)
    views.addRemote(1, remoteViewId(1), phone)
    views.addRemote(1, remoteViewId(2), laptop)
    views.addRemote(2, remoteViewId(3), other)
    let n = 0
    const backend = new PageNoticeBackend({ views, newId: () => `n${++n}`, ...(cap !== undefined ? { cap } : {}) })
    const notifier = new Notifier(backend, (m) => logs.push(m))
    return { views, backend, notifier, hidden1, hidden2, phone, laptop, other, logs }
  }

  it("shows a window's notice in that window's browsers only, never the hidden page, as plain capped text", () => {
    const { backend, notifier, hidden1, hidden2, phone, laptop, other } = setup()
    notifier.show({ windowId: 1, title: 'Mail\nsubject', body: `line one\r\nline\u0007two ${'x'.repeat(MAX_NOTIFY_TEXT)}` })
    const shown = phone.events[0]?.payload as { requestId: string; title: string; text: string }
    expect(phone.events).toHaveLength(1)
    expect(phone.events[0]?.channel).toBe('notices.show')
    expect(shown.requestId).toBe('n1')
    // Control characters out (the body keeps its line break), cut at the ctx.notify limit.
    expect(shown.title).toBe('Mail subject')
    expect(shown.text.startsWith('line one\nline two x')).toBe(true)
    expect(shown.text).toHaveLength(MAX_NOTIFY_TEXT)
    expect(shown.text.endsWith('…')).toBe(true)
    expect(laptop.events).toEqual(phone.events)
    expect(other.events).toEqual([])
    expect(hidden1.events).toEqual([])
    expect(hidden2.events).toEqual([])
    expect(backend.pendingFor(1)).toEqual([shown])
    expect(backend.pendingFor(2)).toEqual([])
  })

  it('an app-wide notice (no window) reaches every browser of every window, and each window lists it', () => {
    const { backend, notifier, hidden1, phone, other } = setup()
    notifier.show({ title: 'cc-cockpit', body: 'build finished' })
    expect(phone.showing()).toEqual(['n1'])
    expect(other.showing()).toEqual(['n1'])
    expect(hidden1.events).toEqual([])
    expect(backend.pendingFor(1).map((n) => n.requestId)).toEqual(['n1'])
    expect(backend.pendingFor(2).map((n) => n.requestId)).toEqual(['n1'])
    // Either window's view may end it; it goes from every browser.
    expect(backend.dismiss(2, 'n1')).toBe(true)
    expect(phone.showing()).toEqual([])
    expect(other.showing()).toEqual([])
  })

  it('a notice with no browser attached waits for the first one (pendingFor, the ready snapshot)', () => {
    const views = new ViewRegistry({ windowIdOf: () => undefined, log: () => {} })
    const hidden = new RecordingSink()
    views.addDesktop(1, hidden)
    const backend = new PageNoticeBackend({ views, newId: () => 'n1' })
    new Notifier(backend).show({ windowId: 1, title: 't', body: 'b' })
    expect(hidden.events).toEqual([])
    expect(backend.pendingFor(1)).toEqual([{ requestId: 'n1', title: 't', text: 'b' }])
  })

  it('wait resolves true on a click from a view of its window, and the notice goes from every view', async () => {
    const { backend, notifier, phone, laptop } = setup()
    const clicked = notifier.wait({ windowId: 1, title: 'Calendar', body: 'Standup in 2 min', actionLabel: 'Join', persistent: true })
    expect(phone.events[0]?.payload).toEqual({ requestId: 'n1', title: 'Calendar', text: 'Standup in 2 min', action: 'Join' })
    expect(backend.click(1, 'n1')).toBe(true)
    await expect(clicked).resolves.toBe(true)
    expect(phone.showing()).toEqual([])
    expect(laptop.showing()).toEqual([])
    expect(notifier.pending).toBe(0)
    expect(backend.size).toBe(0)
    // Settled once: a second click (another view a moment later) finds nothing.
    expect(backend.click(1, 'n1')).toBe(false)
  })

  it('refuses a click for an unknown id and for another window\'s notice; the notice keeps waiting', async () => {
    const { backend, notifier, phone } = setup()
    const waiting = notifier.wait({ windowId: 1, title: 't', body: 'b', actionLabel: 'Go' })
    expect(backend.click(1, 'nope')).toBe(false)
    expect(backend.click(2, 'n1')).toBe(false)
    expect(backend.dismiss(2, 'n1')).toBe(false)
    expect(phone.showing()).toEqual(['n1'])
    expect(notifier.pending).toBe(1)
    expect(backend.dismiss(1, 'n1')).toBe(true)
    await expect(waiting).resolves.toBe(false)
  })

  it('the wait bound and an abort take the notice down everywhere and resolve false', async () => {
    vi.useFakeTimers()
    try {
      const { backend, notifier, phone } = setup()
      const timedOut = notifier.wait({ windowId: 1, title: 't', body: 'b', actionLabel: 'Go' })
      const controller = new AbortController()
      const aborted = notifier.wait({ windowId: 1, title: 't', body: 'c', actionLabel: 'Go' }, controller.signal, NOTIFY_ACTION_WAIT_MS * 2)
      controller.abort()
      await expect(aborted).resolves.toBe(false)
      expect(phone.showing()).toEqual(['n1'])
      vi.advanceTimersByTime(NOTIFY_ACTION_WAIT_MS)
      await expect(timedOut).resolves.toBe(false)
      expect(phone.showing()).toEqual([])
      expect(backend.size).toBe(0)
      expect(backend.click(1, 'n1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it(`keeps at most ${MAX_PAGE_NOTICES} per window and app-wide; the oldest of the same one ends as dismissed`, async () => {
    const { backend, notifier, phone, other } = setup()
    const first = notifier.wait({ windowId: 1, title: 't', body: 'first', actionLabel: 'Go' })
    for (let i = 1; i < MAX_PAGE_NOTICES; i++) void notifier.wait({ windowId: 1, title: 't', body: `w1 ${i}`, actionLabel: 'Go' })
    // Other windows and app-wide notices have their own count.
    notifier.show({ windowId: 2, title: 't', body: 'w2' })
    expect(backend.pendingFor(1)).toHaveLength(MAX_PAGE_NOTICES)
    void notifier.wait({ windowId: 1, title: 't', body: 'newest', actionLabel: 'Go' })
    await expect(first).resolves.toBe(false)
    expect(backend.pendingFor(1)).toHaveLength(MAX_PAGE_NOTICES)
    expect(backend.pendingFor(1).map((n) => n.text)).not.toContain('first')
    expect(phone.showing()).toHaveLength(MAX_PAGE_NOTICES)
    expect(other.showing()).toHaveLength(1)
    for (let i = 0; i < MAX_PAGE_NOTICES + 5; i++) notifier.show({ title: 't', body: `app ${i}` })
    expect(other.showing()).toHaveLength(1 + MAX_PAGE_NOTICES)
    expect(backend.pendingFor(2).map((n) => n.text)).toContain(`app ${MAX_PAGE_NOTICES + 4}`)
    expect(backend.pendingFor(2).map((n) => n.text)).not.toContain('app 4')
    expect(backend.size).toBe(2 * MAX_PAGE_NOTICES + 1)
  })

  // Review finding (task 21): `ccc notify` has no rate limit and shares the cap with plugin notices;
  // a tab running it in a loop must not end the plugins' reminders as { clicked: false }.
  it('a notice nobody waits on never pushes out one a plugin waits on, and goes first when a waited one comes', async () => {
    const { backend, notifier, phone } = setup()
    const waits = Array.from({ length: MAX_PAGE_NOTICES }, (_, i) => notifier.wait({ windowId: 1, title: 't', body: `wait ${i}`, actionLabel: 'Go' }))
    for (let i = 0; i < 5; i++) notifier.show({ windowId: 1, title: 'cc-cockpit', body: `loop ${i}` })
    // Not shown at all: every waiting notice stays.
    expect(phone.showing()).toHaveLength(MAX_PAGE_NOTICES)
    expect(backend.pendingFor(1).map((n) => n.text)).not.toContain('loop 0')
    expect(notifier.pending).toBe(MAX_PAGE_NOTICES)
    // One waited notice ends; an unwaited one fills its place, then the loop pushes out only its own.
    expect(backend.dismiss(1, 'n1')).toBe(true)
    await expect(waits[0]).resolves.toBe(false)
    for (let i = 0; i < 5; i++) notifier.show({ windowId: 1, title: 'cc-cockpit', body: `again ${i}` })
    const texts = backend.pendingFor(1).map((n) => n.text)
    expect(texts).toHaveLength(MAX_PAGE_NOTICES)
    expect(texts.filter((t) => t.startsWith('again'))).toEqual(['again 4'])
    expect(notifier.pending).toBe(MAX_PAGE_NOTICES - 1)
    // A new waited notice pushes out the unwaited one before any waited one.
    void notifier.wait({ windowId: 1, title: 't', body: 'newest', actionLabel: 'Go' })
    expect(backend.pendingFor(1).map((n) => n.text)).not.toContain('again 4')
    expect(notifier.pending).toBe(MAX_PAGE_NOTICES)
  })

  // Review finding (task 21): a notice with no action once lived until clicked or pushed out, and a
  // browser joining days later was shown "Standup in 2 min".
  it('a notice nobody waits on times out after NOTIFY_ACTION_WAIT_MS, like a waited one', () => {
    vi.useFakeTimers()
    try {
      const { backend, notifier, phone, other } = setup()
      notifier.show({ windowId: 1, title: 'Calendar', body: 'Standup in 2 min' })
      notifier.show({ title: 'cc-cockpit', body: 'build done' })
      vi.advanceTimersByTime(NOTIFY_ACTION_WAIT_MS - 1)
      expect(phone.showing()).toEqual(['n1', 'n2'])
      vi.advanceTimersByTime(1)
      expect(phone.showing()).toEqual([])
      expect(other.showing()).toEqual([])
      expect(backend.pendingFor(1)).toEqual([])
      expect(backend.size).toBe(0)
      // One ended early clears its timer: nothing is sent for it again.
      notifier.show({ windowId: 1, title: 't', body: 'b' })
      expect(backend.dismiss(1, 'n3')).toBe(true)
      const sent = phone.events.length
      vi.advanceTimersByTime(NOTIFY_ACTION_WAIT_MS)
      expect(phone.events).toHaveLength(sent)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a window that closes ends its own notices as dismissed and keeps the app-wide ones", async () => {
    const { backend, notifier, phone } = setup()
    const waiting = notifier.wait({ windowId: 1, title: 't', body: 'b', actionLabel: 'Go' })
    notifier.show({ title: 't', body: 'app' })
    backend.windowClosed(1)
    await expect(waiting).resolves.toBe(false)
    expect(backend.pendingFor(2).map((n) => n.text)).toEqual(['app'])
    expect(phone.showing()).toEqual(['n2'])
  })

  it('never logs a notice\'s text, even when a view fails to take it', () => {
    const { notifier, phone, logs } = setup()
    phone.broken = true
    notifier.show({ windowId: 1, title: 'Re: salary review', body: 'secret subject line' })
    notifier.show({ title: 'Re: salary review', body: 'secret subject line' })
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) {
      expect(line).not.toContain('secret')
      expect(line).not.toContain('salary')
    }
  })
})

describe('pageNoticeTexts', () => {
  it('cuts the title and the label, drops an empty label and gives an empty title the app name', () => {
    expect(pageNoticeTexts({ title: 'x'.repeat(200), body: 'b', actionLabel: 'y'.repeat(100) })).toEqual({
      title: `${'x'.repeat(MAX_NOTIFY_TITLE - 1)}…`,
      text: 'b',
      action: `${'y'.repeat(MAX_NOTIFY_ACTION_LABEL - 1)}…`
    })
    expect(pageNoticeTexts({ title: '\u0000\n', body: '  b  ', actionLabel: '\t' })).toEqual({ title: 'cc-cockpit', text: 'b' })
  })
})

describe('chimeRinger', () => {
  /** Window 1 with its desktop page (the hidden page in server mode) and a browser view. */
  function views() {
    const registry = new ViewRegistry({ windowIdOf: () => undefined, log: () => {} })
    const page = new RecordingSink()
    const browser = new RecordingSink()
    registry.addDesktop(1, page)
    registry.addRemote(1, remoteViewId(1), browser)
    return { registry, page, browser }
  }

  it('in server mode rings in the browser views only, never the hidden page', () => {
    const { registry, page, browser } = views()
    chimeRinger(true, registry)(1, 'builtin:bell')
    expect(browser.events).toEqual([{ channel: 'notify.chime', payload: { sound: 'builtin:bell' } }])
    expect(page.events).toEqual([])
  })

  it('on the desktop sends to the window as before (the connection drops it for a browser)', () => {
    const { registry, page } = views()
    chimeRinger(false, registry)(1, 'builtin:bell')
    expect(page.events).toEqual([{ channel: 'notify.chime', payload: { sound: 'builtin:bell' } }])
  })
})
