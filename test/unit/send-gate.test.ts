import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookEvent } from '../../src/shared/hooks'
import {
  afterEvent,
  cancel,
  DELIVERING_TIMEOUT_MS,
  deliveringTimedOut,
  maySend,
  MAX_QUEUE,
  MAX_TEXT_CHARS,
  PASTE_END,
  PASTE_START,
  pasteBytes,
  prepareText,
  send,
  SESSION_START_SETTLE_MS,
  settled,
  stripControls,
  stripMarkers
} from '../../src/main/sessions/send-gate'
import { hookHandler } from '../../src/main/sessions/hook-handler'
import { SessionRegistry, type SessionChange } from '../../src/main/sessions/session-registry'
import { newEntry, type SessionEntry, type TabStatus } from '../../src/main/sessions/status-reducer'

const ESC = '\x1b'
const paste = (text: string): string => `${ESC}[200~${text}${ESC}[201~\r`
const entryIn = (status: TabStatus, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  ...newEntry({ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/proj' }),
  status,
  ...extra
})
const item = (id: string, text = id): { id: string; text: string } => ({ id, text })
const hook = (event: HookEvent) => ({ type: 'hook', event, payload: {} }) as const

describe('settled (end of the SessionStart window)', () => {
  it('is not sendable while settling; settled clears it and delivers the head', () => {
    const e = entryIn('waiting', { settling: true, queue: [item('a'), item('b')] })
    expect(maySend(e)).toBe(false)
    expect(send(e, item('c')).write).toBeUndefined()
    const step = settled(e)
    expect(step).toMatchObject({ write: pasteBytes('a'), delivered: item('a') })
    expect(step.entry).toMatchObject({ settling: false, delivering: true, queue: [item('b')] })
  })
  it('does nothing without the flag, and delivers nothing to a tab that moved on', () => {
    const plain = entryIn('waiting', { queue: [item('a')] })
    expect(settled(plain)).toEqual({ entry: plain })
    expect(settled(entryIn('working', { settling: true, queue: [item('a')] })).write).toBeUndefined()
  })
  it('SessionStart sets the flag only when the reducer made the tab waiting', () => {
    expect(afterEvent(entryIn('waiting'), hook('SessionStart')).entry.settling).toBe(true)
    expect(afterEvent(entryIn('idle'), hook('SessionStart')).entry.settling).toBeUndefined()
    expect(afterEvent(entryIn('idle', { settling: true }), hook('SessionStart')).entry.settling).toBeFalsy()
  })
})

describe('markers', () => {
  it('frames text as one bracketed paste followed by Enter', () => {
    expect(PASTE_START).toBe(`${ESC}[200~`)
    expect(PASTE_END).toBe(`${ESC}[201~`)
    expect(pasteBytes('a\nb')).toBe(`${ESC}[200~a\nb${ESC}[201~\r`)
  })

  it('strips every start and end marker from the text', () => {
    expect(stripMarkers(`x${ESC}[201~y${ESC}[200~z${ESC}[201~`)).toBe('xyz')
    // An embedded end marker would end the paste early and type the rest as keys.
    expect(pasteBytes(`fine${ESC}[201~\r1`)).toBe(`${ESC}[200~fine\r1${ESC}[201~\r`)
  })

  it('strips a marker that only forms once another one is removed', () => {
    expect(stripMarkers(`a${ESC}[20${ESC}[200~1~b`)).toBe('ab')
    expect(stripMarkers(`${ESC}[2${ESC}[201~${ESC}[201~01~`)).toBe('')
  })

  it('strips deeply nested markers in linear time (a replace-until-stable loop took 9 s on 440 KB)', () => {
    // Each removal of the middle marker forms the next one: n nested start and end markers.
    const n = 40_000
    const nested = (k: number, mid: string): string => `${ESC}[20`.repeat(k) + mid + '0~'.repeat(k)
    const t0 = performance.now()
    expect(stripMarkers(`hello${nested(n, `${ESC}[200~`)}`)).toBe('hello')
    expect(stripMarkers(nested(n, `${ESC}[201~`) + 'tail')).toBe('tail')
    // Generous: linear is a few ms; the old loop needed seconds at this size.
    expect(performance.now() - t0).toBeLessThan(1000)
    // Interleaved start/end pieces leave no marker either.
    const mixed = `${ESC}[20${ESC}[20${ESC}[201~1~0~x`
    expect(stripMarkers(mixed)).toBe('x')
  })

  it('prepareText checks the length before cleaning, so a huge marker payload is refused at once', () => {
    const huge = `hello${`${ESC}[20`.repeat(75_000)}${ESC}[200~${'0~'.repeat(75_000)}`
    expect(huge.length).toBeGreaterThan(400_000)
    const t0 = performance.now()
    expect(() => prepareText(huge)).toThrow(/longer/)
    expect(performance.now() - t0).toBeLessThan(100)
    // Text that would only fit once stripped is refused too, not cut.
    expect(() => prepareText('x'.repeat(MAX_TEXT_CHARS) + `${ESC}[200~`)).toThrow(/longer/)
  })

  it('leaves other escapes and plain text alone', () => {
    expect(stripMarkers(`${ESC}[31mred${ESC}[0m [200~`)).toBe(`${ESC}[31mred${ESC}[0m [200~`)
  })

  it('prepareText removes control bytes, keeping tab and newline, and maps CR to newline', () => {
    expect(prepareText(`a${ESC}[201b`)).toBe('a[201b')
    expect(prepareText('a\u009b201~ b')).toBe('a201~ b')
    expect(prepareText('a\x03\x04\x1a\x7fb\tc\r\nd\re')).toBe('ab\tc\nd\ne')
    expect(stripControls('\u0080x\u009f')).toBe('x')
    expect(prepareText(`${ESC}[2\u009b01~`)).not.toContain(PASTE_END)
  })

  it('prepareText refuses text that starts with a slash command or bash-mode prefix', () => {
    expect(() => prepareText('/exit')).toThrow(/"\/", "!", "#" or "&"/)
    expect(() => prepareText('  \n/clear')).toThrow(/"\/", "!", "#" or "&"/)
    expect(() => prepareText('!rm -rf x')).toThrow(/"\/", "!", "#" or "&"/)
    expect(() => prepareText(`${ESC}/exit`)).toThrow(/"\/", "!", "#" or "&"/)
    // Memory and background-session prefixes act without a permission prompt too.
    expect(() => prepareText('# always run rm -rf')).toThrow(/"#" or "&"/)
    expect(() => prepareText(' &do it remotely')).toThrow(/"#" or "&"/)
    expect(prepareText('see /exit and !bang')).toBe('see /exit and !bang')
  })

  it('prepareText refuses non-strings, empty text and text over the cap', () => {
    expect(prepareText(`hi${ESC}[200~`)).toBe('hi')
    expect(() => prepareText(42)).toThrow(/string/)
    expect(() => prepareText('')).toThrow(/empty/)
    expect(() => prepareText(` \n${ESC}[200~${ESC}[201~`)).toThrow(/empty/)
    expect(prepareText('x'.repeat(MAX_TEXT_CHARS))).toHaveLength(MAX_TEXT_CHARS)
    expect(() => prepareText('x'.repeat(MAX_TEXT_CHARS + 1))).toThrow(/longer/)
  })
})

describe('send (pure)', () => {
  it('writes at once when waiting and nothing is in flight', () => {
    const step = send(entryIn('waiting'), item('a', 'hello'))
    expect(step.write).toBe(paste('hello'))
    expect(step.delivered).toEqual(item('a', 'hello'))
    expect(step.entry).toMatchObject({ queue: [], delivering: true })
  })

  it.each<TabStatus>(['working', 'idle', 'starting', 'needs-permission'])('queues in %s', (status) => {
    const step = send(entryIn(status), item('a'))
    expect(step.write).toBeUndefined()
    expect(step.entry.queue).toEqual([item('a')])
    expect(step.entry.delivering).toBe(false)
  })

  it('queues while waiting but a paste is still in flight', () => {
    const step = send(entryIn('waiting', { delivering: true }), item('b'))
    expect(step.write).toBeUndefined()
    expect(step.entry.queue).toEqual([item('b')])
  })

  it('keeps the order: a sendable tab with older items delivers the oldest, the new one waits', () => {
    const step = send(entryIn('waiting', { queue: [item('old')] }), item('new'))
    expect(step.write).toBe(paste('old'))
    expect(step.entry.queue).toEqual([item('new')])
  })

  it('refuses an ended session and a full queue', () => {
    expect(() => send(entryIn('ended'), item('a'))).toThrow(/ended/)
    const full = Array.from({ length: MAX_QUEUE }, (_, i) => item(`q${i}`))
    expect(() => send(entryIn('working', { queue: full }), item('a'))).toThrow(/full/)
  })

  it('maySend is true only for waiting, not delivering, process alive', () => {
    expect(maySend(entryIn('waiting'))).toBe(true)
    expect(maySend(entryIn('waiting', { delivering: true }))).toBe(false)
    expect(maySend(entryIn('waiting', { exitCode: 0 }))).toBe(false)
    for (const s of ['starting', 'idle', 'working', 'needs-permission', 'ended'] as const) {
      expect(maySend(entryIn(s))).toBe(false)
    }
  })
})

describe('cancel (pure)', () => {
  it('removes the item by id and leaves the rest in order', () => {
    const step = cancel(entryIn('working', { queue: [item('a'), item('b'), item('c')] }), 'b')
    expect(step?.entry.queue).toEqual([item('a'), item('c')])
  })

  it('is undefined for an id that is not queued', () => {
    expect(cancel(entryIn('working', { queue: [item('a')] }), 'zz')).toBeUndefined()
  })
})

describe('afterEvent (pure)', () => {
  it('Stop delivers only the queue head', () => {
    const step = afterEvent(entryIn('waiting', { queue: [item('a'), item('b')] }), hook('Stop'))
    expect(step.write).toBe(paste('a'))
    expect(step.entry).toMatchObject({ queue: [item('b')], delivering: true })
  })

  it('Stop with an empty queue writes nothing', () => {
    expect(afterEvent(entryIn('waiting'), hook('Stop')).write).toBeUndefined()
  })

  it('a second Stop while delivering writes nothing', () => {
    const step = afterEvent(entryIn('waiting', { delivering: true, queue: [item('b')] }), hook('Stop'))
    expect(step.write).toBeUndefined()
    expect(step.entry.queue).toEqual([item('b')])
  })

  it('UserPromptSubmit clears delivering and delivers nothing', () => {
    const step = afterEvent(entryIn('working', { delivering: true, queue: [item('b')] }), hook('UserPromptSubmit'))
    expect(step.entry.delivering).toBe(false)
    expect(step.write).toBeUndefined()
  })

  it.each<HookEvent>(['Notification', 'SessionStart', 'PreToolUse', 'PostToolUse'])(
    '%s never delivers, even into waiting with a queue',
    (event) => {
      const step = afterEvent(entryIn('waiting', { queue: [item('a')] }), hook(event))
      expect(step.write).toBeUndefined()
      expect(step.entry.queue).toEqual([item('a')])
    }
  )

  it('an ended session drops the queue and the delivery in flight, and reports them', () => {
    const step = afterEvent(
      entryIn('ended', { exitCode: 0, delivering: true, queue: [item('a'), item('b')] }),
      { type: 'exit', code: 0 }
    )
    expect(step.entry).toMatchObject({ queue: [], delivering: false })
    expect(step.dropped).toEqual([item('a'), item('b')])
    expect(step.write).toBeUndefined()
  })

  it('SessionEnd ends the session too: the queue is dropped', () => {
    const step = afterEvent(entryIn('ended', { queue: [item('a')] }), hook('SessionEnd'))
    expect(step.dropped).toEqual([item('a')])
  })

  it('a Stop on an ended entry (a late hook of a dead process) writes nothing', () => {
    const step = afterEvent(entryIn('ended', { exitCode: 1 }), hook('Stop'))
    expect(step.write).toBeUndefined()
    expect(step.dropped).toBeUndefined()
  })

  it('the timeout clears only the flag', () => {
    const e = entryIn('waiting', { delivering: true, queue: [item('b')] })
    expect(deliveringTimedOut(e)).toMatchObject({ delivering: false, queue: [item('b')] })
    const idle = entryIn('waiting')
    expect(deliveringTimedOut(idle)).toBe(idle)
  })
})

describe('registry wiring', () => {
  let writes: Array<{ tabId: string; projectId: string; data: string }>
  let logs: string[]
  let reg: SessionRegistry
  let failWrite: boolean

  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    logs = []
    failWrite = false
    reg = new SessionRegistry({
      projectName: () => 'p',
      broadcast: () => {},
      write: ({ tabId, projectId }, data) => {
        if (failWrite) throw new Error('pty gone')
        writes.push({ tabId, projectId, data })
      },
      log: (m) => logs.push(m)
    })
    reg.tabStarted({ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/proj' })
  })

  afterEach(() => {
    reg.dispose()
    vi.useRealTimers()
  })

  const ev = (event: HookEvent, payload: unknown = {}): void => {
    reg.applyHook('t1', event, payload)
  }
  const texts = (): string[] => writes.map((w) => w.data)

  it('sent when waiting, written to the entry’s own tab and project', () => {
    ev('Stop')
    expect(reg.send('t1', 'hello')).toMatchObject({ delivered: true })
    expect(writes).toEqual([{ tabId: 't1', projectId: 'p1', data: paste('hello') }])
    expect(reg.get('t1')).toMatchObject({ queue: [], delivering: true })
  })

  it('queued in starting, idle, working and needs-permission; nothing written', () => {
    expect(reg.send('t1', 'a').delivered).toBe(false) // starting
    ev('SessionStart')
    reg.send('t1', 'b') // idle: a trust dialog may be on screen
    ev('UserPromptSubmit')
    reg.send('t1', 'c') // working
    ev('Notification', { notification_type: 'permission_prompt' })
    reg.send('t1', 'd') // needs-permission
    expect(writes).toEqual([])
    expect(reg.get('t1')?.queue.map((q) => q.text)).toEqual(['a', 'b', 'c', 'd'])
  })

  // The incident: a fresh or resumed tab sat idle after SessionStart and a Discuss to it stayed
  // queued until the person typed. startup/resume/clear now mean waiting, after a settle window.
  describe('SessionStart at the prompt', () => {
    it.each(['startup', 'resume', 'clear'])('source %s: held for the settle window, then sendable', (source) => {
      ev('SessionStart', { source })
      expect(reg.get('t1')).toMatchObject({ status: 'waiting', settling: true })
      expect(reg.send('t1', 'early').delivered).toBe(false)
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS - 1)
      expect(writes).toEqual([])
      vi.advanceTimersByTime(1)
      // The end of the window delivers the head, like a Stop.
      expect(texts()).toEqual([paste('early')])
      expect(reg.get('t1')).toMatchObject({ settling: false, delivering: true })
    })

    it('text sent while starting goes in when the window ends; one item, the rest on Stops', () => {
      reg.send('t1', 'a')
      reg.send('t1', 'b')
      ev('SessionStart', { source: 'startup' })
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS)
      expect(texts()).toEqual([paste('a')])
      ev('UserPromptSubmit')
      ev('Stop')
      expect(texts()).toEqual([paste('a'), paste('b')])
    })

    it('a prompt and its Stop inside the window end it: a send right after goes in', () => {
      ev('SessionStart', { source: 'startup' })
      ev('UserPromptSubmit')
      ev('Stop')
      expect(reg.get('t1')?.settling).toBeFalsy()
      expect(reg.send('t1', 'next').delivered).toBe(true)
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS)
      expect(texts()).toEqual([paste('next')])
    })

    it('a send after the window goes straight in', () => {
      ev('SessionStart', { source: 'resume' })
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS)
      expect(writes).toEqual([])
      expect(reg.send('t1', 'now').delivered).toBe(true)
    })

    it('the person typed a prompt during the window: nothing is typed when it ends', () => {
      ev('SessionStart', { source: 'startup' })
      reg.send('t1', 'later')
      ev('UserPromptSubmit')
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS)
      expect(writes).toEqual([])
      ev('Stop')
      expect(texts()).toEqual([paste('later')])
    })

    it('an exit or a close during the window: the timer writes nothing', () => {
      ev('SessionStart', { source: 'startup' })
      reg.send('t1', 'x')
      reg.tabExited('t1', 1)
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS)
      expect(writes).toEqual([])
      reg.tabStarted({ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/proj' })
      ev('SessionStart', { source: 'startup' })
      reg.tabClosed('t1')
      vi.advanceTimersByTime(SESSION_START_SETTLE_MS)
      expect(writes).toEqual([])
    })

    it('compact, fork or no source stays the non-sendable idle, with no window', () => {
      for (const payload of [{ source: 'compact' }, { source: 'fork' }, {}]) {
        ev('SessionStart', payload)
        expect(reg.get('t1')).toMatchObject({ status: 'idle' })
        expect(reg.get('t1')?.settling).toBeUndefined()
      }
    })
  })

  it('never writes in needs-permission, even with a non-empty queue on a Notification', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    ev('Notification', { notification_type: 'permission_prompt' })
    ev('Notification', { notification_type: 'permission_prompt' })
    ev('Notification', { message: 'Claude needs your permission to use Bash' })
    expect(reg.get('t1')?.status).toBe('needs-permission')
    expect(writes).toEqual([])
  })

  it('a question dialog holds a send until a real Stop, which delivers it once', () => {
    ev('UserPromptSubmit', { prompt: 'plan it' })
    ev('PreToolUse', { tool_name: 'AskUserQuestion' })
    expect(reg.get('t1')).toMatchObject({ status: 'needs-permission', tool: 'AskUserQuestion' })
    // The Enter this would type picks an option in the dialog: it must wait.
    expect(reg.send('t1', 'a').delivered).toBe(false)
    // The user's own keys in the dialog (one per question) neither deliver nor leave it.
    reg.userInput('p1', 't1', '1')
    reg.userInput('p1', 't1', '\r')
    ev('Notification', { notification_type: 'idle_prompt' })
    expect(reg.get('t1')?.status).toBe('needs-permission')
    expect(writes).toEqual([])
    ev('PostToolUse', { tool_name: 'AskUserQuestion' }) // answered: Claude goes on
    expect(reg.get('t1')?.status).toBe('working')
    expect(writes).toEqual([])
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
  })

  it('the plan-approval dialog (ExitPlanMode) holds a send the same way', () => {
    ev('UserPromptSubmit')
    ev('PreToolUse', { tool_name: 'ExitPlanMode' })
    reg.send('t1', 'a')
    reg.userInput('p1', 't1', '\r')
    expect(reg.get('t1')?.status).toBe('needs-permission')
    expect(writes).toEqual([])
    ev('PostToolUse', { tool_name: 'ExitPlanMode' })
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
  })

  it('an idle Notification that promotes to waiting does not deliver; the next Stop does', () => {
    ev('SessionStart')
    reg.send('t1', 'a')
    ev('Notification', { notification_type: 'idle_prompt' })
    expect(reg.get('t1')?.status).toBe('waiting')
    expect(writes).toEqual([])
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
  })

  it('two Stops before UserPromptSubmit deliver only one item; the next Stop the second', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    reg.send('t1', 'b')
    ev('Stop')
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
    ev('UserPromptSubmit', { prompt: 'a' })
    expect(reg.get('t1')?.delivering).toBe(false)
    ev('Stop')
    expect(texts()).toEqual([paste('a'), paste('b')])
  })

  it('a send while a paste is in flight (status still waiting) is queued', () => {
    ev('Stop')
    reg.send('t1', 'a')
    expect(reg.send('t1', 'b').delivered).toBe(false)
    expect(texts()).toEqual([paste('a')])
  })

  it('a permission Notification while delivering writes nothing; UserPromptSubmit then clears the flag', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    reg.send('t1', 'b')
    ev('Stop') // delivers a
    ev('Notification', { notification_type: 'permission_prompt' })
    ev('Stop') // still delivering: nothing
    expect(texts()).toEqual([paste('a')])
    expect(reg.get('t1')).toMatchObject({ status: 'waiting', delivering: true })
    ev('UserPromptSubmit')
    expect(reg.get('t1')?.delivering).toBe(false)
    expect(texts()).toEqual([paste('a')])
  })

  it('markers are stripped before the text is queued', () => {
    ev('UserPromptSubmit')
    reg.send('t1', `x${ESC}[201~y`)
    expect(reg.get('t1')?.queue[0]?.text).toBe('xy')
    ev('Stop')
    expect(texts()).toEqual([paste('xy')])
  })

  it('cancel removes a queued item; it is never written', () => {
    ev('UserPromptSubmit')
    const a = reg.send('t1', 'a')
    reg.send('t1', 'b')
    expect(reg.cancelQueued('t1', a.id)).toBe(true)
    expect(reg.cancelQueued('t1', a.id)).toBe(false)
    expect(reg.cancelQueued('nope', a.id)).toBe(false)
    ev('Stop')
    expect(texts()).toEqual([paste('b')])
  })

  it('an item already delivered cannot be cancelled', () => {
    ev('Stop')
    const a = reg.send('t1', 'a')
    expect(reg.cancelQueued('t1', a.id)).toBe(false)
  })

  it('an ended tab drops its queue and reports it; later sends are refused', () => {
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    reg.tabExited('t1', 0)
    expect(reg.get('t1')).toMatchObject({ status: 'ended', queue: [] })
    expect(changes.at(-1)?.dropped?.map((q) => q.text)).toEqual(['a'])
    expect(logs.some((l) => l.includes('dropped 1'))).toBe(true)
    expect(() => reg.send('t1', 'b')).toThrow(/ended/)
    ev('Stop') // a late hook of the dead process
    expect(writes).toEqual([])
  })

  it('SessionEnd drops the queue too', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    ev('SessionEnd')
    expect(reg.get('t1')?.queue).toEqual([])
  })

  it('/clear (SessionEnd then SessionStart): refused in between, queues again after, timer cleared', () => {
    ev('Stop')
    reg.send('t1', 'a') // delivering, timer armed
    ev('SessionEnd')
    expect(reg.get('t1')).toMatchObject({ status: 'ended', delivering: false })
    expect(() => reg.send('t1', 'b')).toThrow(/ended/)
    ev('SessionStart')
    expect(reg.get('t1')?.status).toBe('idle')
    expect(reg.send('t1', 'c').delivered).toBe(false) // idle: queued, not typed
    expect(reg.get('t1')?.queue.map((q) => q.text)).toEqual(['c'])
    vi.advanceTimersByTime(DELIVERING_TIMEOUT_MS * 2)
    expect(logs.some((l) => l.includes('no longer delivering'))).toBe(false)
    expect(texts()).toEqual([paste('a')])
  })

  it('closing the tab reports the dropped queue', () => {
    const changes: SessionChange[] = []
    reg.onChange((c) => changes.push(c))
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    reg.tabClosed('t1')
    expect(changes.at(-1)).toMatchObject({ entry: undefined, dropped: [{ text: 'a' }] })
    expect(() => reg.send('t1', 'b')).toThrow(/unknown tab/)
  })

  it('the delivering timeout clears the flag, is logged, and does not itself deliver', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    reg.send('t1', 'b')
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
    vi.advanceTimersByTime(DELIVERING_TIMEOUT_MS - 1)
    expect(reg.get('t1')?.delivering).toBe(true)
    vi.advanceTimersByTime(1)
    expect(reg.get('t1')).toMatchObject({ status: 'waiting', delivering: false })
    expect(logs.some((l) => l.includes('no longer delivering'))).toBe(true)
    expect(texts()).toEqual([paste('a')]) // still waiting with b queued, and nothing typed
    vi.advanceTimersByTime(60_000)
    expect(texts()).toEqual([paste('a')])
    ev('Stop')
    expect(texts()).toEqual([paste('a'), paste('b')])
  })

  it('UserPromptSubmit cancels the timeout', () => {
    ev('Stop')
    reg.send('t1', 'a')
    ev('UserPromptSubmit')
    vi.advanceTimersByTime(DELIVERING_TIMEOUT_MS * 2)
    expect(logs.some((l) => l.includes('no longer delivering'))).toBe(false)
  })

  it('a restart (same tab id, new process) starts with an empty queue and no stale timer', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'old')
    ev('Stop') // old delivered, delivering
    reg.send('t1', 'queued')
    vi.advanceTimersByTime(DELIVERING_TIMEOUT_MS / 2)
    reg.tabExited('t1', 1)
    reg.tabStarted({ tabId: 't1', projectId: 'p1', kind: 'claude', cwd: '/proj' })
    expect(reg.get('t1')).toMatchObject({ status: 'starting', queue: [], delivering: false })
    ev('SessionStart')
    ev('Stop') // nothing of the old process's queue survives
    expect(texts()).toEqual([paste('old')])
    // A delivery of the new process; the old process's timer would fire half way through it.
    expect(reg.send('t1', 'new').delivered).toBe(true)
    vi.advanceTimersByTime(DELIVERING_TIMEOUT_MS / 2)
    expect(reg.get('t1')?.delivering).toBe(true)
    vi.advanceTimersByTime(DELIVERING_TIMEOUT_MS / 2 - 1)
    expect(reg.get('t1')?.delivering).toBe(true)
    expect(logs.some((l) => l.includes('no longer delivering'))).toBe(false)
  })

  it('a write that throws keeps the item queued and not delivering', () => {
    ev('UserPromptSubmit')
    const a = reg.send('t1', 'a')
    failWrite = true
    ev('Stop')
    expect(reg.get('t1')).toMatchObject({ queue: [{ id: a.id, text: 'a' }], delivering: false })
    expect(logs.some((l) => l.includes('pty gone'))).toBe(true)
    expect(reg.send('t1', 'b').delivered).toBe(false)
    failWrite = false
    ev('Stop')
    expect(texts()).toEqual([paste('a')])
  })

  it('send refuses an unknown tab and bad text', () => {
    expect(() => reg.send('nope', 'a')).toThrow(/unknown tab/)
    expect(() => reg.send('t1', '')).toThrow(/empty/)
  })

  it('a Stop through the hook handler delivers synchronously, before the handler returns', () => {
    ev('UserPromptSubmit')
    reg.send('t1', 'a')
    hookHandler(reg)({ event: 'Stop', payload: {} }, { kind: 'session', tabId: 't1', projectId: 'p1' })
    expect(texts()).toEqual([paste('a')])
  })
})
