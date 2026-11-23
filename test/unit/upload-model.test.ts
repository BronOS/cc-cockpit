import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  chooserHeading,
  chooserKey,
  clashText,
  copyLabel,
  heldButtons,
  heldCopyable,
  heldText,
  noticeHides,
  nothingUploadedText,
  shownDialogs,
  presetKey,
  progressFraction,
  progressText,
  readPreset,
  replaceAllowed,
  resultText,
  startingFolder,
  UploadUi,
  writePreset,
  type FolderLister,
  type PresetStorage
} from '../../src/renderer/notices/upload-model'

const mem = (): PresetStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}
const throwing: PresetStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  }
}

describe('chooser heading and preset', () => {
  it('counts the files and their size', () => {
    expect(chooserHeading([{ name: 'a', size: 1_000_000 }, { name: 'b', size: 2_100_000 }])).toBe('Upload 2 files (3.1 MB) to')
    expect(chooserHeading([{ name: 'a', size: 5 }])).toBe('Upload 1 file (5 B) to')
  })

  it('reads the stored folder per project and writes it back', () => {
    const s = mem()
    writePreset(s, 'p1', 'src/assets')
    expect(s.data.get(presetKey('p1'))).toBe('src/assets')
    expect(readPreset(s, 'p1')).toBe('src/assets')
    expect(readPreset(s, 'p2')).toBe('')
  })

  it('falls back to the project folder when storage throws, is absent or holds a bad path', () => {
    expect(readPreset(throwing, 'p')).toBe('')
    expect(() => writePreset(throwing, 'p', 'a')).not.toThrow()
    expect(readPreset(undefined, 'p')).toBe('')
    for (const bad of ['/etc', '../x', 'a//b', 'a/./b', '']) {
      const s = mem()
      s.data.set(presetKey('p'), bad)
      expect(readPreset(s, 'p')).toBe('')
    }
  })

  it('opens on the preset only when it and every folder above it still list', async () => {
    const tree: Record<string, string[]> = { '': ['src'], src: ['assets'], 'src/assets': [] }
    const list: FolderLister = async (path) => (path in tree ? { folders: tree[path]!, more: false } : { error: 'gone' })
    expect(ancestorsOf('src/assets')).toEqual(['src'])
    const ok = await startingFolder('src/assets', list)
    expect(ok.folder).toBe('src/assets')
    expect([...ok.listings.keys()]).toEqual(['', 'src', 'src/assets'])
    // The stored folder was deleted: back to the project folder, its first level still listed.
    const gone = await startingFolder('src/old', list)
    expect(gone.folder).toBe('')
    expect([...gone.listings.keys()]).toEqual(['', 'src'])
    // A rejecting call is a failure too.
    const bad = await startingFolder('src', () => Promise.reject(new Error('x')))
    expect(bad.folder).toBe('')
    expect(bad.listings.size).toBe(0)
    expect((await startingFolder('', list)).folder).toBe('')
  })
})

describe('clash dialog text', () => {
  const clashes = [
    { index: 0, name: 'logo.png', replaceable: true },
    { index: 1, name: 'README.md', replaceable: true }
  ]
  it('names every clash and the folder', () => {
    const t = clashText('src/assets', clashes)
    expect(t.title).toBe('2 files already exist in src/assets: logo.png, README.md')
    expect(t.replaceOff).toBeUndefined()
    expect(replaceAllowed(clashes)).toBe(true)
    expect(clashText('', [clashes[0]!]).title).toBe('1 file already exists in the project folder: logo.png')
  })

  it('turns Replace off with the reason when a clash is a folder or a link', () => {
    const mixed = [...clashes, { index: 2, name: 'icons', replaceable: false }]
    expect(replaceAllowed(mixed)).toBe(false)
    expect(clashText('src', mixed).replaceOff).toBe('Replace is off: icons is a folder or a link')
  })

  it('drops control and bidi characters from names for display', () => {
    expect(clashText('', [{ index: 0, name: 'a‮b.txt', replaceable: true }]).title).toContain('ab.txt')
  })
})

