// A guest view's terminals (design-guests §8, D-14, spec-review 14): a read guest sends nothing that reaches
// or sizes the pty, a write guest types but takes the size only by its own key, paste or Fit, and implicit
// takes are the owner's only. A UI hint: main refuses the same calls from a guest view (GUEST_CLASS).
import { describe, expect, it } from 'vitest'
import { gateTerminalIo, implicitTakesAllowed, type TerminalIo } from '../../src/renderer/tabs/terminal-access'

function recorder(withFit = true): { io: TerminalIo; calls: string[] } {
  const calls: string[] = []
  const io: TerminalIo = {
    input: (d) => void calls.push(`input ${d}`),
    ack: (n) => void calls.push(`ack ${n}`),
    resize: (c, r) => void calls.push(`resize ${c}x${r}`),
    screen: () => void calls.push('screen')
  }
  if (withFit) io.fit = () => void calls.push('fit')
  return { io, calls }
}

describe('implicitTakesAllowed', () => {
  it('lets only the owner take a size by an implicit gesture', () => {
    expect(implicitTakesAllowed('owner')).toBe(true)
    expect(implicitTakesAllowed('write')).toBe(false)
    expect(implicitTakesAllowed('read')).toBe(false)
  })
})

describe('gateTerminalIo', () => {
  it("leaves the owner's io as it is", () => {
    const { io } = recorder()
    expect(gateTerminalIo(io, 'owner')).toBe(io)
  })

  it('a read guest sends no input, no size and no fit; only the flow-control acks', () => {
    const { io, calls } = recorder()
    const g = gateTerminalIo(io, 'read')
    g.input('y')
    g.input('\x1b[I') // a focus report
    g.resize(80, 24)
    g.ack(5)
    expect(g.fit).toBeUndefined()
    expect(g.screen).toBeUndefined()
    expect(g.act).toBeUndefined()
    expect(calls).toEqual(['ack 5'])
  })

  it("a write guest's size reports are held (the latest only) until its own key, then go before it", () => {
    const { io, calls } = recorder()
    const g = gateTerminalIo(io, 'write')
    g.resize(80, 24)
    g.resize(100, 30)
    // A focus or mouse report comes through input with nobody typing: it releases nothing.
    g.input('\x1b[I')
    expect(calls).toEqual(['input \x1b[I'])
    g.act?.()
    g.input('l')
    expect(calls).toEqual(['input \x1b[I', 'resize 100x30', 'input l'])
    // From then on its reports go at once; a second act sends nothing again.
    g.resize(90, 20)
    g.act?.()
    expect(calls.slice(3)).toEqual(['resize 90x20'])
  })

  it("a write guest's Fit is explicit: the held size first, then the take", () => {
    const { io, calls } = recorder()
    const g = gateTerminalIo(io, 'write')
    g.resize(120, 40)
    g.fit?.()
    expect(calls).toEqual(['resize 120x40', 'fit'])
  })

  it('a write guest never answers a screen ask; a terminal with no fit (an overlay) gets none', () => {
    const { io } = recorder(false)
    const g = gateTerminalIo(io, 'write')
    expect(g.screen).toBeUndefined()
    expect(g.fit).toBeUndefined()
  })
})
