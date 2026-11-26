// Task 05 (overlay foundation): the page SDK's side of a perView overlay copy (src/sdk/panel-core.ts and
// src/sdk/panel-overlay.ts): the intro, ccPanel.notes, ccPanel.ask, ccPanel.overlay.discuss and the `$cc` envelope
// (shared/overlay-envelope.ts). Ports are fakes; the shell's side is task 04's.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_PANEL_MESSAGE_LENGTH, PanelClient, PORT_MESSAGE, SLOT_MESSAGE, TAB_MESSAGE, type PortLike, type ThemeRoot } from '../../src/sdk/panel-core'
import { ENVELOPE_REQUEST_TIMEOUT_MS, MAX_OUTSTANDING_ENVELOPES, OVERLAY_INTRO_MESSAGE } from '../../src/shared/overlay-envelope'
import { ASK_MAX_QUESTION } from '../../src/shared/ask'
import { MAX_NOTE_ANCHOR_JSON, MAX_NOTE_TEXT } from '../../src/shared/notes-limits'

class FakePort implements PortLike {
  readonly sent: string[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  postMessage(message: string): void {
    this.sent.push(message)
  }
  close(): void {
    this.closed = true
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }
  /** The requests the page sent, parsed. */
  requests(): Array<{ $cc: number; id: number; op: string; args: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s) as { $cc: number; id: number; op: string; args: Record<string, unknown> }).filter((m) => m.$cc === 1)
  }
  /** The shell answers request `id`. */
  answer(id: number, value: unknown): void {
    this.deliver(JSON.stringify({ $cc: 1, re: id, ok: true, value }))
  }
  refuse(id: number, error: string): void {
    this.deliver(JSON.stringify({ $cc: 1, re: id, ok: false, error }))
  }
  push(ev: 'notes' | 'ask', seq: number, data: unknown): void {
    this.deliver(JSON.stringify({ $cc: 1, ev, seq, data }))
  }
}

const root = (): ThemeRoot => ({ colorScheme: '', setProperty: () => {}, removeProperty: () => undefined })

function client(): { c: PanelClient; warnings: string[] } {
  const warnings: string[] = []
  return { c: new PanelClient(root(), (m) => warnings.push(m)), warnings }
}

const ALL = { notes: true, ask: true, discuss: true }

/** A copy as the shell makes it: the intro, then the port (with the view's access). */
function copy(features: Record<string, unknown> = ALL, access?: 'read' | 'write'): { c: PanelClient; port: FakePort; warnings: string[]; messages: unknown[] } {
  const { c, warnings } = client()
  const messages: unknown[] = []
  c.api.onMessage((m) => void messages.push(m))
  c.receive({ type: OVERLAY_INTRO_MESSAGE, overlay: features }, [])
  const port = new FakePort()
  c.receive({ type: PORT_MESSAGE, ...(access ? { access } : {}) }, [port])
  return { c, port, warnings, messages }
}

const STATE = { global: '', notes: [], rev: 0 }

afterEach(() => {
  vi.useRealTimers()
})

describe('ccPanel overlay copy: the intro', () => {
  it('ccPanel.notes and ask are undefined without the intro (panel, slot, page tab, non-perView overlay)', () => {
    // A panel, or a non-perView overlay: a port and no intro.
    const panel = client().c
    panel.receive({ type: PORT_MESSAGE }, [new FakePort()])
    expect([panel.api.notes, panel.api.ask, panel.api.overlay]).toEqual([undefined, undefined, undefined])
    // A slot and a page tab: an intro sent to them anyway is ignored.
    const slot = client().c
    slot.receive({ type: SLOT_MESSAGE, slot: { type: 'agenda' } }, [])
    slot.receive({ type: OVERLAY_INTRO_MESSAGE, overlay: ALL }, [])
    expect([slot.api.notes, slot.api.ask, slot.api.overlay]).toEqual([undefined, undefined, undefined])
    const tab = client().c
    tab.receive({ type: TAB_MESSAGE, tab: { type: 'file' } }, [])
    tab.receive({ type: OVERLAY_INTRO_MESSAGE, overlay: ALL }, [])
    expect([tab.api.notes, tab.api.ask, tab.api.overlay]).toEqual([undefined, undefined, undefined])
    // An overlay copy: what its intro says, and nothing but true counts.
    const { c } = copy({ notes: true, ask: 'yes', discuss: false })
    expect(c.api.notes).toBeDefined()
    expect(c.api.ask).toBeUndefined()
    expect(c.api.overlay).toBeDefined()
    expect(c.api.overlay?.discuss).toBeUndefined()
    expect(typeof copy().c.api.overlay?.discuss).toBe('function')
  })

  it('a copy that is not an overlay copy keeps a $cc message as the plugin message it always was', () => {
    const { c } = client()
    const got: unknown[] = []
    c.api.onMessage((m) => void got.push(m))
    const port = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [port])
    port.deliver(JSON.stringify({ $cc: 1, ev: 'notes', seq: 1, data: {} }))
    expect(got).toHaveLength(1)
  })
})

