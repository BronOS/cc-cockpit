import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  chooserHeading,
  clashText,
  heldButtons,
  heldText,
  nothingUploadedText,
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
