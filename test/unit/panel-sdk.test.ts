// Task 28: the panel SDK a plugin page loads (src/sdk/panel-core.ts, wired to the page by
// src/sdk/panel.ts) and the shell's side of a plugin frame (renderer/plugins/frame-messages.ts).
// Ports and the page's :root are fakes; the real ones are covered by test/e2e/panels.spec.ts.
import { describe, expect, it } from 'vitest'
import {
  MAX_PANEL_MESSAGE_LENGTH,
  MAX_QUEUED_MESSAGES,
  PanelClient,
  PORT_MESSAGE,
  THEME_MESSAGE,
  type PortLike,
  type ThemeRoot
} from '../../src/sdk/panel-core'
import { isPluginPage, overlayMessageOf, overlayResultOf, portMessage, themeMessage } from '../../src/renderer/plugins/frame-messages'
import { MAX_OVERLAY_MESSAGE_LENGTH } from '../../src/shared/overlay-message'
import type { Theme } from '../../src/shared/theme'

class FakePort implements PortLike {
  readonly sent: string[] = []
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(message: string): void {
    this.sent.push(message)
  }
  close(): void {
    this.closed = true
  }
  /** The plugin's host posts to the page. */
  deliver(data: unknown): void {
    this.onmessage?.({ data })
  }
}

function fakeRoot(): ThemeRoot & { props: Map<string, string> } {
  const props = new Map<string, string>()
  return {
    props,
    colorScheme: '',
    setProperty: (n, v) => void props.set(n, v),
    removeProperty: (n) => props.delete(n)
  }
}

function client(): { c: PanelClient; root: ReturnType<typeof fakeRoot>; warnings: string[] } {
  const root = fakeRoot()
  const warnings: string[] = []
  return { c: new PanelClient(root, (m) => warnings.push(m)), root, warnings }
}

describe('panel SDK: post and onMessage', () => {
  it('queues what the page posts until its port arrives, then sends it in order as JSON strings', () => {
    const { c } = client()
    c.api.post({ ping: 1 })
    c.api.post('two')
    const port = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [port])
    expect(port.sent).toEqual(['{"ping":1}', '"two"'])
    c.api.post([3])
    expect(port.sent.at(-1)).toBe('[3]')
  })

  it('refuses non-JSON and oversized messages at the call site, and bounds the queue', () => {
    const { c, warnings } = client()
    expect(() => c.api.post(undefined as never)).toThrow(TypeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => c.api.post(cyclic as never)).toThrow(TypeError)
    expect(() => c.api.post('x'.repeat(MAX_PANEL_MESSAGE_LENGTH))).toThrow(RangeError)
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 5; i++) c.api.post(i)
    expect(warnings).toHaveLength(5)
    const port = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [port])
    expect(port.sent).toHaveLength(MAX_QUEUED_MESSAGES)
  })

  it("delivers the host's JSON messages to every listener, each its own copy, and drops anything else", () => {
    const { c, warnings } = client()
    const port = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [port])
    const a: unknown[] = []
    const b: unknown[] = []
    c.api.onMessage((m) => {
      if (typeof m === 'object' && m !== null) (m as { n: number }).n = 99
      a.push(m)
    })
    const offB = c.api.onMessage((m) => b.push(m))
    port.deliver('{"n":1}')
    expect(a).toEqual([{ n: 99 }])
    expect(b).toEqual([{ n: 1 }])
    offB()
    port.deliver('2')
    port.deliver({ structured: 'object' })
    port.deliver('not json')
    port.deliver(`"${'x'.repeat(MAX_PANEL_MESSAGE_LENGTH)}"`)
    expect(b).toEqual([{ n: 1 }])
    expect(a).toHaveLength(2)
    expect(warnings).toHaveLength(3)
    // A throwing listener does not stop the others.
    c.api.onMessage(() => {
      throw new Error('boom')
    })
    const after: unknown[] = []
    c.api.onMessage((m) => after.push(m))
    port.deliver('3')
    expect(after).toEqual([3])
  })

  it('a new port (a reconnect) replaces the old one, which is closed and heard no more', () => {
    const { c } = client()
    const heard: unknown[] = []
    c.api.onMessage((m) => heard.push(m))
    const first = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [first])
    const second = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [second])
    expect(first.closed).toBe(true)
    expect(first.onmessage).toBeNull()
    second.deliver('"new"')
    expect(heard).toEqual(['new'])
    c.api.post('out')
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual(['"out"'])
  })

  it('ignores a port message without a port and messages of other types', () => {
    const { c } = client()
    c.receive({ type: PORT_MESSAGE }, [])
    c.receive({ type: 'something-else' }, [new FakePort()])
    c.receive(null, [])
    c.api.post('queued')
    const port = new FakePort()
    c.receive({ type: PORT_MESSAGE }, [port])
    expect(port.sent).toEqual(['"queued"'])
  })
})

