// notifications/notifier.ts: show and wait over a fake backend, the plugin notice's OS spec, the
// chime gate (setting, per-window throttle), which sound a notice rings (NotifySounds) and the test
// run's recording backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChimeGate,
  Notifier,
  NotifySounds,
  pluginNoticeSpec,
  RecordingNoticeBackend,
  type NativeNotice,
  type NoticeBackend,
  type NoticeSpec
} from '../../src/main/notifications/notifier'
import { NOTIFY_ACTION_WAIT_MS, NOTIFY_CHIME_INTERVAL_MS } from '../../src/shared/notify'

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
