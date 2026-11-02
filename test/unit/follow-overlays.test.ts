import { describe, expect, it } from 'vitest'
import type { OverlayInfo } from '../../src/shared/ipc'
import { followOverlays, type OverlayStackBridge } from '../../src/renderer/overlays/follow-overlays'

// OverlayStack itself needs a DOM and is covered end to end in test/e2e/overlays.spec.ts; this
// plays out the list-versus-update ordering that e2e cannot pin down.

function fakeBridge(): {
  bridge: OverlayStackBridge
  answer(stack: OverlayInfo[]): void
  fail(err: Error): void
  emit(stack: OverlayInfo[]): void
  listeners: number
} {
  let answer!: (stack: OverlayInfo[]) => void
  let fail!: (err: Error) => void
  const listed = new Promise<OverlayInfo[]>((resolve, reject) => {
    answer = resolve
    fail = reject
  })
  const listeners = new Set<(stack: OverlayInfo[]) => void>()
  return {
    bridge: {
      list: () => listed,
      onUpdated: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    answer,
    fail,
    emit: (stack) => {
      for (const l of listeners) l(stack)
    },
    get listeners() {
      return listeners.size
    }
  }
}

const html = (id: string): OverlayInfo => ({
  id,
  kind: 'html',
  title: id,
  src: `cc-overlay://${id}/`,
  size: 'default'
})
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('followOverlays', () => {
  it('applies the list answer when no update came first, then every update', async () => {
    const f = fakeBridge()
    const seen: string[][] = []
    followOverlays(f.bridge, (s) => seen.push(s.map((o) => o.id)), () => {})
    f.answer([html('a')])
    await flush()
    f.emit([html('a'), html('b')])
    expect(seen).toEqual([['a'], ['a', 'b']])
  })

  it('a list answer older than an update is dropped: the live overlay stays shown', async () => {
    const f = fakeBridge()
    const seen: string[][] = []
    followOverlays(f.bridge, (s) => seen.push(s.map((o) => o.id)), () => {})
    // An overlay opened while overlays.list was in flight: main sends the update first...
    f.emit([html('a')])
    // ...and the list answer, taken before it, arrives after.
    f.answer([])
    await flush()
    expect(seen).toEqual([['a']])
  })

  it('unsubscribing stops updates and drops a list answer still in flight', async () => {
    const f = fakeBridge()
    const seen: string[][] = []
    const off = followOverlays(f.bridge, (s) => seen.push(s.map((o) => o.id)), () => {})
    expect(f.listeners).toBe(1)
    off()
    expect(f.listeners).toBe(0)
    f.answer([html('a')])
    await flush()
    expect(seen).toEqual([])
  })

  it('a failed list goes to onError', async () => {
    const f = fakeBridge()
    const errors: unknown[] = []
    followOverlays(f.bridge, () => {}, (err) => errors.push(err))
    f.fail(new Error('boom'))
    await flush()
    expect(errors).toHaveLength(1)
  })
})
