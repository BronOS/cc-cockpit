// The in-page Move to Trash confirm (main/files/trash-asks.ts, plan Task 16): the shared-ask rules
// (first answer wins, the timeout, pending ones for a joining view, another window refused) and the
// choice between it and the native box (chooseTrashConfirm). The router half (the sender's window,
// the payload's shape) is in ipc-router.test.ts and web-protocol.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmTrash, TrashDialogInfo } from '../../src/main/files/system-files'
import { chooseTrashConfirm, TRASH_ASK_MS, TrashAsks, type TrashAskInfo } from '../../src/main/files/trash-asks'

const INFO: TrashDialogInfo = { path: 'src/a.ts', kind: 'file', pluginId: 'cockpit.files' }

function setup(send = true): { asks: TrashAsks; sent: Array<[number, TrashAskInfo]>; settled: Array<[number, string]> } {
  const sent: Array<[number, TrashAskInfo]> = []
  const settled: Array<[number, string]> = []
  const asks = new TrashAsks({
    send: (w, a) => (sent.push([w, a]), send),
    settled: (w, id) => void settled.push([w, id])
  })
  return { asks, sent, settled }
}

afterEach(() => vi.useRealTimers())

describe('TrashAsks', () => {
  it('the first answer wins: Move settles true once, every view hears it settled, a later answer finds nothing', async () => {
    const { asks, sent, settled } = setup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(id).toMatch(/^trash-/)
    expect(sent[0]![1]).toEqual({ requestId: id, ...INFO })
    expect(asks.answer(1, id, true)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(settled).toEqual([[1, id]])
    expect(asks.answer(1, id, false)).toBe(false)
    expect(asks.size).toBe(0)
  })

  it('Cancel settles false; a non-boolean-true answer is never a move', async () => {
    const { asks, sent } = setup()
    const a = asks.ask(1, INFO)
    asks.answer(1, sent[0]![1].requestId, false)
    await expect(a).resolves.toBe(false)
    const b = asks.ask(1, INFO)
    expect(asks.answer(1, sent[1]![1].requestId, 'yes' as unknown as boolean)).toBe(true)
    await expect(b).resolves.toBe(false)
  })

  it('refuses an answer for another window’s ask, and for an unknown or settled id', async () => {
    const { asks, sent } = setup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(2, id, true)).toBe(false)
    expect(asks.answer(1, 'trash-999', true)).toBe(false)
    expect(asks.answer(1, 'link-1', true)).toBe(false)
    expect(asks.pendingFor(1)).toHaveLength(1)
    expect(asks.pendingFor(2)).toEqual([])
    asks.answer(1, id, false)
    await expect(p).resolves.toBe(false)
    expect(asks.answer(1, id, true)).toBe(false)
  })

  it('a joining view gets the pending asks of its window, oldest first, as copies', async () => {
    const { asks, sent } = setup()
    void asks.ask(1, INFO)
    void asks.ask(1, { ...INFO, path: 'src', kind: 'folder' })
    void asks.ask(2, INFO)
    const pending = asks.pendingFor(1)
    expect(pending.map((a) => a.path)).toEqual(['src/a.ts', 'src'])
    pending[0]!.path = 'changed'
    expect(asks.pendingFor(1)[0]!.path).toBe('src/a.ts')
    expect(sent).toHaveLength(3)
  })

  it('the wait runs out after 5 minutes: not moved, and every view is told', async () => {
    vi.useFakeTimers()
    const { asks, sent, settled } = setup()
    const p = asks.ask(1, INFO)
    vi.advanceTimersByTime(TRASH_ASK_MS - 1)
    expect(asks.size).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(p).resolves.toBe(false)
    expect(settled).toEqual([[1, sent[0]![1].requestId]])
    expect(TRASH_ASK_MS).toBe(5 * 60_000)
  })

  it('no view took it, a closed window and a host that went away all settle not moved', async () => {
    await expect(setup(false).asks.ask(1, INFO)).resolves.toBe(false)
    const { asks } = setup()
    const closed = asks.ask(1, INFO)
    asks.windowClosed(1)
    await expect(closed).resolves.toBe(false)
    const ctrl = new AbortController()
    const gone = asks.ask(1, INFO, ctrl.signal)
    ctrl.abort()
    await expect(gone).resolves.toBe(false)
    expect(asks.size).toBe(0)
  })
})

describe('chooseTrashConfirm', () => {
  function choose(server: boolean, remote: boolean) {
    const calls: string[] = []
    const shared: ConfirmTrash = async () => (calls.push('shared'), true)
    const native: ConfirmTrash = async () => (calls.push('native'), true)
    const confirm = chooseTrashConfirm({ server, hasRemoteView: () => remote, shared, native })
    return { confirm, calls }
  }

  it('on the desktop with no browser attached: the native box as before', async () => {
    const { confirm, calls } = choose(false, false)
    await confirm(1, INFO)
    expect(calls).toEqual(['native'])
  })

  it('on the desktop with a browser attached: the shared ask, on every view', async () => {
    const { confirm, calls } = choose(false, true)
    await confirm(1, INFO)
    expect(calls).toEqual(['shared'])
  })

  it('in server mode: always the shared ask, never the native box nor a test run’s queued fake', async () => {
    const { confirm, calls } = choose(true, false)
    await confirm(1, INFO)
    await confirm(1, INFO)
    expect(calls).toEqual(['shared', 'shared'])
  })

  it('decides per call from the live view list', async () => {
    let remote = false
    const calls: string[] = []
    const confirm = chooseTrashConfirm({
      hasRemoteView: () => remote,
      shared: async () => (calls.push('shared'), false),
      native: async () => (calls.push('native'), false)
    })
    await confirm(1, INFO)
    remote = true
    await confirm(1, INFO)
    expect(calls).toEqual(['native', 'shared'])
  })

  it('passes the window, the info and the signal through', async () => {
    const shared = vi.fn<ConfirmTrash>(async () => true)
    const signal = new AbortController().signal
    await chooseTrashConfirm({ server: true, hasRemoteView: () => false, shared, native: async () => false })(7, INFO, signal)
    expect(shared).toHaveBeenCalledWith(7, INFO, signal)
  })
})
