import { describe, expect, it } from 'vitest'
import {
  AcceptedOffers,
  DOWNLOAD_DIALOG_TITLE,
  stripUnsafe,
  downloadDialogText,
  downloadOfferOf,
  offerAcceptPayload,
  skippedText,
  totalsText
} from '../../src/renderer/notices/download-dialog-model'
import { addSharedAsk, dropSharedAsk } from '../../src/renderer/notices/notice-state'
import type { DownloadOffer } from '../../src/shared/downloads'

const file: DownloadOffer = { requestId: 'r1', path: '/home/u/p/report.pdf', name: 'report.pdf', outside: false, runnable: false, kind: 'file', size: 2_300_000 }
const folder: DownloadOffer = {
  requestId: 'r2',
  path: '/home/u/p/src',
  name: 'src.zip',
  outside: false,
  runnable: false,
  kind: 'folder',
  counts: { plain: { files: 312, folders: 0, bytes: 48_000_000 }, all: { files: 9000, folders: 40, bytes: 900_000_000 } },
  skipped: { symlink: 3, unreadable: 1 }
}

describe('download dialog text', () => {
  it('shows a file whole with its size and no tab title', () => {
    const t = downloadDialogText(file)
    expect(t.title).toBe(DOWNLOAD_DIALOG_TITLE)
    expect(t.path).toBe('/home/u/p/report.pdf')
    expect(t.sizeLine).toBe('2.3 MB')
    expect(t.kindLine).toBe('File')
    expect(t.real).toBeUndefined()
    expect(t.outsideLine).toBeUndefined()
    expect(t.includeLabel).toBeUndefined()
  })

  it('never cuts a long path and shows the real path of a link', () => {
    const long = '/' + 'very-long-directory-name/'.repeat(40) + 'file.txt'
    const t = downloadDialogText({ ...file, path: long, real: '/etc/passwd' })
    expect(t.path).toBe(long)
    expect(t.real).toBe('/etc/passwd')
  })

  it('drops bidi and control characters from a path for display', () => {
    expect(stripUnsafe('/a/report‮fdp.exe')).toBe('/a/reportfdp.exe')
    expect(stripUnsafe('/a/b\nc')).toBe('/a/bc')
  })

  it('warns for outside the project and for a file that can run programs', () => {
    const t = downloadDialogText({ ...file, outside: true, runnable: true })
    expect(t.outsideLine).toBe('This is outside the project.')
    expect(t.runnableLine).toBe('This file can run programs when opened.')
  })

  it('describes a folder: totals before compression, skip counts, both sizes on the checkbox', () => {
    const t = downloadDialogText(folder)
    expect(t.kindLine).toBe('Folder, sent as a .zip')
    expect(t.sizeLine).toBe('312 files, 48 MB before compression')
    expect(t.skippedLine).toBe('Left out: 3 symbolic links, 1 unreadable entries.')
    expect(t.includeLabel).toContain('9000 files, 40 folders, 900 MB before compression')
    expect(t.includeLabel).toContain('without them 312 files, 48 MB before compression')
    expect(t.includeNote).toBeUndefined()
  })

  it('says so when the include choice is over a cap', () => {
    const t = downloadDialogText({ ...folder, allTooLarge: true } as DownloadOffer)
    expect(t.includeLabel).toContain('at least')
    expect(t.includeNote).toBeDefined()
  })

  it('has no skipped line when nothing was left out', () => {
    expect(skippedText({})).toBeUndefined()
    expect(totalsText({ files: 1, folders: 0, bytes: 5 })).toBe('1 file, 5 B before compression')
  })
})

describe('the accept payload', () => {
  it('is unchecked by default and carries the checkbox', () => {
    expect(offerAcceptPayload(folder, false)).toEqual({ requestId: 'r2', all: false })
    expect(offerAcceptPayload(folder, true)).toEqual({ requestId: 'r2', all: true })
  })

  it('never asks for all on a file or past a cap', () => {
    expect(offerAcceptPayload(file, true).all).toBe(false)
    expect(offerAcceptPayload({ ...folder, allTooLarge: true } as DownloadOffer, true).all).toBe(false)
  })

  it('remembers the include choice for Try again, bounded', () => {
    const a = new AcceptedOffers()
    expect(a.get('x')).toBeUndefined()
    a.note('x', true)
    expect(a.get('x')).toBe(true)
    for (let i = 0; i < 40; i++) a.note(`n${i}`, false)
    expect(a.get('x')).toBeUndefined()
    expect(a.get('n39')).toBe(false)
  })
})

describe('offer parsing and settling', () => {
  it('round-trips a valid offer and refuses malformed ones', () => {
    expect(downloadOfferOf(file)).toEqual(file)
    expect(downloadOfferOf(folder)).toEqual(folder)
    expect(downloadOfferOf(null)).toBeUndefined()
    expect(downloadOfferOf({ ...file, size: 'big' })).toBeUndefined()
    expect(downloadOfferOf({ ...file, kind: 'socket' })).toBeUndefined()
    expect(downloadOfferOf({ ...folder, counts: {} })).toBeUndefined()
    expect(downloadOfferOf({ ...file, requestId: '' })).toBeUndefined()
  })

  it('queues once per id and a settle takes the dialog down', () => {
    let q: readonly DownloadOffer[] = []
    q = addSharedAsk(q, file)
    q = addSharedAsk(q, file)
    q = addSharedAsk(q, folder)
    expect(q.map((o) => o.requestId)).toEqual(['r1', 'r2'])
    q = dropSharedAsk(q, 'r1')
    expect(q.map((o) => o.requestId)).toEqual(['r2'])
    expect(dropSharedAsk(q, 'nope')).toEqual(q)
  })
})
