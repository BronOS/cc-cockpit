// The terminal entry of uploads (src/renderer/tabs/terminal-drop.ts, design-upload.md §4.1, §4.3, §3.6):
// which terminals take uploads (a Claude or shell tab of the web shell, never a read guest's view or a
// command or page tab), the paste rule (files and no text/plain: an image alone uploads, text plus image
// stays text; Task 1's clipboard results), a drop's folders skipped and named, the container's listeners
// (highlight, the drop as a click on the pane, the paste stopped before xterm), the shell's default
// cancel of a `Files` drop nobody took, and the keys-off and paste seams the upload controller reads at
// the paste. Plain Node: the container is an EventTarget, the events carry their fields by hand.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachTerminalEntry,
  cancelUnhandledFileDrops,
  DROP_TARGET_CLASS,
  droppedFiles,
  onTerminalUpload,
  pastedFiles,
  pasteIntoTerminal,
  registerTerminalPane,
  takesUploads,
  terminalKeysOff,
  type ClipboardLike,
  type DropContainer
} from '../../src/renderer/tabs/terminal-drop'
import { KEYS_OFF_HELD, UploadController, type UploadControllerDeps, type UploadFile } from '../../src/renderer/web/upload-controller'
import { UploadUi } from '../../src/renderer/notices/upload-model'
import { pastedName } from '../../src/shared/uploads'

const NOW = new Date(2026, 10, 22, 9, 5, 7)

/** A clipboard or dropped File as the shell reads it (name, size, type, slice). */
function fakeFile(name: string, type = 'image/png', size = 3) {
  return { name, size, type, slice: vi.fn((start: number, end: number) => new Blob([`${name}:${start}-${end}`])) }
}

const clipboard = (types: string[], files: ReturnType<typeof fakeFile>[]): ClipboardLike => ({ types, files })

/** A drop's item: a file, or a folder (its entry says so; its own File rejects every read). */
const fileItem = (file: ReturnType<typeof fakeFile>) => ({ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, name: file.name }) })
const folderItem = (name: string) => ({ kind: 'file', getAsFile: () => fakeFile(name, ''), webkitGetAsEntry: () => ({ isDirectory: true, name }) })
const stringItem = { kind: 'string', getAsFile: () => null }

function container(): DropContainer & { classes: Set<string>; inside: Set<unknown> } {
  const classes = new Set<string>()
  const inside = new Set<unknown>()
  return Object.assign(new EventTarget(), {
    classes,
    inside,
    classList: { add: (n: string) => void classes.add(n), remove: (n: string) => void classes.delete(n) },
    contains: (other: unknown) => inside.has(other)
  })
}

/** A DOM-like event with its own fields (dataTransfer, clipboardData, relatedTarget). */
function event(type: string, fields: Record<string, unknown> = {}): Event & { stopped: boolean } {
  const e = new Event(type, { cancelable: true }) as Event & { stopped: boolean }
  e.stopped = false
  const stop = e.stopPropagation.bind(e)
  e.stopPropagation = () => {
    e.stopped = true
    stop()
  }
  return Object.assign(e, fields)
}

const filesDrag = (items: unknown[] = []) => ({ types: ['Files'], items, dropEffect: 'none' })

let offs: Array<() => void> = []
afterEach(() => {
  for (const off of offs) off()
  offs = []
})

describe('takesUploads (design §4.1)', () => {
  it('a Claude or shell tab of the web shell, for the owner and a write guest only', () => {
    for (const kind of ['claude', 'shell'] as const) {
      expect(takesUploads(kind, true, 'owner')).toBe(true)
      expect(takesUploads(kind, true, 'write')).toBe(true)
      expect(takesUploads(kind, true, 'read')).toBe(false)
      expect(takesUploads(kind, false, 'owner')).toBe(false)
    }
    // Plugin command tabs and page tabs take nothing.
    expect(takesUploads('command', true, 'owner')).toBe(false)
    expect(takesUploads('page', true, 'owner')).toBe(false)
  })
})

describe('pastedFiles: a paste is an upload only with files and no text/plain (design §4.1, Task 1)', () => {
  it('an image alone uploads, named from the device clock and its type; the bytes stay the clipboard File', () => {
    const image = fakeFile('image.png')
    const files = pastedFiles(clipboard(['Files'], [image]), NOW)
    expect(files?.map((f) => [f.name, f.size])).toEqual([[pastedName('image/png', NOW), 3]])
    expect(files?.[0]?.name).toMatch(/^pasted-20261122-090507\.png$/)
    files?.[0]?.slice(0, 2)
    expect(image.slice).toHaveBeenCalledWith(0, 2)
  })

  it('text plus an image stays a text paste (Excel, Word, a browser Copy image); text alone too; no clipboard is nothing', () => {
    expect(pastedFiles(clipboard(['text/plain', 'text/html', 'Files'], [fakeFile('image.png')]), NOW)).toBeUndefined()
    expect(pastedFiles(clipboard(['Files', 'text/plain'], [fakeFile('image.png')]), NOW)).toBeUndefined()
    expect(pastedFiles(clipboard(['text/plain'], []), NOW)).toBeUndefined()
    expect(pastedFiles(null, NOW)).toBeUndefined()
  })
})

