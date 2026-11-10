// The window close dialog with browsers attached (windows/close-dialog.ts, design-web.md §5.6):
// Keep running is the default and Esc cancels, the devices are named in a short phrase, a window
// that is gone asks nothing, a box that fails closes for everyone, and the test-run fake records
// and answers in order.
import { describe, expect, it, vi } from 'vitest'
import { closeDialogOptions, devicesText, electronAskClose, QueuedCloseAsk } from '../../src/main/windows/close-dialog'

describe('devicesText', () => {
  it('names one or two devices, and caps a longer list with a count', () => {
    expect(devicesText(['Pixel'])).toBe('Pixel')
    expect(devicesText(['Pixel', 'iPad'])).toBe('Pixel and iPad')
    expect(devicesText(['Pixel', 'iPad', 'Mac', 'Work'])).toBe('Pixel, iPad and 2 more')
    expect(devicesText([])).toBe('a browser')
  })
})

describe('closeDialogOptions', () => {
  it('offers Close for everyone, Keep running for the devices and Cancel; Enter keeps running, Esc cancels', () => {
    const o = closeDialogOptions(['Pixel'])
    expect(o.buttons).toEqual(['Close for everyone', 'Keep running for Pixel', 'Cancel'])
    expect(o.defaultId).toBe(1)
    expect(o.cancelId).toBe(2)
    expect(o.message).toBe('Pixel has this project open in a browser.')
    expect(o.detail).toMatch(/open the project again/)
    expect(closeDialogOptions(['Pixel', 'iPad']).message).toBe('Pixel and iPad have this project open in a browser.')
  })
})

describe('electronAskClose', () => {
  it('maps the button to the choice, as a sheet on the window', async () => {
    const parent = { id: 7 }
    for (const [response, choice] of [
      [0, 'everyone'],
      [1, 'keep'],
      [2, 'cancel'],
      [9, 'cancel']
    ] as const) {
      const showMessageBox = vi.fn(async () => ({ response }))
      const ask = electronAskClose({ windowOf: (id) => (id === 7 ? parent : undefined), showMessageBox })
      await expect(ask(7, ['Pixel'])).resolves.toBe(choice)
      expect(showMessageBox).toHaveBeenCalledWith(parent, expect.objectContaining({ cancelId: 2 }))
    }
  })

  it('a window that is gone asks nothing; a box that fails closes for everyone', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    await expect(electronAskClose({ windowOf: () => undefined, showMessageBox })(7, ['Pixel'])).resolves.toBe('cancel')
    expect(showMessageBox).not.toHaveBeenCalled()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = electronAskClose({
      windowOf: () => ({}),
      showMessageBox: async () => {
        throw new Error('no display')
      }
    })
    await expect(failing(7, ['Pixel'])).resolves.toBe('everyone')
    warn.mockRestore()
  })
})

describe('QueuedCloseAsk', () => {
  it('records each ask and answers in order; none queued cancels', async () => {
    const q = new QueuedCloseAsk()
    q.answer('keep', 'everyone')
    await expect(q.ask(1, ['Pixel'])).resolves.toBe('keep')
    await expect(q.ask(2, ['iPad'])).resolves.toBe('everyone')
    await expect(q.ask(3, [])).resolves.toBe('cancel')
    expect(q.asks()).toEqual([
      { windowId: 1, devices: ['Pixel'] },
      { windowId: 2, devices: ['iPad'] },
      { windowId: 3, devices: [] }
    ])
  })
})
