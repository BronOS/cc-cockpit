// The web shell's side of a download (renderer/notices/download-start.ts, design-download.md §2.1,
// §3.2): a `downloads.start` clicked while the click's activation holds, else the "ready — Download"
// notice; a malformed one never reaches an href; `downloads.failed` as a notice.
import { describe, expect, it } from 'vitest'
import {
  addDownloadNotice,
  clickDownload,
  downloadFailedOf,
  downloadFailedText,
  downloadStartAction,
  downloadStartOf,
  dropDownloadNotice,
  MAX_DOWNLOAD_NOTICES,
  type DownloadDocument,
  type DownloadNotice
} from '../../src/renderer/notices/download-start'
import { isDownloadUrl } from '../../src/shared/downloads'

const TOKEN = 'A'.repeat(40) + '_-9'
const start = { requestId: 'download-1', url: `/d/${TOKEN}`, name: 'report.pdf' }
const web = { webShell: true, activationActive: true }

describe('downloadStartAction', () => {
  it('clicks while the activation holds, shows the notice without it', () => {
    expect(downloadStartAction(start, web)).toEqual({ kind: 'click', start })
    expect(downloadStartAction(start, { webShell: true, activationActive: false })).toEqual({ kind: 'notice', start })
  })

  it('does nothing outside the web shell (the desktop page has the file already)', () => {
    expect(downloadStartAction(start, { webShell: false, activationActive: true })).toEqual({ kind: 'none' })
  })

  it('never takes a url that is not the route and a token', () => {
    for (const url of [
      'https://evil.example/d/' + TOKEN,
      '//evil.example/d/' + TOKEN,
      'javascript:alert(1)',
      `/d/${TOKEN}/x`,
      `/d/${TOKEN}?x=1`,
      `/d/${TOKEN.slice(1)}`,
      `/d/${TOKEN}A`,
      `/p/${TOKEN}`,
      `/d/${'+'.repeat(43)}`,
      42
    ]) {
      expect(isDownloadUrl(url), String(url)).toBe(false)
      expect(downloadStartAction({ ...start, url }, web), String(url)).toEqual({ kind: 'none' })
    }
    for (const bad of [null, 'x', { ...start, requestId: '' }, { ...start, requestId: 3 }, { ...start, name: undefined }]) {
      expect(downloadStartOf(bad)).toBeUndefined()
    }
  })

  it('makes the name display-safe again (a bidi override, a slash)', () => {
    const got = downloadStartOf({ ...start, name: 'report\u202efdp.exe/x' })
    expect(got?.name).toBe('reportfdp.exe_x')
  })
})

describe('clickDownload', () => {
  it('clicks an attached, hidden same-origin <a download> and removes it', () => {
    const log: string[] = []
    const a = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: () => log.push(`click ${a.href} ${a.download} ${a.rel} ${a.style.display}`),
      remove: () => log.push('remove')
    }
    const doc: DownloadDocument = {
      createElement: () => a,
      body: { appendChild: () => log.push('append') }
    }
    clickDownload(doc, start)
    expect(log).toEqual(['append', `click /d/${TOKEN} report.pdf noreferrer none`, 'remove'])
  })

  it('removes the anchor when the click throws', () => {
    const log: string[] = []
    const doc: DownloadDocument = {
      createElement: () => ({
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: () => {
          throw new Error('blocked')
        },
        remove: () => log.push('remove')
      }),
      body: { appendChild: () => undefined }
    }
    expect(() => clickDownload(doc, start)).toThrow('blocked')
    expect(log).toEqual(['remove'])
  })
})

describe('download notices', () => {
  const ready = (id: string): DownloadNotice => ({ kind: 'ready', requestId: id, url: `/d/${TOKEN}`, name: `${id}.pdf` })

  it('keeps one per request (a failure replaces its ready link) and at most the cap, the oldest going', () => {
    let list = addDownloadNotice([], ready('a'))
    list = addDownloadNotice(list, { kind: 'failed', requestId: 'a', name: 'a.pdf', reason: 'the file changed' })
    expect(list).toEqual([{ kind: 'failed', requestId: 'a', name: 'a.pdf', reason: 'the file changed' }])
    for (const id of ['b', 'c', 'd', 'e']) list = addDownloadNotice(list, ready(id))
    expect(list).toHaveLength(MAX_DOWNLOAD_NOTICES)
    expect(list.map((n) => n.requestId)).toEqual(['b', 'c', 'd', 'e'])
    expect(dropDownloadNotice(list, 'c').map((n) => n.requestId)).toEqual(['b', 'd', 'e'])
    expect(dropDownloadNotice(list, 'zz')).toBe(list)
  })

  it('reads a failure, named when the start was seen here', () => {
    expect(downloadFailedOf({ requestId: 'a', reason: 'cut' })).toEqual({ requestId: 'a', reason: 'cut' })
    expect(downloadFailedOf({ requestId: 'a' })).toBeUndefined()
    expect(downloadFailedOf(null)).toBeUndefined()
    expect(downloadFailedText({ name: 'a.pdf', reason: 'the link expired' })).toBe('a.pdf could not be downloaded: the link expired')
    expect(downloadFailedText({ reason: 'the link expired' })).toBe('The download failed: the link expired')
  })
})