describe('droppedFiles: folders skipped and named (design §5.3)', () => {
  it('keeps the files, names the folders, skips string items and a folder name a notice may not show', () => {
    const a = fakeFile('a.txt', 'text/plain')
    const { files, folders } = droppedFiles({ items: [folderItem('photos'), fileItem(a), stringItem, folderItem('bad‮name')] })
    expect(files).toEqual([a])
    expect(folders).toEqual(['photos'])
  })
})

describe('attachTerminalEntry: the container (design §4.1)', () => {
  function attached() {
    const el = container()
    const select = vi.fn()
    const started: Array<[string, readonly UploadFile[], unknown]> = []
    offs.push(onTerminalUpload((tabId, files, opts) => void started.push([tabId, files, opts])))
    const off = attachTerminalEntry(el, { tabId: 'tab-1', select }, () => NOW)
    offs.push(off)
    return { el, select, started, off }
  }

  it('a Files drag highlights the pane until it leaves it (not for a move onto a child) or drops', () => {
    const { el } = attached()
    const over = event('dragover', { dataTransfer: filesDrag() })
    el.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('copy')
    expect(el.classes.has(DROP_TARGET_CLASS)).toBe(true)
    const child = {}
    el.inside.add(child)
    el.dispatchEvent(event('dragleave', { relatedTarget: child }))
    expect(el.classes.has(DROP_TARGET_CLASS)).toBe(true)
    el.dispatchEvent(event('dragleave', { relatedTarget: null }))
    expect(el.classes.has(DROP_TARGET_CLASS)).toBe(false)
  })

  it('a drag of text (no Files) is left to xterm and the page', () => {
    const { el } = attached()
    const over = event('dragover', { dataTransfer: { types: ['text/plain'], items: [] } })
    el.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
    expect(el.classes.size).toBe(0)
  })

  it('a drop selects the pane (as a click) and starts an upload for the tab, its folders named', () => {
    const { el, select, started } = attached()
    el.dispatchEvent(event('dragover', { dataTransfer: filesDrag() }))
    const a = fakeFile('a.png')
    const drop = event('drop', { dataTransfer: filesDrag([fileItem(a), folderItem('photos')]) })
    el.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(drop.stopped).toBe(true)
    expect(select).toHaveBeenCalledTimes(1)
    expect(started).toEqual([['tab-1', [a], { folders: ['photos'] }]])
    expect(el.classes.size).toBe(0)
  })

  it('a drop with no controller registered is still cancelled (the browser never opens the file), and selects nothing', () => {
    const { el, select, started } = attached()
    for (const off of offs.splice(0, 1)) off() // the upload sink
    const drop = event('drop', { dataTransfer: filesDrag([fileItem(fakeFile('a.png'))]) })
    el.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(select).not.toHaveBeenCalled()
    expect(started).toEqual([])
  })

  it('a file-only paste becomes an upload and never reaches xterm; a paste with text is left alone', () => {
    const { el, started } = attached()
    const image = event('paste', { clipboardData: clipboard(['Files'], [fakeFile('image.png')]) })
    el.dispatchEvent(image)
    expect(image.defaultPrevented).toBe(true)
    expect(image.stopped).toBe(true)
    expect(started).toHaveLength(1)
    expect(started[0]?.[0]).toBe('tab-1')
    expect(started[0]?.[1].map((f) => f.name)).toEqual([pastedName('image/png', NOW)])
    expect(started[0]?.[2]).toEqual({ pasted: true })
    const mixed = event('paste', { clipboardData: clipboard(['text/plain', 'Files'], [fakeFile('image.png')]) })
    el.dispatchEvent(mixed)
    expect(mixed.defaultPrevented).toBe(false)
    expect(mixed.stopped).toBe(false)
    expect(started).toHaveLength(1)
  })

  it("the own-act listener registered before it still hears a file paste; a later one on the element too (stopPropagation, not stopImmediatePropagation)", () => {
    const el = container()
    const order: string[] = []
    el.addEventListener('paste', () => order.push('own act'), true)
    offs.push(onTerminalUpload(() => void order.push('upload')))
    offs.push(attachTerminalEntry(el, { tabId: 't', select: () => undefined }, () => NOW))
    el.dispatchEvent(event('paste', { clipboardData: clipboard(['Files'], [fakeFile('image.png')]) }))
    expect(order).toEqual(['own act', 'upload'])
  })

  it('its removal takes every listener off (a remount attaches again)', () => {
    const { el, off, started, select } = attached()
    off()
    el.dispatchEvent(event('drop', { dataTransfer: filesDrag([fileItem(fakeFile('a.png'))]) }))
    el.dispatchEvent(event('paste', { clipboardData: clipboard(['Files'], [fakeFile('image.png')]) }))
    el.dispatchEvent(event('dragover', { dataTransfer: filesDrag() }))
    expect(started).toEqual([])
    expect(select).not.toHaveBeenCalled()
    expect(el.classes.size).toBe(0)
  })
})

