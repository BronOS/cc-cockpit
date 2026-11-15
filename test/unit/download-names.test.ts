// The name rules of src/shared/downloads.ts (design-download.md §3.1 for the gateway's name and header,
// §3.3 for the remote window's save name): what the browser shows and saves, what Node's writeHead
// accepts, and what the desktop writes into its own Downloads folder from a name an untrusted page chose.
import { describe, expect, it } from 'vitest'
import { contentDisposition, desktopSaveName, DOWNLOAD_NAME_MAX_BYTES, downloadName } from '../../src/shared/downloads'

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
const RLO = '\u202e'

describe('downloadName', () => {
  it('keeps an ordinary name, dot files included', () => {
    expect(downloadName('report.pdf')).toBe('report.pdf')
    expect(downloadName('.env')).toBe('.env')
    expect(downloadName('Отчёт 2026.pdf')).toBe('Отчёт 2026.pdf')
  })

  it('makes / and \\ into _ and drops control, bidi and invisible characters', () => {
    expect(downloadName('../x')).toBe('.._x')
    expect(downloadName('a\\..\\..\\x')).toBe('a_.._.._x')
    expect(downloadName(`report${RLO}fdp.exe`)).toBe('reportfdp.exe')
    expect(downloadName('a\r\nSet-Cookie: x.txt')).toBe('aSet-Cookie: x.txt')
    expect(downloadName('a\u200b\u2066b.txt')).toBe('ab.txt')
  })

  it('an empty or all-invisible name becomes download', () => {
    expect(downloadName('')).toBe('download')
    expect(downloadName(`  ${RLO}\u0000 `)).toBe('download')
  })

  it('cuts past 200 bytes on a code point, keeping the last extension', () => {
    const long = `${'ж'.repeat(150)}.txt`
    expect(bytes(long)).toBe(304)
    const cut = downloadName(long)
    expect(bytes(cut)).toBeLessThanOrEqual(DOWNLOAD_NAME_MAX_BYTES)
    expect(cut.endsWith('.txt')).toBe(true)
    expect(cut).toBe(`${'ж'.repeat(98)}.txt`)
    // Four-byte characters are never split into a lone surrogate.
    const emoji = downloadName(`${'😀'.repeat(80)}.md`)
    expect(emoji).toBe(`${'😀'.repeat(49)}.md`)
    expect(Buffer.from(emoji, 'utf8').toString('utf8')).toBe(emoji)
  })

  it('a.exe<pad>.txt must end .txt, never .exe', () => {
    const name = `a.exe${'x'.repeat(300)}.txt`
    const cut = downloadName(name)
    expect(cut.endsWith('.txt')).toBe(true)
    expect(cut.startsWith('a.exe')).toBe(true)
    expect(bytes(cut)).toBeLessThanOrEqual(DOWNLOAD_NAME_MAX_BYTES)
  })

  it('a cut with no extension worth keeping cannot expose an earlier one', () => {
    // The last "extension" is 104 bytes long; a plain cut at 200 bytes would end in `.exe`.
    const name = `x.${'p'.repeat(194)}.exe${'a'.repeat(100)}`
    const cut = downloadName(name)
    expect(bytes(cut)).toBeLessThanOrEqual(DOWNLOAD_NAME_MAX_BYTES)
    expect(cut).not.toContain('.')
    expect(downloadName(`.${'b'.repeat(250)}`)).toBe(`.${'b'.repeat(199)}`)
  })

  it('is idempotent', () => {
    for (const n of ['report.pdf', `a.exe${'x'.repeat(300)}.txt`, `x.${'p'.repeat(194)}.exe${'a'.repeat(100)}`, `${'a'.repeat(199)} b`, '../x', '']) {
      expect(downloadName(downloadName(n))).toBe(downloadName(n))
    }
  })

  it('a lone surrogate becomes U+FFFD', () => {
    expect(downloadName('a\ud800b.txt')).toBe('a\ufffdb.txt')
  })
})

describe('contentDisposition', () => {
  it('an ASCII name in both parts', () => {
    expect(contentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
  })

  it('escapes " and \\ in the fallback and percent-encodes the UTF-8 part', () => {
    // `\` is made `_` by downloadName first, so only `"` is left to escape.
    expect(contentDisposition('say "hi".txt')).toBe(`attachment; filename="say \\"hi\\".txt"; filename*=UTF-8''say%20%22hi%22.txt`)
    expect(contentDisposition('a\\b')).toBe(`attachment; filename="a_b"; filename*=UTF-8''a_b`)
  })

  it("non-latin1 names: _ in the fallback, UTF-8 in filename*, and ' ( ) * encoded", () => {
    const h = contentDisposition("Отчёт (1)'s*.pdf")
    expect(h).toBe(`attachment; filename="_____ (1)'s*.pdf"; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82%20%281%29%27s%2A.pdf`)
    expect(decodeURIComponent(h.split("UTF-8''")[1] ?? '')).toBe("Отчёт (1)'s*.pdf")
  })

  it('is always a printable ASCII header value, so writeHead cannot throw and no header can be injected', () => {
    for (const n of ['a\r\nX-Evil: 1', '😀\u0000\u00ff', 'a\ud800', `${'é'.repeat(300)}.txt`, '"\\"']) {
      const h = contentDisposition(n)
      expect(h).toMatch(/^[\x20-\x7e]+$/)
      expect(h).not.toMatch(/[\r\n]/)
    }
  })
})

describe('desktopSaveName', () => {
  it('takes the basename after either separator', () => {
    expect(desktopSaveName('../x')).toBe('x')
    expect(desktopSaveName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(desktopSaveName('C:\\Users\\a\\report.pdf')).toBe('report.pdf')
  })

  it('drops leading dots and spaces, so no hidden file lands in Downloads', () => {
    expect(desktopSaveName('.zshrc')).toBe('zshrc')
    expect(desktopSaveName('...  .bashrc')).toBe('bashrc')
    expect(desktopSaveName(`${RLO}.zshrc`)).toBe('zshrc')
    expect(desktopSaveName('..')).toBe('download')
  })

  it('drops control and bidi characters and replaces :', () => {
    expect(desktopSaveName(`report${RLO}fdp.exe`)).toBe('reportfdp.exe')
    expect(desktopSaveName('a:b.txt')).toBe('a_b.txt')
    expect(desktopSaveName('a\u0007b\u2068.txt')).toBe('ab.txt')
  })

  it('cuts as downloadName cuts, keeping the extension', () => {
    const cut = desktopSaveName(`a.exe${'x'.repeat(300)}.txt`)
    expect(cut.endsWith('.txt')).toBe(true)
    expect(bytes(cut)).toBeLessThanOrEqual(DOWNLOAD_NAME_MAX_BYTES)
  })

  it('nothing left becomes download', () => {
    for (const n of ['', '/', 'a/', '\\', '. . .', '\u200e']) expect(desktopSaveName(n)).toBe('download')
  })
})
