import { afterEach, describe, expect, it, vi } from 'vitest'

// electron-dialog.ts imports Electron's `dialog`; a recorder stands in for it (plain Node has no
// Electron). Everything the adapter does is pass the call through, so the recorder sees it as is.
const recorder = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown[] }>
}))
vi.mock('electron', () => ({
  dialog: {
    showMessageBox: (...args: unknown[]) => {
      recorder.calls.push({ fn: 'showMessageBox', args })
      return Promise.resolve({ response: 1, checkboxChecked: false })
    },
    showOpenDialog: (...args: unknown[]) => {
      recorder.calls.push({ fn: 'showOpenDialog', args })
      return Promise.resolve({ canceled: false, filePaths: ['/x'] })
    },
    showErrorBox: (...args: unknown[]) => {
      recorder.calls.push({ fn: 'showErrorBox', args })
    }
  }
}))

import { ServerDialogError, serverDialogs } from '../../src/main/dialogs/dialogs'
import { electronDialogs } from '../../src/main/dialogs/electron-dialog'

afterEach(() => {
  recorder.calls.length = 0
})

describe('serverDialogs', () => {
  it('rejects a message box with ServerDialogError and never calls Electron', async () => {
    const d = serverDialogs(() => {})
    await expect(d.showMessageBox({}, { message: 'Link plugin x?' })).rejects.toBeInstanceOf(ServerDialogError)
    await expect(d.showMessageBox(undefined, { message: 'm' })).rejects.toThrow('no native dialog in server mode: m')
    expect(recorder.calls).toEqual([])
  })

  it('answers an open dialog canceled with no paths', async () => {
    const d = serverDialogs(() => {})
    expect(await d.showOpenDialog({}, { properties: ['openDirectory'] })).toEqual({ canceled: true, filePaths: [] })
    expect(recorder.calls).toEqual([])
  })

  it('turns an error box into one log line', () => {
    const lines: string[] = []
    const d = serverDialogs((m) => lines.push(m))
    d.showErrorBox('Cannot open folder', 'ENOENT')
    expect(lines).toEqual(['Cannot open folder: ENOENT'])
    expect(recorder.calls).toEqual([])
  })
})

describe('electronDialogs', () => {
  it('passes parent and options through unchanged', async () => {
    const d = electronDialogs()
    const parent = { id: 7 } as never
    const box = { message: 'm', buttons: ['a', 'b'] }
    const open = { title: 't', properties: ['openDirectory' as const] }
    expect(await d.showMessageBox(parent, box)).toEqual({ response: 1, checkboxChecked: false })
    expect(await d.showOpenDialog(parent, open)).toEqual({ canceled: false, filePaths: ['/x'] })
    d.showErrorBox('title', 'content')
    expect(recorder.calls).toEqual([
      { fn: 'showMessageBox', args: [parent, box] },
      { fn: 'showOpenDialog', args: [parent, open] },
      { fn: 'showErrorBox', args: ['title', 'content'] }
    ])
  })

  it('uses the parentless overload without a parent', async () => {
    const d = electronDialogs()
    const box = { message: 'm' }
    const open = { properties: ['openDirectory' as const] }
    await d.showMessageBox(undefined, box)
    await d.showOpenDialog(undefined, open)
    expect(recorder.calls).toEqual([
      { fn: 'showMessageBox', args: [box] },
      { fn: 'showOpenDialog', args: [open] }
    ])
  })
})
