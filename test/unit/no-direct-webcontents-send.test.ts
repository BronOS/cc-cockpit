import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// design-web.md §2.2: every event and port post to a page goes through the ViewRegistry, so a new
// event cannot skip remote views. A direct `webContents.send`, `webContents.postMessage` or
// `getAllWindows()` broadcast reaches the desktop page only. Allowed in the registry and in the
// Electron adapters that own a webContents (the window factory builds the desktop view's sink;
// create-window, the url-overlay views and plugin webviews drive their own pages).

const ROOT = join(__dirname, '..', '..')
const MAIN = join(ROOT, 'src', 'main')

const ALLOWED = new Set(
  [
    'src/main/views/view-registry.ts',
    'src/main/windows/electron-window-factory.ts',
    'src/main/windows/create-window.ts',
    'src/main/overlays/electron-url-view.ts',
    'src/main/webview/electron-webview.ts'
  ].map((p) => p.split('/').join(sep))
)

/** The patterns that bypass the registry; whitespace inside a member access is tolerated. */
const FORBIDDEN = [
  /webContents\s*\.\s*send\s*\(/,
  /webContents\s*\.\s*postMessage\s*\(/,
  /\bgetAllWindows\s*\(/,
  /\bgetAllWebContents\s*\(/
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Code lines only: a comment may name the rule it follows. */
function codeLines(text: string): Array<{ line: number; text: string }> {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => !/^\s*(\/\/|\/?\*)/.test(t))
}

/** `file:line` of every forbidden call in `text`. */
function offences(file: string, text: string): string[] {
  return codeLines(text)
    .filter(({ text: t }) => FORBIDDEN.some((re) => re.test(t)))
    .map(({ line }) => `${file}:${line}`)
}

describe('no direct webContents sends outside the view registry', () => {
  it('finds none in src/main', () => {
    const found = sources(MAIN).flatMap((p) => {
      const rel = relative(ROOT, p)
      return ALLOWED.has(rel) ? [] : offences(rel, readFileSync(p, 'utf8'))
    })
    expect(found).toEqual([])
  })

  it('every allowed file still exists (a moved adapter must not leave a stale hole)', () => {
    const all = new Set(sources(MAIN).map((p) => relative(ROOT, p)))
    for (const f of ALLOWED) expect(all.has(f), f).toBe(true)
  })

  it('catches each form it forbids and ignores comments', () => {
    const sample = [
      "win.webContents.send('theme.changed', t)",
      'win.webContents.postMessage(c, p, [port])',
      'for (const w of BrowserWindow.getAllWindows()) {}',
      'webContents.getAllWebContents()',
      'win.webContents\n  .send(x)'.replace('\n  ', ' '),
      '// win.webContents.send(x) is not allowed here',
      ' * getAllWindows() in a doc comment'
    ].join('\n')
    expect(offences('x.ts', sample)).toEqual(['x.ts:1', 'x.ts:2', 'x.ts:3', 'x.ts:4', 'x.ts:5'])
  })
})
