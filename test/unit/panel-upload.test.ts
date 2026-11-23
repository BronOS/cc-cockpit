// Upload plan, Task 8: `ccPanel.upload` in the panel SDK (src/sdk/panel-core.ts, wired by src/sdk/panel.ts)
// and the shell's filter of a frame's upload message (src/renderer/web/upload-request.ts). The DOM parts
// (the hidden input, a real drop) are fakes here; the e2e drives them (Tasks 12 and 13).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isFilesDrag,
  MAX_UPLOAD_FOLDER_LENGTH,
  PanelClient,
  PORT_MESSAGE,
  splitTransfer,
  UPLOAD_MESSAGE,
  type PortLike,
  type ThemeRoot,
  type UploadItemLike
} from '../../src/sdk/panel-core'
import { markWebShell, resetShellKindForTest, setGuestHint } from '../../src/renderer/shell-kind'
import { onUploadRequest, panelUploadMessage, uploadRequestOf, type UploadRequest } from '../../src/renderer/web/upload-request'

class FakePort implements PortLike {
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(): void {}
  close(): void {}
}

const root: ThemeRoot = { colorScheme: '', setProperty: () => {}, removeProperty: () => {} }

/** A client with a recording parent and a scripted chooser (what the person picks, or null for a cancel). */
function sdk(choice: unknown[] | null = null): {
  c: PanelClient
  sent: Record<string, unknown>[]
  warnings: string[]
  chooserOpened: () => number
} {
  const sent: Record<string, unknown>[] = []
  const warnings: string[] = []
  let opened = 0
  const c = new PanelClient(
    root,
    (m) => warnings.push(m),
    undefined,
    undefined,
    (m) => sent.push(m as Record<string, unknown>),
    undefined,
    (onFiles) => {
      opened++
      if (choice) onFiles(choice)
    }
  )
  return { c, sent, warnings, chooserOpened: () => opened }
}

const connect = (c: PanelClient, remote: boolean, access?: string): void =>
  c.receive({ type: PORT_MESSAGE, remote, ...(access ? { access } : {}) }, [new FakePort()])

const fakeFile = (name: string): { name: string; size: number } => ({ name, size: 3 })

/** A DataTransfer item: a file, a folder (its entry says so; its File is the directory's), or a string. */
function item(kind: 'file' | 'folder' | 'string', name: string, withEntry = true): UploadItemLike {
  if (kind === 'string') return { kind: 'string', getAsFile: () => null }
  const it: UploadItemLike = { kind: 'file', getAsFile: () => fakeFile(name) }
  if (withEntry) it.webkitGetAsEntry = () => ({ name, isDirectory: kind === 'folder' })
  return it
}

describe('ccPanel.upload: where it exists', () => {
  it('is undefined before the port, on the desktop and for a read guest; present for the owner and a write guest', () => {
    const { c } = sdk()
    expect(c.api.upload).toBeUndefined()
    connect(c, false)
    expect(c.api.upload).toBeUndefined()
    connect(c, true, 'read')
    expect(c.api.upload).toBeUndefined()
    connect(c, true, 'write')
    expect(typeof c.api.upload?.pick).toBe('function')
    connect(c, true)
    expect(typeof c.api.upload?.files).toBe('function')
    // A later port that narrows the view takes it away again.
    connect(c, true, 'read')
    expect(c.api.upload).toBeUndefined()
  })

  it('cannot be replaced or widened by the page', () => {
    const { c } = sdk()
    connect(c, true)
    const api = c.api as unknown as Record<string, unknown>
    expect(() => {
      api['upload'] = { pick: () => {} }
    }).toThrow(TypeError)
    expect(Object.isFrozen(c.api.upload)).toBe(true)
  })
})