describe('notice texts', () => {
  const base = { folder: 'src/assets', fileCount: 3 }
  it('progress says the file, the folder and the bytes', () => {
    const n = { folder: 'src/assets', fileNo: 2, fileCount: 3, sent: 42_000_000, total: 120_000_000 }
    expect(progressText(n)).toBe('Uploading 2 of 3 to src/assets: 42 MB of 120 MB')
    expect(progressFraction(n)).toBeCloseTo(0.35)
    expect(progressFraction({ sent: 0, total: 0 })).toBe(1)
    expect(progressFraction({ sent: 9, total: 3 })).toBe(1)
  })

  it('a clean result names up to three files and hides', () => {
    expect(resultText({ ...base, done: ['a.png', 'b.png', 'c.png'], failed: [] })).toEqual({ text: 'Uploaded a.png, b.png, c.png to src/assets', sticky: false })
    expect(resultText({ ...base, fileCount: 4, done: ['a', 'b', 'c', 'd'], failed: [] })).toEqual({ text: 'Uploaded 4 files to src/assets', sticky: false })
    expect(resultText({ folder: '', fileCount: 1, done: ['a'], failed: [] }).text).toBe('Uploaded a to the project folder')
  })

  it('a partial result says what failed and stays', () => {
    const r = resultText({ ...base, done: ['a', 'b'], failed: [{ name: 'x.bin', reason: "the server's disk is full" }] })
    expect(r).toEqual({ text: "Uploaded 2 of 3 to src/assets; not uploaded: x.bin (the server's disk is full)", sticky: true })
    const many = resultText({ folder: 'd', fileCount: 8, done: ['a'], failed: ['1', '2', '3', '4', '5', '6', '7'].map((name) => ({ name, reason: 'r' })) })
    expect(many.text).toContain('and 4 more')
  })

  it('nothing uploaded names the reason, a cancel says so', () => {
    expect(resultText({ ...base, fileCount: 1, done: [], failed: [{ name: 'x', reason: 'too big' }] })).toEqual({ text: 'Nothing uploaded: x (too big)', sticky: true })
    expect(nothingUploadedText('the folder is inside .git')).toBe('Nothing uploaded: the folder is inside .git')
    expect(resultText({ ...base, done: [], failed: [], cancelled: true })).toEqual({ text: 'Upload cancelled', sticky: true })
    expect(resultText({ ...base, done: ['a'], failed: [], cancelled: true }).text).toBe('Cancelled after 1 of 3 to src/assets')
  })

  it('skipped folders are named and keep the notice', () => {
    const r = resultText({ ...base, fileCount: 1, done: ['a.txt'], failed: [], folders: ['photos', 'raw'] })
    expect(r).toEqual({ text: "Uploaded a.txt to src/assets; folders can't be uploaded: photos, raw", sticky: true })
    expect(resultText({ folder: '', fileCount: 0, done: [], failed: [], folders: ['photos'] }).text).toBe("Nothing uploaded: folders can't be uploaded: photos")
  })

  it('a held paste gets Paste path and Copy with the reason; no held paste, no buttons', () => {
    expect(heldButtons({})).toBeUndefined()
    expect(heldButtons({ held: { reason: 'Claude is working', text: '/p/a.png ' } })).toEqual({ paste: 'Paste path', copy: 'Copy' })
    expect(heldText({ reason: 'Claude is working', text: '' })).toBe('Not pasted: Claude is working')
  })
})

describe('UploadUi store', () => {
  it('queues choosers and clashes oldest first and replaces a notice by id', () => {
    const ui = new UploadUi()
    let calls = 0
    const off = ui.subscribe(() => calls++)
    ui.showChooser({ id: 'a', tab: 't', files: [], preset: '', onAnswer: () => {} })
    ui.showChooser({ id: 'b', tab: 't', files: [], preset: '', onAnswer: () => {} })
    ui.endChooser('a')
    expect(ui.get().choosers.map((c) => c.id)).toEqual(['b'])
    ui.putNotice({ kind: 'progress', id: 'u', folder: '', fileNo: 1, fileCount: 1, sent: 0, total: 1, onCancel: () => {} })
    ui.putNotice({ kind: 'result', id: 'u', text: 'done', sticky: false })
    expect(ui.get().notices).toHaveLength(1)
    expect(ui.get().notices[0]!.kind).toBe('result')
    const before = calls
    ui.dropNotice('nope')
    ui.endClash('nope')
    expect(calls).toBe(before)
    ui.clear()
    expect(ui.get().notices).toEqual([])
    off()
  })
})