describe('panel SDK: theme', () => {
  const theme = (vars: Record<string, string>, kind: 'light' | 'dark' = 'dark'): Theme => ({
    id: 't',
    name: 'T',
    kind,
    vars,
    xterm: { foreground: '#fff' }
  })

  it("applies the shell's theme variables to :root, drops stale ones and tells listeners", () => {
    const { c, root } = client()
    expect(c.api.theme.current).toBeUndefined()
    const seen: unknown[] = []
    const off = c.api.theme.onChange((t) => seen.push(t))
    c.receive(themeMessage(theme({ '--cc-bg': '#000', '--cc-fg': '#fff' })), [])
    expect([...root.props]).toEqual([
      ['--cc-bg', '#000'],
      ['--cc-fg', '#fff']
    ])
    expect(root.colorScheme).toBe('dark')
    c.receive(themeMessage(theme({ '--cc-bg': '#fff' }, 'light')), [])
    expect([...root.props]).toEqual([['--cc-bg', '#fff']])
    expect(root.colorScheme).toBe('light')
    expect(c.api.theme.current).toEqual({ kind: 'light', vars: { '--cc-bg': '#fff' } })
    off()
    c.receive(themeMessage(theme({ '--cc-bg': '#111' })), [])
    expect(seen).toEqual([
      { kind: 'dark', vars: { '--cc-bg': '#000', '--cc-fg': '#fff' } },
      { kind: 'light', vars: { '--cc-bg': '#fff' } }
    ])
  })

  it('takes only CSS variable names with short string values, and ignores a malformed theme', () => {
    const { c, root } = client()
    c.receive(
      { type: THEME_MESSAGE, theme: { kind: 'dark', vars: { '--ok': '#123', color: 'red', '--n': 5, '--long': 'x'.repeat(101) } } },
      []
    )
    expect([...root.props]).toEqual([['--ok', '#123']])
    c.receive({ type: THEME_MESSAGE, theme: { kind: 'sepia', vars: {} } }, [])
    c.receive({ type: THEME_MESSAGE, theme: null }, [])
    expect([...root.props]).toEqual([['--ok', '#123']])
    // The current theme handed out is a copy.
    const current = c.api.theme.current!
    current.vars['--ok'] = 'changed'
    expect(c.api.theme.current?.vars['--ok']).toBe('#123')
  })
})

describe('frame messages (the shell side)', () => {
  it('tells plugin pages from inline overlay pages', () => {
    expect(isPluginPage('cc-plugin://a.one/p.html')).toBe(true)
    expect(isPluginPage('cc-overlay://0000/')).toBe(false)
  })

  it('posts the port and the theme in the shape the SDK reads', () => {
    expect(portMessage).toEqual({ type: PORT_MESSAGE })
    const msg = themeMessage({ id: 'x', name: 'X', kind: 'light', vars: { '--a': '#fff' }, xterm: { red: '#f00' } })
    // The xterm palette stays in the shell.
    expect(msg).toEqual({ type: THEME_MESSAGE, theme: { kind: 'light', vars: { '--a': '#fff' } } })
  })

  it("reads a plugin overlay page's { result } and nothing else", () => {
    expect(overlayResultOf(JSON.stringify({ result: { picked: 'b' } }))).toEqual({ value: { picked: 'b' } })
    expect(overlayResultOf(JSON.stringify({ result: null }))).toEqual({ value: null })
    expect(overlayResultOf(JSON.stringify({ other: 1 }))).toBeUndefined()
    expect(overlayResultOf(JSON.stringify([1]))).toBeUndefined()
    expect(overlayResultOf('{"__proto__":{"result":1}}')).toBeUndefined()
    expect(overlayResultOf({ result: 1 })).toBeUndefined()
    expect(overlayResultOf('not json')).toBeUndefined()
    expect(overlayResultOf(`{"result":"${'x'.repeat(MAX_PANEL_MESSAGE_LENGTH)}"}`)).toBeUndefined()
  })

  it("relays a plugin overlay page's other messages as their JSON text, within the overlay limit", () => {
    expect(overlayMessageOf('{"draft":"a"}')).toBe('{"draft":"a"}')
    expect(overlayMessageOf('3')).toBe('3')
    expect(overlayMessageOf('not json')).toBeUndefined()
    expect(overlayMessageOf({ draft: 'a' })).toBeUndefined()
    // Over the overlay limit (below the panel one): the host transport could not carry it.
    expect(overlayMessageOf(JSON.stringify('x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH - 1)))).toBeUndefined()
    expect(overlayMessageOf(JSON.stringify('x'.repeat(MAX_OVERLAY_MESSAGE_LENGTH - 2)))).toHaveLength(MAX_OVERLAY_MESSAGE_LENGTH)
  })
})