describe('cancelUnhandledFileDrops: a Files drop nobody took does nothing (design §3.6)', () => {
  it('cancels a Files dragover and drop no handler took, and leaves a handled one and other drags alone', () => {
    const win = new EventTarget()
    offs.push(cancelUnhandledFileDrops(win))
    for (const type of ['dragover', 'drop']) {
      const e = event(type, { dataTransfer: filesDrag() })
      win.dispatchEvent(e)
      expect(e.defaultPrevented, type).toBe(true)
      expect((e as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('none')
    }
    const text = event('dragover', { dataTransfer: { types: ['text/plain'] } })
    win.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
    // A target that took it first (a terminal's drop, a Files row) keeps its dropEffect.
    const handled = new EventTarget()
    handled.addEventListener('dragover', (e) => {
      e.preventDefault()
      ;(e as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect = 'copy'
    })
    offs.push(cancelUnhandledFileDrops(handled))
    const taken = event('dragover', { dataTransfer: filesDrag() })
    handled.dispatchEvent(taken)
    expect((taken as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('copy')
  })
})

describe('the paste seams: keys-off and the terminal (design §4.3)', () => {
  it('no pane mounted counts as keys-off and pastes nothing', () => {
    expect(terminalKeysOff()).toBe(true)
    expect(pasteIntoTerminal('t', 'x ')).toBe(false)
  })

  it("reads the mounted pane's keys-off at each call, and again at the paste itself", () => {
    let off = false
    const pasted: Array<[string, string]> = []
    const unregister = registerTerminalPane({ keysOff: () => off, paste: (tabId, text) => (pasted.push([tabId, text]), true) })
    offs.push(unregister)
    expect(terminalKeysOff()).toBe(false)
    expect(pasteIntoTerminal('t', '/p/a.png ')).toBe(true)
    off = true
    expect(terminalKeysOff()).toBe(true)
    expect(pasteIntoTerminal('t', '/p/b.png ')).toBe(false)
    expect(pasted).toEqual([['t', '/p/a.png ']])
    // A stale unregister (an unmount after a remount registered anew) leaves the newer pane.
    const newer = registerTerminalPane({ keysOff: () => false, paste: () => true })
    offs.push(newer)
    unregister()
    expect(terminalKeysOff()).toBe(false)
  })

  it('wired into the controller: keys-off holds the paste before uploads.paste is asked; keys on pastes the text', async () => {
    let off = true
    const pasted: string[] = []
    offs.push(registerTerminalPane({ keysOff: () => off, paste: (_t, text) => (pasted.push(text), true) }))
    const calls: string[] = []
    const invoke = (async (channel: string) => {
      calls.push(channel)
      if (channel === 'uploads.begin') return { uploadId: 'u1', refused: [], clashes: [], tokens: [{ index: 0, token: 'k', name: 'a.png' }] }
      if (channel === 'uploads.paste') return { text: '/p/a.png ' }
      return undefined
    }) as UploadControllerDeps['invoke']
    const run: NonNullable<UploadControllerDeps['run']> = async (_files, tokens) => tokens.map((t) => ({ index: t.index, name: t.name, outcome: 'done' as const }))
    const upload = async (): Promise<UploadUi> => {
      const ui = new UploadUi()
      const c = new UploadController({ invoke, ui, projectId: 'p', run, keysOff: terminalKeysOff, pasteInto: pasteIntoTerminal })
      const done = c.startForTab('t', [{ name: 'a.png', size: 1, slice: () => new Blob([]) }])
      await new Promise((r) => setTimeout(r, 0))
      ui.get().choosers[0]!.onAnswer('')
      await done
      return ui
    }
    const held = await upload()
    expect(calls).not.toContain('uploads.paste')
    expect(held.get().notices.at(-1)).toMatchObject({ held: { reason: KEYS_OFF_HELD } })
    off = false
    calls.length = 0
    await upload()
    expect(calls).toEqual(['uploads.begin', 'uploads.paste'])
    expect(pasted).toEqual(['/p/a.png '])
  })
})