describe('ccPanel.upload.pick', () => {
  it('opens the chooser in the call and posts the chosen files to the parent', () => {
    const files = [fakeFile('a.png'), fakeFile('b.txt')]
    const { c, sent, chooserOpened } = sdk(files)
    connect(c, true)
    c.api.upload!.pick({ folder: 'docs' })
    expect(chooserOpened()).toBe(1)
    expect(sent).toEqual([{ type: UPLOAD_MESSAGE, folder: 'docs', files, folders: [] }])
  })

  it('posts nothing on a cancel or an empty choice', () => {
    const cancelled = sdk(null)
    connect(cancelled.c, true)
    cancelled.c.api.upload!.pick({ folder: '' })
    expect(cancelled.sent).toEqual([])
    const empty = sdk([])
    connect(empty.c, true)
    empty.c.api.upload!.pick({ folder: '' })
    expect(empty.sent).toEqual([])
  })

  it('refuses a missing or oversized folder at the call, before any chooser', () => {
    const { c, chooserOpened } = sdk([fakeFile('a')])
    connect(c, true)
    expect(() => c.api.upload!.pick({} as { folder: string })).toThrow(TypeError)
    expect(() => c.api.upload!.pick({ folder: 'x'.repeat(MAX_UPLOAD_FOLDER_LENGTH + 1) })).toThrow(RangeError)
    expect(chooserOpened()).toBe(0)
  })
})

describe('ccPanel.upload.files', () => {
  it('splits folders out of a DataTransfer by their entries and posts files and folder names', () => {
    const { c, sent } = sdk()
    connect(c, true)
    const transfer = { items: [item('file', 'a.txt'), item('folder', 'photos'), item('string', ''), item('file', 'b.png')], files: [] }
    c.api.upload!.files(transfer, { folder: 'src' })
    expect(sent).toEqual([
      { type: UPLOAD_MESSAGE, folder: 'src', files: [fakeFile('a.txt'), fakeFile('b.png')], folders: ['photos'] }
    ])
  })

  it('posts folders alone, so core can say they were skipped', () => {
    const { c, sent } = sdk()
    connect(c, true)
    c.api.upload!.files({ items: [item('folder', 'dir')] }, { folder: '' })
    expect(sent).toEqual([{ type: UPLOAD_MESSAGE, folder: '', files: [], folders: ['dir'] }])
  })

  it('takes a FileList or an array of Files as they are', () => {
    const { c, sent } = sdk()
    connect(c, true)
    const list = { length: 2, 0: fakeFile('x'), 1: fakeFile('y') }
    c.api.upload!.files(list, { folder: 'a/b' })
    c.api.upload!.files([fakeFile('z')], { folder: 'a' })
    expect(sent.map((m) => (m['files'] as { name: string }[]).map((f) => f.name))).toEqual([['x', 'y'], ['z']])
  })

  it('warns and posts nothing for a DataTransfer read after its event (no items left)', () => {
    const { c, sent, warnings } = sdk()
    connect(c, true)
    c.api.upload!.files({ items: [], files: [] }, { folder: '' })
    expect(sent).toEqual([])
    expect(warnings.join('\n')).toContain('inside the drop event')
  })

  it('refuses what is not a transfer or a list, and a missing folder', () => {
    const { c } = sdk()
    connect(c, true)
    expect(() => c.api.upload!.files('a.txt' as unknown as File[], { folder: '' })).toThrow(TypeError)
    expect(() => c.api.upload!.files([fakeFile('a')], undefined as unknown as { folder: string })).toThrow(TypeError)
  })
})

describe('splitTransfer and isFilesDrag', () => {
  it('counts an item with no entry API, or no entry, as a file', () => {
    const noApi = item('file', 'old.txt', false)
    const nullEntry: UploadItemLike = { kind: 'file', getAsFile: () => fakeFile('n.txt'), webkitGetAsEntry: () => null }
    expect(splitTransfer({ items: [noApi, nullEntry] })).toEqual({ files: [fakeFile('old.txt'), fakeFile('n.txt')], folders: [] })
  })

  it('tells a Files drag from a text or link drag', () => {
    expect(isFilesDrag(['Files'])).toBe(true)
    expect(isFilesDrag(['text/plain', 'Files'])).toBe(true)
    expect(isFilesDrag(['text/plain', 'text/uri-list'])).toBe(false)
    expect(isFilesDrag(undefined)).toBe(false)
  })
})