describe('review fixes (task 9)', () => {
  it('the clash title names at most three files; the full list is kept for the scrolling body', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ index: i, name: `file-${i}.txt`, replaceable: true }))
    const t = clashText('src', many)
    expect(t.title).toBe('40 files already exist in src: file-0.txt, file-1.txt, file-2.txt and 37 more')
    expect(t.names).toHaveLength(40)
    expect(t.names[39]).toBe('file-39.txt')
  })

  it('a held paste never hides, whatever sticky says; only a clean result does', () => {
    expect(noticeHides({ kind: 'result', id: 'a', text: 't', sticky: false })).toBe(true)
    expect(noticeHides({ kind: 'result', id: 'a', text: 't', sticky: true })).toBe(false)
    expect(noticeHides({ kind: 'result', id: 'a', text: 't', sticky: false, held: { reason: 'r', text: '/p/a ' } })).toBe(false)
    expect(noticeHides({ kind: 'progress', id: 'a', folder: '', fileNo: 1, fileCount: 1, sent: 0, total: 1, onCancel: () => {} })).toBe(false)
  })

  it('Copy is offered only for text stripUnsafe would keep as it is', () => {
    expect(heldCopyable({ reason: 'r', text: '/p/a.png ' })).toBe(true)
    expect(heldCopyable({ reason: 'r', text: '' })).toBe(false)
    expect(heldCopyable({ reason: 'r', text: '/p/x\u001b[201~/a.png ' })).toBe(false)
    expect(heldCopyable({ reason: 'r', text: '/p/a‮gnp.exe ' })).toBe(false)
    expect(heldButtons({ held: { reason: 'r', text: '/p/x\u001b[201~ ' } })).toEqual({ paste: 'Paste path' })
    expect(copyLabel(undefined)).toBe('Copy')
    expect(copyLabel(true)).toBe('Copied')
    expect(copyLabel(false)).toBe('Copy failed')
  })

  it('fileCount includes main refusals; a cancel still names the files main refused', () => {
    // 3 dropped, 1 refused at begin, 2 uploaded.
    const partial = resultText({ folder: 'd', fileCount: 3, done: ['a', 'b'], failed: [{ name: 'x', reason: 'too big' }] })
    expect(partial.text).toBe('Uploaded 2 of 3 to d; not uploaded: x (too big)')
    expect(resultText({ folder: 'd', fileCount: 3, done: ['a'], failed: [{ name: 'x', reason: 'too big' }], cancelled: true }).text).toBe(
      'Cancelled after 1 of 3 to d; not uploaded: x (too big)'
    )
    expect(resultText({ folder: 'd', fileCount: 3, done: [], failed: [{ name: 'x', reason: 'too big' }], cancelled: true })).toEqual({
      text: 'Upload cancelled; not uploaded: x (too big)',
      sticky: true
    })
  })

  it('the chooser: Enter uploads from the box or a folder name once ready and on top; Esc cancels', () => {
    expect(chooserKey('Enter', 'dialog', true, true)).toBe('upload')
    expect(chooserKey('Enter', 'folder', true, true)).toBe('upload')
    expect(chooserKey('Enter', 'other', true, true)).toBe('pass')
    // Before the preset's listing is in, Enter would send to the project folder.
    expect(chooserKey('Enter', 'dialog', false, true)).toBe('pass')
    expect(chooserKey('Escape', 'other', false, true)).toBe('cancel')
    // Covered by an approval: no key answers.
    expect(chooserKey('Enter', 'dialog', true, false)).toBe('pass')
    expect(chooserKey('Escape', 'dialog', true, false)).toBe('pass')
    expect(chooserKey('y', 'dialog', true, true)).toBe('pass')
  })

  it('one dialog at a time: a clash first, the chooser only when no clash is up', () => {
    const chooser = { id: 'c', tab: 't', files: [], preset: '', onAnswer: () => {} }
    const clash = { id: 'k', folder: '', clashes: [], onAnswer: () => {} }
    expect(shownDialogs({ choosers: [chooser], clashes: [clash] })).toEqual({ clash })
    expect(shownDialogs({ choosers: [chooser], clashes: [] })).toEqual({ chooser })
    expect(shownDialogs({ choosers: [], clashes: [] })).toEqual({})
  })
})

describe('clash dialog markup', () => {
  type Req = { id: string; folder: string; clashes: { index: number; name: string; replaceable: boolean }[]; onAnswer(c: string): void }
  async function render(clashes: Req['clashes']): Promise<string> {
    // A .tsx module, loaded by a path the node typecheck does not follow (it has no JSX or DOM lib).
    const file = '../../src/renderer/notices/UploadClashDialog.tsx'
    const { UploadClashBox } = (await import(file)) as { UploadClashBox: FunctionComponent<{ request: Req }> }
    return renderToStaticMarkup(createElement(UploadClashBox, { request: { id: 'r', folder: 'src', clashes, onAnswer: () => {} } }))
  }

  it('Keep both and Replace are plain buttons, disabled until armed; names are text', async () => {
    const html = await render([{ index: 0, name: '<img src=x onerror=alert(1)>.png', replaceable: true }])
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.png')
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toContain('type="button"')
    expect(html).toMatch(/<button type="button" data-testid="upload-clash-keep-both" disabled="">Keep both<\/button>/)
    expect(html).toMatch(/<button type="button" class="confirm-danger" data-testid="upload-clash-replace" disabled="">Replace<\/button>/)
    expect(html).not.toContain('upload-clash-names')
  })

  it('a clash that is not replaceable shows no Replace, still a guarded Keep both', async () => {
    const html = await render([
      { index: 0, name: 'a.txt', replaceable: true },
      { index: 1, name: 'icons', replaceable: false }
    ])
    expect(html).not.toContain('upload-clash-replace"')
    expect(html).toMatch(/data-testid="upload-clash-keep-both" disabled="">Keep both</)
    expect(html).toContain('Replace is off: icons is a folder or a link')
  })

  it('many clashes: the title is capped and every name is in the scrolling list', async () => {
    const html = await render(Array.from({ length: 10 }, (_, i) => ({ index: i, name: `f${i}`, replaceable: true })))
    expect(html).toContain('and 7 more')
    expect(html).toContain('data-testid="upload-clash-names"')
    expect(html).toContain('<li>f9</li>')
  })
})
