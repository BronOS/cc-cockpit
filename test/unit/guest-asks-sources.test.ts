// Which ask a guest's answer names (design-guests §9): askInfoFrom over the sources (the first that knows the id answers,
// with its kind), trashAskSource over TrashAsks.pluginOf, and SharedAsks.infoOf (unknown, settled and foreign ids give
// undefined).
import { describe, expect, it } from 'vitest'
import { askInfoFrom, trashAskSource, type GuestAskSource } from '../../src/main/asks/guest-asks'
import { SharedAsks } from '../../src/main/asks/shared-asks'
import { TrashAsks, type TrashAskInfo } from '../../src/main/files/trash-asks'

const source = (kind: GuestAskSource['kind'], known: Record<string, { pluginId?: string; originTab?: string }>): GuestAskSource => ({
  kind,
  info: (windowId, requestId) => (windowId === 1 ? known[requestId] : undefined)
})

describe('askInfoFrom', () => {
  const trash = source('trash', { 'trash-1': { pluginId: 'p.files' } })
  const download = source('download', { 'offer-2': { originTab: 't9' } })

  it("returns the first source's info with its kind", () => {
    const info = askInfoFrom([trash, download])
    expect(info(1, 'trash-1')).toEqual({ kind: 'trash', info: { pluginId: 'p.files' } })
    expect(info(1, 'offer-2')).toEqual({ kind: 'download', info: { originTab: 't9' } })
  })

  it('the first source that knows the id wins when two do', () => {
    const a = source('trash', { 'x-1': { pluginId: 'first' } })
    const b = source('download', { 'x-1': { pluginId: 'second' } })
    expect(askInfoFrom([a, b])(1, 'x-1')).toEqual({ kind: 'trash', info: { pluginId: 'first' } })
    expect(askInfoFrom([b, a])(1, 'x-1')).toEqual({ kind: 'download', info: { pluginId: 'second' } })
  })

  it('an unknown id, another window and no sources all give undefined', () => {
    const info = askInfoFrom([trash, download])
    expect(info(1, 'nope')).toBeUndefined()
    expect(info(2, 'trash-1')).toBeUndefined()
    expect(askInfoFrom([])(1, 'trash-1')).toBeUndefined()
  })
})

describe('SharedAsks.infoOf and TrashAsks.pluginOf', () => {
  function trashAsks() {
    const sent: Array<[number, TrashAskInfo]> = []
    const asks = new TrashAsks({ send: (w, a) => (sent.push([w, a]), true) })
    return { asks, sent }
  }
  const INFO = { path: 'a.ts', kind: 'file' as const, pluginId: 'cockpit.files' }

  it('infoOf gives a copy of the pending ask, and undefined once settled, for another window or an unknown id', async () => {
    const core = new SharedAsks<{ what: string }, boolean>({ hooks: { send: () => true }, prefix: 'x', refused: false, timeoutMs: 60_000 })
    const p = core.ask(1, { what: 'a' })
    const id = core.pendingFor(1)[0]!.requestId
    const got = core.infoOf(1, id)
    expect(got).toEqual({ what: 'a', requestId: id })
    got!.what = 'changed'
    expect(core.infoOf(1, id)!.what).toBe('a')
    expect(core.infoOf(2, id)).toBeUndefined()
    expect(core.infoOf(1, 'x-99')).toBeUndefined()
    core.answer(1, id, true)
    await p
    expect(core.infoOf(1, id)).toBeUndefined()
  })

  it("pluginOf is the asking plugin of a pending trash ask, undefined for unknown, foreign and settled ids", async () => {
    const { asks, sent } = trashAsks()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.pluginOf(1, id)).toBe('cockpit.files')
    expect(asks.pluginOf(2, id)).toBeUndefined()
    expect(asks.pluginOf(1, 'trash-99')).toBeUndefined()
    asks.answer(1, id, false)
    await p
    expect(asks.pluginOf(1, id)).toBeUndefined()
  })

  it('trashAskSource wraps pluginOf as kind trash; no plugin means no info', async () => {
    const { asks, sent } = trashAsks()
    void asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    const lookup = askInfoFrom([trashAskSource(asks)])
    expect(lookup(1, id)).toEqual({ kind: 'trash', info: { pluginId: 'cockpit.files' } })
    expect(lookup(2, id)).toBeUndefined()
    expect(lookup(1, 'trash-99')).toBeUndefined()
  })
})
