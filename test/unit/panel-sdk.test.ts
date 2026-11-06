// Task 28: the panel SDK a plugin page loads (src/sdk/panel-core.ts, wired to the page by
// src/sdk/panel.ts) and the shell's side of a plugin frame (renderer/plugins/frame-messages.ts).
// Ports and the page's :root are fakes; the real ones are covered by test/e2e/panels.spec.ts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PANEL_MESSAGE_LENGTH,
  MAX_QUEUED_MESSAGES,
  BASE_SCROLLBAR_CSS,
  PanelClient,
  PORT_MESSAGE,
  READY_MESSAGE,
  SLOT_HEIGHT_MESSAGE,
  SLOT_WIDTH_MESSAGE,
  SLOT_MESSAGE,
  sdkSheetsFirst,
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

describe('panel SDK: base scrollbar style', () => {
  const withStyles = (): { c: PanelClient; sheets: string[] } => {
    const sheets: string[] = []
    return { c: new PanelClient(fakeRoot(), () => {}, { install: (css) => void sheets.push(css) }), sheets }
  }
  const msg = (mac: boolean): unknown => ({ type: THEME_MESSAGE, theme: { kind: 'dark', vars: {} }, mac })

  it('installs the zero-specificity rule once, on the first theme', () => {
    const { c, sheets } = withStyles()
    c.receive(msg(false), [])
    c.receive(msg(false), [])
    expect(sheets).toEqual([BASE_SCROLLBAR_CSS])
    expect(BASE_SCROLLBAR_CSS).toContain('scrollbar-width: thin')
    expect(BASE_SCROLLBAR_CSS.replace(/:where\([^)]*\)/g, '')).not.toMatch(/[.#a-z]\s*\{/)
  })

  it('does not install it on macOS, or when the message does not say', () => {
    const a = withStyles()
    a.c.receive(msg(true), [])
    expect(a.sheets).toEqual([])
    const b = withStyles()
    b.c.receive({ type: THEME_MESSAGE, theme: { kind: 'dark', vars: {} } }, [])
    expect(b.sheets).toEqual([BASE_SCROLLBAR_CSS])
  })
})

const COMPONENTS_CSS = readFileSync(resolve(__dirname, '../../src/sdk/components.css'), 'utf8')

/**
 * The top-level statements of a stylesheet, comments removed: each is `prelude { body }` (or an
 * at-rule ending in `;`). A small brace scanner; the component sheet has no braces in strings.
 */
function topLevel(css: string): { prelude: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { prelude: string; body: string }[] = []
  let depth = 0
  let start = 0
  let open = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) open = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth < 0) throw new Error(`unbalanced } at ${i}`)
      if (depth === 0) {
        out.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i) })
        start = i + 1
      }
    } else if (ch === ';' && depth === 0) {
      out.push({ prelude: text.slice(start, i).trim(), body: '' })
      start = i + 1
    }
  }
  if (depth !== 0) throw new Error('unbalanced {')
  if (text.slice(start).trim() !== '') out.push({ prelude: text.slice(start).trim(), body: '' })
  return out
}