describe('ccPanel: the reserved $cc key', () => {
  it('ccPanel.post throws on $cc; handle.post and host-api\'s overlay post refuse it', () => {
    // The page side here; the host's handle.post is in ctx-ui.test.ts and host-api's in host-api.test.ts.
    const { c, port } = copy()
    expect(() => c.api.post({ $cc: 1, id: 1, op: 'notes.list', args: {} } as never)).toThrow(TypeError)
    expect(() => c.api.post({ $cc: 'anything' } as never)).toThrow(/\$cc/)
    // Not at the top level: a plain message.
    c.api.post({ nested: { $cc: 1 } } as never)
    expect(port.sent).toEqual(['{"nested":{"$cc":1}}'])
  })

  it("an app envelope on a copy's port never reaches onMessage", () => {
    const { port, messages } = copy()
    port.push('notes', 1, { type: 'state', state: STATE })
    port.deliver(JSON.stringify({ $cc: 1, re: 99, ok: true, value: null }))
    port.deliver(JSON.stringify({ plain: true }))
    expect(messages).toEqual([{ plain: true }])
  })
})

describe('ccPanel.notes', () => {
  it('sends each call as an envelope and settles it with the shell\'s answer', async () => {
    const { c, port } = copy()
    const listed = c.api.notes!.list()
    const added = c.api.notes!.add({ quote: 'q', text: 't', anchor: { line: 3 } })
    const [l, a] = port.requests()
    expect(l).toMatchObject({ $cc: 1, op: 'notes.list', args: {} })
    expect(a).toMatchObject({ op: 'notes.add', args: { quote: 'q', text: 't', anchor: { line: 3 } } })
    port.answer(l!.id, { ...STATE, seq: 4 })
    port.refuse(a!.id, 'past the cap')
    await expect(listed).resolves.toEqual({ ...STATE, seq: 4 })
    await expect(added).rejects.toThrow('past the cap')
    void c.api.notes!.change('n1', { text: 'x' })
    void c.api.notes!.remove('n1')
    void c.api.notes!.setGlobal('for Claude')
    expect(port.requests().slice(2).map((r) => [r.op, r.args])).toEqual([
      ['notes.change', { id: 'n1', text: 'x' }],
      ['notes.remove', { id: 'n1' }],
      ['notes.setGlobal', { text: 'for Claude' }]
    ])
  })

  it('a push with seq ≤ list\'s is dropped', async () => {
    const { c, port } = copy()
    const seen: number[] = []
    c.api.notes!.onChange((state) => void seen.push(state.rev))
    const listed = c.api.notes!.list()
    port.answer(port.requests()[0]!.id, { ...STATE, rev: 5, seq: 10 })
    await listed
    port.push('notes', 9, { type: 'state', state: { ...STATE, rev: 4 } })
    port.push('notes', 10, { type: 'state', state: { ...STATE, rev: 5 } })
    port.push('notes', 11, { type: 'state', state: { ...STATE, rev: 6 } })
    // And one older than the last push.
    port.push('notes', 11, { type: 'state', state: { ...STATE, rev: 7 } })
    expect(seen).toEqual([6])
  })

  it('a read guest\'s writes are refused in the page (main refuses them anyway); its list works', async () => {
    const { c, port } = copy({ notes: true, ask: false, discuss: false }, 'read')
    await expect(c.api.notes!.add({ quote: 'q', text: 't' })).rejects.toThrow(/read-only/)
    await expect(c.api.notes!.setGlobal('x')).rejects.toThrow(/read-only/)
    void c.api.notes!.list()
    expect(port.requests().map((r) => r.op)).toEqual(['notes.list'])
  })
})

