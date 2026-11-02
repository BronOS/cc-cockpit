// The `ccc plugin link` confirm dialog (plugins/link-dialog.ts): Deny is the default and the cancel
// button, the id comes before the plugin's own name, every failure is a Deny, and the test-run fake
// records and answers in order.
import { describe, expect, it, vi } from 'vitest'
import { electronConfirmLink, linkDialogOptions, QueuedLinkConfirm } from '../../src/main/plugins/link-dialog'

const info = { id: 'acme.todo', name: 'Todo', path: '/work/todo', caller: 'tab' as const }

describe('linkDialogOptions', () => {
  it('makes Deny the first, default and cancel button, so Enter or Escape never allows', () => {
    const o = linkDialogOptions(info)
    expect(o.buttons).toEqual(['Deny', 'Allow'])
    expect(o.defaultId).toBe(0)
    expect(o.cancelId).toBe(0)
    expect(o.type).toBe('warning')
  })

  it('names the id before the plugin-controlled name, and the folder in the detail', () => {
    const o = linkDialogOptions(info)
    expect(o.message).toBe('Link plugin acme.todo (named "Todo")?')
    expect(o.detail).toContain('\n/work/todo\n')
    expect(o.detail).toContain('full access to your computer')
  })

  it('says only what main knows about the caller: a tab of the window, or a --project call from outside', () => {
    expect(linkDialogOptions(info).detail).toMatch(/^A "ccc plugin link" command in a tab of this window asked/)
    const outside = linkDialogOptions({ ...info, caller: 'project' }).detail
    expect(outside).toMatch(/^A "ccc plugin link" command run outside the app's tabs \(naming this project with --project\) asked/)
    expect(`${linkDialogOptions(info).detail}${outside}`).not.toMatch(/Claude session/)
  })

  it('passes the caller-gone signal on only when there is one', () => {
    expect('signal' in linkDialogOptions(info)).toBe(false)
    const signal = new AbortController().signal
    expect(linkDialogOptions(info, signal).signal).toBe(signal)
  })
})

describe('electronConfirmLink', () => {
  it('is true only for Allow, shown as a sheet on the asking window', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const confirm = electronConfirmLink({ windowOf: (id) => (id === 7 ? 'win7' : undefined), showMessageBox })
    expect(await confirm(7, info)).toBe(true)
    expect(showMessageBox).toHaveBeenCalledWith('win7', expect.objectContaining({ message: 'Link plugin acme.todo (named "Todo")?' }))
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await confirm(7, info)).toBe(false)
  })

  it('denies for a window that is gone and for a dialog that fails', async () => {
    const showMessageBox = vi.fn(async () => {
      throw new Error('closed')
    })
    const confirm = electronConfirmLink({ windowOf: (id) => (id === 7 ? 'win7' : undefined), showMessageBox })
    expect(await confirm(8, info)).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(await confirm(7, info)).toBe(false)
  })
})

describe('QueuedLinkConfirm', () => {
  it('answers in queue order, denies with an empty queue and records every dialog', async () => {
    const q = new QueuedLinkConfirm()
    q.answer(true, false)
    expect(await q.confirm(1, info)).toBe(true)
    expect(await q.confirm(2, info)).toBe(false)
    expect(await q.confirm(3, info)).toBe(false)
    expect(q.dialogs().map((d) => d.windowId)).toEqual([1, 2, 3])
    expect(q.dialogs()[0]).toEqual({ windowId: 1, ...info })
  })
})