describe('the shell filter (upload-request.ts)', () => {
  const frame = { name: 'the panel frame window' }
  const realFile = (name: string): File => new File(['abc'], name)
  const message = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: UPLOAD_MESSAGE,
    folder: 'docs',
    files: [realFile('a.txt')],
    folders: ['dir'],
    ...extra
  })

  beforeEach(() => {
    resetShellKindForTest()
    markWebShell()
  })
  afterEach(() => resetShellKindForTest())

  it("maps a panel's message to its key", () => {
    const request = uploadRequestOf('cockpit.files/tree', { source: frame, data: message() }, frame)
    expect(request).toMatchObject({ source: { panel: 'cockpit.files/tree' }, folder: 'docs', folders: ['dir'] })
    expect(request?.files.map((f) => f.name)).toEqual(['a.txt'])
  })

  it('drops a message from a foreign window, and one with no frame window', () => {
    expect(uploadRequestOf('p/x', { source: { other: true }, data: message() }, frame)).toBeNull()
    expect(uploadRequestOf('p/x', { source: null, data: message() }, null)).toBeNull()
  })

  it('drops it in the desktop shell and in a read guest view', () => {
    resetShellKindForTest()
    expect(uploadRequestOf('p/x', { source: frame, data: message() }, frame)).toBeNull()
    markWebShell()
    setGuestHint({ id: 'g', name: 'G', role: 'read', ownerName: 'O' })
    expect(uploadRequestOf('p/x', { source: frame, data: message() }, frame)).toBeNull()
    setGuestHint({ id: 'g', name: 'G', role: 'write', ownerName: 'O' })
    expect(uploadRequestOf('p/x', { source: frame, data: message() }, frame)).not.toBeNull()
  })

  it('drops forged fields: another type, a bad folder, entries that are not Files, nothing at all', () => {
    const of = (data: unknown): UploadRequest | null => uploadRequestOf('p/x', { source: frame, data }, frame)
    expect(of(message({ type: 'cc-plugin.ready' }))).toBeNull()
    expect(of(message({ folder: 7 }))).toBeNull()
    expect(of(message({ folder: 'x'.repeat(MAX_UPLOAD_FOLDER_LENGTH + 1) }))).toBeNull()
    expect(of(message({ files: [{ name: 'a', size: 1 }] }))).toBeNull()
    expect(of(message({ files: 'a' }))).toBeNull()
    expect(of(message({ files: [], folders: [] }))).toBeNull()
    expect(of(null)).toBeNull()
    // Bad folder names are dropped from the notice, not the upload.
    expect(of(message({ folders: [3, '', 'x'.repeat(300), 'ok'] }))?.folders).toEqual(['ok'])
  })

  it('hands a request to the registered controller only, and drops it with none', () => {
    expect(panelUploadMessage('p/x', { source: frame, data: message() }, frame)).toBe(false)
    const got: UploadRequest[] = []
    const off = onUploadRequest((r) => got.push(r))
    expect(panelUploadMessage('p/x', { source: frame, data: message() }, frame)).toBe(true)
    expect(panelUploadMessage('p/x', { source: frame, data: { type: 'cc-plugin.slot-height', height: 40 } }, frame)).toBe(false)
    off()
    expect(panelUploadMessage('p/x', { source: frame, data: message() }, frame)).toBe(false)
    expect(got.map((r) => r.source)).toEqual([{ panel: 'p/x' }])
  })
})

describe('only a panel frame routes uploads', () => {
  // html overlays (which Claude can author), slots, the plugin settings page and page tabs mount PluginFrame
  // without the upload route, so a `cc-plugin.upload` from them is ignored. Kept so by source: the route is
  // called from PluginPanel.tsx alone, and no other renderer file names the message.
  const rendererDir = resolve(__dirname, '../../src/renderer')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : []
    })
  const sources = files(rendererDir).map((full) => ({ path: relative(rendererDir, full), text: readFileSync(full, 'utf8') }))

  it('calls panelUploadMessage from PluginPanel.tsx only', () => {
    const callers = sources.filter((s) => s.text.includes('panelUploadMessage(') && s.path !== join('web', 'upload-request.ts'))
    expect(callers.map((s) => s.path)).toEqual([join('zones', 'PluginPanel.tsx')])
  })

  it('names the upload message nowhere else in the renderer', () => {
    const naming = sources.filter((s) => s.text.includes('UPLOAD_MESSAGE') || s.text.includes("'cc-plugin.upload'"))
    expect(naming.map((s) => s.path)).toEqual([join('web', 'upload-request.ts')])
    for (const frame of ['overlays/HtmlOverlay.tsx', 'zones/SlotFrame.tsx', 'settings/PluginSettingsPage.tsx', 'tabs/PageTabArea.tsx']) {
      const text = sources.find((s) => s.path === frame)?.text
      expect(text, frame).toBeDefined()
      expect(text).not.toContain('upload-request')
    }
  })
})
