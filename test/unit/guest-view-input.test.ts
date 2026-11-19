// A write guest's keys (design-guests §7, §8; view-input.ts guestViewInputHandler): the owner's path (the pty write
// through viewInput, the registry's userInput) with the guest follow-up, never the owner's `acted` (which would make the
// guest's tab the project's active one).
import { describe, expect, it } from 'vitest'
import { guestViewInputHandler, viewInputHandler } from '../../src/main/tabs/view-input'

const P = 'aaaaaaaaaaaaaaaa'
const ESC = '\x1b'

function setup(viewInput?: (p: string, t: string, d: string, v: string) => string) {
  const calls: string[] = []
  const deps = {
    viewInput: (p: string, t: string, d: string, v: string) => {
      calls.push(`viewInput ${p} ${t} ${JSON.stringify(d)} ${v}`)
      return viewInput ? viewInput(p, t, d, v) : d
    },
    userInput: (p: string, t: string, d: string) => void calls.push(`userInput ${p} ${t} ${JSON.stringify(d)}`),
    acted: (p: string, t: string, v: string) => void calls.push(`acted ${p} ${t} ${v}`),
    guestActed: (p: string, t: string, v: string) => void calls.push(`guestActed ${p} ${t} ${v}`)
  }
  return { calls, deps }
}

describe('guestViewInputHandler', () => {
  it("forwards the keys and calls guestActed, never the owner's acted", () => {
    const { calls, deps } = setup()
    guestViewInputHandler(deps)(P, 't1', 'ls', 'web:9')
    expect(calls).toEqual([`viewInput ${P} t1 "ls" web:9`, `userInput ${P} t1 "ls"`, `guestActed ${P} t1 web:9`])
  })

  it('a terminal report (a focus event) is forwarded but is not acting', () => {
    const { calls, deps } = setup()
    guestViewInputHandler(deps)(P, 't1', `${ESC}[I`, 'web:9')
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['viewInput', 'userInput'])
  })

  it('what the registry sees is what reached the pty (viewInput may strip the view\'s own replies)', () => {
    const { calls, deps } = setup(() => 'x')
    guestViewInputHandler(deps)(P, 't1', 'x\x1b[?1;2c', 'web:9')
    expect(calls[1]).toBe(`userInput ${P} t1 "x"`)
  })

  it('works with no guestActed dep (it is optional)', () => {
    const { calls, deps } = setup()
    const bare = { viewInput: deps.viewInput, userInput: deps.userInput, acted: deps.acted }
    expect(() => guestViewInputHandler(bare)(P, 't1', 'a', 'web:9')).not.toThrow()
    expect(calls.some((c) => c.startsWith('acted'))).toBe(false)
  })

  it("the owner's handler is unchanged: it calls acted, not guestActed", () => {
    const { calls, deps } = setup()
    viewInputHandler(deps)(P, 't1', 'a', 'desktop:1')
    expect(calls.some((c) => c.startsWith('acted'))).toBe(true)
    expect(calls.some((c) => c.startsWith('guestActed'))).toBe(false)
  })
})