describe('ccPanel.ask and overlay.discuss', () => {
  it('start, say, close, pick and continue go up as their ops; pushes reach the listeners of their type', async () => {
    const { c, port } = copy()
    const ask = c.api.ask!
    void ask.start('what is this?')
    void ask.say({ question: 'and this?', quote: 'a line' })
    void ask.close()
    const picked = ask.pick({ model: 'sonnet' })
    void ask.continue()
    void c.api.overlay!.discuss!()
    const reqs = port.requests()
    expect(reqs.map((r) => [r.op, r.args])).toEqual([
      ['ask.start', { question: 'what is this?' }],
      ['ask.say', { question: 'and this?', quote: 'a line' }],
      ['ask.close', {}],
      ['ask.pick', { model: 'sonnet' }],
      ['ask.continue', {}],
      ['discuss.open', {}]
    ])
    port.answer(reqs[3]!.id, { model: 'sonnet', models: ['sonnet'], efforts: [] })
    await expect(picked).resolves.toMatchObject({ model: 'sonnet' })
    const deltas: string[] = []
    const ends: unknown[] = []
    ask.on('delta', (d) => void deltas.push(d.text))
    ask.on('end', (d) => void ends.push(d))
    port.push('ask', 1, { type: 'delta', text: 'He' })
    port.push('ask', 2, { type: 'delta', text: 'llo' })
    port.push('ask', 2, { type: 'delta', text: 'again' })
    port.push('ask', 3, { type: 'end', message: 'idle', error: false })
    expect(deltas).toEqual(['He', 'llo'])
    expect(ends).toEqual([{ type: 'end', message: 'idle', error: false }])
    expect(() => ask.on('nope' as never, () => {})).toThrow(TypeError)
  })
})

describe('ccPanel overlay copy: caps and timeouts', () => {
  it('over a cap: outgoing rejects RangeError, incoming dropped with a warning', async () => {
    const { c, port, warnings, messages } = copy()
    await expect(c.api.notes!.add({ quote: 'q', text: 'x'.repeat(MAX_NOTE_TEXT + 1) })).rejects.toThrow(RangeError)
    await expect(c.api.notes!.add({ quote: 'q', text: 't', anchor: 'a'.repeat(MAX_NOTE_ANCHOR_JSON) })).rejects.toThrow(RangeError)
    await expect(c.api.ask!.start('x'.repeat(ASK_MAX_QUESTION + 1))).rejects.toThrow(RangeError)
    expect(port.requests()).toHaveLength(0)
    // Incoming: an envelope past the port's cap is dropped, with a warning, before anything reads it.
    const before = warnings.length
    port.deliver(JSON.stringify({ $cc: 1, ev: 'notes', seq: 1, data: { type: 'state', state: STATE, pad: 'x'.repeat(MAX_PANEL_MESSAGE_LENGTH) } }))
    expect(warnings.length).toBe(before + 1)
    expect(messages).toEqual([])
    // An envelope that is neither an answer nor a push: dropped with a warning too.
    port.deliver(JSON.stringify({ $cc: 1, what: 'else' }))
    expect(warnings.length).toBe(before + 2)
  })

  it('at most 50 requests wait; one more rejects at once; each is rejected after 30 s', async () => {
    vi.useFakeTimers()
    const { c, port } = copy()
    const waiting = Array.from({ length: MAX_OUTSTANDING_ENVELOPES }, () => c.api.notes!.list())
    for (const p of waiting) p.catch(() => {})
    await expect(c.api.notes!.list()).rejects.toThrow(RangeError)
    expect(port.requests()).toHaveLength(MAX_OUTSTANDING_ENVELOPES)
    vi.advanceTimersByTime(ENVELOPE_REQUEST_TIMEOUT_MS)
    await expect(waiting[0]).rejects.toThrow(/did not answer/)
    // Room again; a late answer of a timed-out request settles nothing.
    port.answer(port.requests()[0]!.id, STATE)
    const next = c.api.notes!.list()
    port.answer(port.requests().at(-1)!.id, { ...STATE, seq: 1 })
    await expect(next).resolves.toMatchObject({ seq: 1 })
  })

  it('a new port rejects what was asked on the old one', async () => {
    const { c, port } = copy()
    const asked = c.api.notes!.list()
    c.receive({ type: PORT_MESSAGE }, [new FakePort()])
    await expect(asked).rejects.toThrow(/replaced/)
    expect(port.closed).toBe(true)
  })
})
