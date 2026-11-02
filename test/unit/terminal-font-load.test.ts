// The terminals' wait for their font (renderer/tabs/terminal-font.ts loadTerminalFont): xterm
// measures its cell when the font options change, so the font must have loaded first (the bundled
// fonts are web fonts, fetched on first use), but a font that never loads must not hang every
// terminal. Plain Node: `document.fonts` is a stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTerminalFont } from '../../src/renderer/tabs/terminal-font'
import { DEFAULT_TERMINAL_FONT } from '../../src/shared/terminal-font'

type Load = (font: string) => Promise<unknown>

function stubFonts(load: Load): ReturnType<typeof vi.fn<Load>> {
  const fn = vi.fn<Load>(load)
  ;(globalThis as { document?: unknown }).document = { fonts: { load: fn } }
  return fn
}

/** Whether `p` has settled after the microtasks queued so far (and the timers advanced by `ms`). */
async function settledAfter(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false
  void p.then(() => {
    done = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  return done
}

describe('loadTerminalFont', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { document?: unknown }).document
  })

  it('asks for the family at the regular and the bold weight, at the font size', async () => {
    const load = stubFonts(() => Promise.resolve([]))
    await loadTerminalFont({ ...DEFAULT_TERMINAL_FONT, size: 15, boldWeight: '800' })
    expect(load.mock.calls.map(([f]) => f)).toEqual([
      'normal 15px "Cockpit JetBrains Mono NF", monospace',
      '800 15px "Cockpit JetBrains Mono NF", monospace'
    ])
  })

  it('waits for both weights to load', async () => {
    const finish: Array<() => void> = []
    stubFonts(() => new Promise<void>((resolve) => finish.push(resolve)))
    const wait = loadTerminalFont(DEFAULT_TERMINAL_FONT)
    expect(await settledAfter(wait, 500)).toBe(false)
    finish[0]!()
    expect(await settledAfter(wait, 0)).toBe(false)
    finish[1]!()
    expect(await settledAfter(wait, 0)).toBe(true)
  })

  it('goes on after the timeout when the font never loads', async () => {
    stubFonts(() => new Promise(() => {}))
    const wait = loadTerminalFont(DEFAULT_TERMINAL_FONT)
    expect(await settledAfter(wait, 1400)).toBe(false)
    expect(await settledAfter(wait, 200)).toBe(true)
  })

  it('never rejects: a family the CSS font shorthand cannot parse skips the wait', async () => {
    stubFonts(() => Promise.reject(new SyntaxError('Could not resolve font')))
    await expect(loadTerminalFont({ ...DEFAULT_TERMINAL_FONT, family: '1 2 3' })).resolves.toBeUndefined()
  })

  it('does nothing without document.fonts', async () => {
    ;(globalThis as { document?: unknown }).document = {}
    await expect(loadTerminalFont(DEFAULT_TERMINAL_FONT)).resolves.toBeUndefined()
  })
})