describe('panel SDK: the component stylesheet', () => {
  const withStyles = (): { c: PanelClient; sheets: string[] } => {
    const sheets: string[] = []
    const c = new PanelClient(fakeRoot(), () => {}, { install: (css) => void sheets.push(css) }, COMPONENTS_CSS)
    return { c, sheets }
  }
  const theme = (mac: boolean): unknown => ({ type: THEME_MESSAGE, theme: { kind: 'dark', vars: {} }, mac })

  it('installs the components at once, before the scrollbars (which wait for the first theme)', () => {
    const { c, sheets } = withStyles()
    expect(sheets).toEqual([COMPONENTS_CSS])
    c.receive(theme(false), [])
    c.receive(theme(false), [])
    expect(sheets).toEqual([COMPONENTS_CSS, BASE_SCROLLBAR_CSS])
  })

  it('installs the components on macOS too, where the scrollbars are left out', () => {
    const { c, sheets } = withStyles()
    c.receive(theme(true), [])
    expect(sheets).toEqual([COMPONENTS_CSS])
  })

  it('warns and goes on when the sheet cannot be installed', () => {
    const warnings: string[] = []
    const failing = {
      install: () => {
        throw new Error('no CSSOM')
      }
    }
    const c = new PanelClient(fakeRoot(), (m) => warnings.push(m), failing, COMPONENTS_CSS)
    expect(warnings).toEqual(['could not install the component styles: no CSSOM'])
    expect(() => c.api.post(1)).not.toThrow()
  })

  it("adopts the SDK's sheets first, in install order, and keeps the page's own after them", () => {
    // What panel.ts does on each install: [components], then [components, scrollbars], with the
    // page's own sheets ('p1', 'p2', adopted in between) kept after them and not duplicated.
    expect(sdkSheetsFirst(['components'], [])).toEqual(['components'])
    expect(sdkSheetsFirst(['components', 'scrollbars'], ['components', 'p1', 'p2'])).toEqual([
      'components',
      'scrollbars',
      'p1',
      'p2'
    ])
    expect(sdkSheetsFirst(['components', 'scrollbars'], ['p1', 'scrollbars', 'components'])).toEqual([
      'components',
      'scrollbars',
      'p1'
    ])
  })

  it('has every rule inside @layer cc, so a page rule outside the layer always wins', () => {
    const statements = topLevel(COMPONENTS_CSS)
    expect(statements).toEqual([{ prelude: '@layer cc', body: expect.any(String) }])
    // Unlayered beats layered only while nothing in the layer is !important (an important layered
    // declaration would beat the page's normal ones instead).
    expect(statements[0]!.body).not.toMatch(/!important/)
    // No nested @layer either: a named sub-layer is still inside cc, but keep the one layer simple.
    expect(statements[0]!.body).not.toMatch(/@layer/)
  })

  it('scopes every selector to zero specificity, so the order inside the layer stays the variants over the base', () => {
    const body = topLevel(COMPONENTS_CSS)[0]!.body
    const rules = topLevel(body).flatMap(({ prelude, body: inner }) =>
      prelude.startsWith('@media') ? topLevel(inner).map((r) => r.prelude) : prelude.startsWith('@') ? [] : [prelude]
    )
    expect(rules.length).toBeGreaterThan(40)
    for (const prelude of rules) {
      // :root holds tokens; [hidden] must outrank the components on purpose (next test).
      if (prelude === ':root' || prelude === '[hidden]') continue
      for (const selector of splitSelectors(prelude)) {
        // `:where(...)` alone, optionally followed by a pseudo-element.
        expect(selector, prelude).toMatch(/^:where\([\s\S]*\)(::?[a-z-]+)?$/)
      }
    }
  })

  it('makes `hidden` hide a component that sets display (the Sessions panel showed its empty text beside a card)', () => {
    const body = topLevel(COMPONENTS_CSS)[0]!.body
    const rules = topLevel(body)
    const hidden = rules.find((r) => r.prelude === '[hidden]')
    expect(hidden?.body).toMatch(/display:\s*none/)
    // Plain specificity (0,1,0), not !important (the layer test above): it beats every zero-specificity
    // component rule wherever it sits, and a page's own unlayered CSS still beats it.
    expect(hidden?.body).not.toMatch(/!important/)
  })

  it('keeps the bare-element defaults out of the shell, which marks its root cc-shell', () => {
    const shellHtml = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8')
    expect(shellHtml).toMatch(/<html lang="en" class="cc-shell">/)
    const shellCss = readFileSync(resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')
    expect(shellCss).toContain("@import '../sdk/components.css';")
    const body = topLevel(COMPONENTS_CSS)[0]!.body
    for (const { prelude } of topLevel(body)) {
      if (/(^|[\s(,])(button|input|select|textarea)\b/.test(prelude) && !/\.cc-|\[role=/.test(prelude)) {
        expect(prelude).toContain(':root:not(.cc-shell)')
      }
    }
  })

  it('draws colours only from theme variables', () => {
    const declarations = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    // No hex, rgb() or named colours: the only colours are var(--cc-*) (and transparent).
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\brgba?\(|\bhsla?\(/)
  })

  it("draws a settings page with the app's own settings numbers (styles.css .settings-*)", () => {
    // A plugin's html settings page sits under the app's schema form: it looked like another app
    // (titles inside cc-card frames, loose controls). Each cc-settings rule must keep the shell
    // rule's values, tokens resolved, so a change on one side shows here.
    const shellCss = readFileSync(resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')
    const layer = topLevel(COMPONENTS_CSS)[0]!.body
    const decls = (body: string): Map<string, string> =>
      new Map(
        body
          .split(';')
          .map((d) => d.trim())
          .filter((d) => d.includes(':'))
          .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as [string, string])
      )
    const shellRules = topLevel(shellCss)
    const layerRules = topLevel(layer)
    const tokens = new Map([
      ...decls(shellRules.find((r) => r.prelude === ':root')!.body),
      ...decls(layerRules.find((r) => r.prelude === ':root')!.body)
    ])
    const resolveVars = (v: string): string =>
      v.replace(/var\((--[a-z0-9-]+)\)/g, (m, name: string) => (tokens.has(name) ? resolveVars(tokens.get(name)!) : m))
    const shellRule = (selector: string): Map<string, string> => {
      const r = shellRules.find((x) => splitSelectors(x.prelude).includes(selector))
      expect(r, selector).toBeDefined()
      return decls(r!.body)
    }
    const layerRule = (selector: string): Map<string, string> => {
      const r = layerRules.find((x) => splitSelectors(x.prelude.replace(/^:where\(([\s\S]*)\)$/, '$1')).includes(selector))
      expect(r, selector).toBeDefined()
      return decls(r!.body)
    }
    const pairs: [string, string, string[]][] = [
      ['.cc-settings-group + .cc-settings-group', '.settings-group + .settings-group', ['margin-top']],
      ['.cc-settings-head', '.settings-group-head', ['margin']],
      ['.cc-settings-head > h3', '.settings-group-head h3', ['margin', 'font-size', 'font-weight']],
      ['.cc-settings-desc', '.settings-group-desc', ['margin', 'max-width', 'font-size', 'line-height', 'color']],
      ['.cc-settings-actions', '.settings-group-actions', ['display', 'gap']],
      ['.cc-settings-card', '.settings-card', ['margin', 'border', 'border-radius', 'background', 'overflow']],
      ['.cc-settings-card > * + *', '.settings-card > * + *', ['border-top']],
      ['.cc-settings-card-head', '.settings-card-head', ['display', 'align-items', 'gap', 'padding', 'background']],
      ['.cc-settings-list', '.settings-list', ['list-style', 'margin', 'padding']],
      ['.cc-settings-row', '.settings-row', ['display', 'align-items', 'justify-content', 'gap', 'min-height', 'padding']],
      ['.cc-settings-row-text', '.settings-row-text', ['flex', 'min-width', 'display', 'flex-direction', 'gap']],
      ['.cc-settings-label', '.settings-row-label', ['display', 'align-items', 'gap', 'font-weight']],
      ['.cc-settings-help', '.settings-row-help', ['max-width', 'font-size', 'line-height', 'color']],
      ['.cc-settings-control', '.settings-row-control', ['flex', 'display', 'align-items', 'gap']]
    ]
    for (const [mine, shell, props] of pairs) {
      const a = layerRule(mine)
      const b = shellRule(shell)
      for (const p of props) {
        expect(b.get(p), `${shell} ${p}`).toBeDefined()
        expect(resolveVars(a.get(p) ?? ''), `${mine} ${p}`).toBe(resolveVars(b.get(p)!))
      }
    }
    // The radius token the card uses is the shell's large radius.
    expect(tokens.get('--cc-radius-l')).toBe(resolveVars('var(--cc-radius-lg)'))
  })

  it('lines up editable settings items in shared columns, and spans any other child of the grid', () => {
    const layerRules = topLevel(topLevel(COMPONENTS_CSS)[0]!.body)
    const body = (prelude: string): string => layerRules.find((r) => r.prelude === prelude)?.body ?? ''
    expect(body(':where(.cc-settings-grid)')).toMatch(/grid-template-columns:\s*var\(--cc-settings-cols,/)
    expect(body(':where(.cc-settings-grid > *)')).toMatch(/grid-column:\s*1 \/ -1/)
    expect(body(':where(.cc-settings-item)')).toMatch(/grid-template-columns:\s*subgrid/)
  })
})

/** A selector list split on its top-level commas (not the ones inside `:where(...)` / `:not(...)`). */
function splitSelectors(prelude: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      out.push(prelude.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(prelude.slice(start).trim())
  return out
}

describe('frame messages (the shell side)', () => {
  it('tells plugin pages from inline overlay pages', () => {
    expect(isPluginPage('cc-plugin://a.one/p.html')).toBe(true)
    expect(isPluginPage('cc-overlay://0000/')).toBe(false)
  })

  it('posts the port and the theme in the shape the SDK reads', () => {
    expect(portMessage).toEqual({ type: PORT_MESSAGE })
    const msg = themeMessage({ id: 'x', name: 'X', kind: 'light', vars: { '--a': '#fff' }, xterm: { red: '#f00' } })
    // The xterm palette stays in the shell.
    expect(msg).toEqual({ type: THEME_MESSAGE, theme: { kind: 'light', vars: { '--a': '#fff' } }, mac: false })
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

describe('panel SDK: ccPanel.slot', () => {
  function slotClient(): { c: PanelClient; up: { type: string; height?: number }[] } {
    const up: { type: string; height?: number }[] = []
    return { c: new PanelClient(fakeRoot(), () => {}, undefined, undefined, (m) => up.push(m)), up }
  }

  it('is undefined in a panel and appears, on the same api object, once the shell says the page is a slot', () => {
    const { c } = slotClient()
    expect(c.api.slot).toBeUndefined()
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'agenda' } }, [])
    expect(c.api.slot?.type).toBe('agenda')
    expect(Object.isFrozen(c.api.slot)).toBe(true)
    expect(Object.keys(c.api)).toContain('slot')
  })

  it('takes the first slot message only and ignores a bad type', () => {
    const { c } = slotClient()
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'Bad Type' } }, [])
    c.receive({ type: SLOT_MESSAGE, slot: {} }, [])
    c.receive({ type: SLOT_MESSAGE }, [])
    expect(c.api.slot).toBeUndefined()
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'agenda' } }, [])
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'other' } }, [])
    expect(c.api.slot?.type).toBe('agenda')
  })

  it('setHeight rounds and keeps the height within 24 and 600, and refuses a non-number', () => {
    const { c, up } = slotClient()
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'agenda' } }, [])
    const slot = c.api.slot!
    slot.setHeight(100.6)
    slot.setHeight(3)
    slot.setHeight(5000)
    expect(up).toEqual([
      { type: SLOT_HEIGHT_MESSAGE, height: 101 },
      { type: SLOT_HEIGHT_MESSAGE, height: 24 },
      { type: SLOT_HEIGHT_MESSAGE, height: 600 }
    ])
    expect(() => slot.setHeight(NaN)).toThrow('finite number')
    expect(() => slot.setHeight(Infinity)).toThrow('finite number')
    expect(() => slot.setHeight('80' as unknown as number)).toThrow('finite number')
    expect(up).toHaveLength(3)
  })

  it('setWidth rounds and keeps the width within 0 and 4096, and refuses a non-number', () => {
    const { c, up } = slotClient()
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'sessions-strip' } }, [])
    const slot = c.api.slot!
    slot.setWidth(180.5)
    slot.setWidth(-3)
    slot.setWidth(1e7)
    expect(up).toEqual([
      { type: SLOT_WIDTH_MESSAGE, width: 181 },
      { type: SLOT_WIDTH_MESSAGE, width: 0 },
      { type: SLOT_WIDTH_MESSAGE, width: 4096 }
    ])
    expect(() => slot.setWidth(NaN)).toThrow('finite number')
    expect(() => slot.setWidth(-Infinity)).toThrow('finite number')
    expect(() => slot.setWidth('80' as unknown as number)).toThrow('finite number')
    expect(up).toHaveLength(3)
  })

  it('does not fail without a parent to tell', () => {
    const c = new PanelClient(fakeRoot())
    c.receive({ type: SLOT_MESSAGE, slot: { type: 'agenda' } }, [])
    expect(() => c.api.slot?.setHeight(80)).not.toThrow()
    expect(() => c.api.slot?.setWidth(80)).not.toThrow()
  })

  it('ready() tells the parent, every call, and does not fail without one', () => {
    const { c, up } = slotClient()
    c.api.ready()
    c.api.ready()
    expect(up).toEqual([{ type: READY_MESSAGE }, { type: READY_MESSAGE }])
    expect(() => new PanelClient(fakeRoot()).api.ready()).not.toThrow()
  })
})
