import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ViewRegistry, type DesktopViewSink } from '../../src/main/views/view-registry'
import { remoteViewId } from '../../src/shared/views'

// design-web.md §2.2: every event and port post to a page goes through the ViewRegistry, so a new
// event cannot skip remote views. A direct `webContents.send`, `webContents.postMessage` or
// `getAllWindows()` broadcast reaches the desktop page only. Allowed in the registry and in the
// Electron adapters that own a webContents (the window factory builds the desktop view's sink;
// create-window, the url-overlay views, plugin webviews, desktop and off-screen, and remote desktop
// windows drive their own pages; a remote window's page is a server's, never a view).
// "The browser views of a window, never the hidden page" is the registry's own `toBrowserViews`
// (server mode, design-web.md §9), not a filter over `viewsOf` at each call site; the test below
// checks it skips desktop views, and the link notice's one sender is guarded by
// no-direct-open-external.test.ts.

const ROOT = join(__dirname, '..', '..')
const MAIN = join(ROOT, 'src', 'main')

const ALLOWED = new Set(
  [
    'src/main/views/view-registry.ts',
    'src/main/windows/electron-window-factory.ts',
    'src/main/windows/create-window.ts',
    'src/main/overlays/electron-url-view.ts',
    'src/main/webview/electron-webview.ts',
    'src/main/webview/electron-offscreen-webview.ts',
    'src/main/remote/electron-remote-window.ts'
  ].map((p) => p.split('/').join(sep))
)

/**
 * The patterns that bypass the registry; whitespace inside a member access is tolerated. A line
 * scan cannot follow data flow, so the aliased forms (`const wc = win.webContents; wc.send(x)`, a
 * member access split over two lines) are caught by the member allow-list below rather than by
 * the call itself. An alias of `event.sender` (`const s = event.sender; s.send(x)`) still slips
 * through: this is a guard against the usual shapes, and review covers the rest.
 */
const FORBIDDEN = [
  /webContents\s*\.\s*send\s*\(/,
  /webContents\s*\.\s*postMessage\s*\(/,
  /\bgetAllWindows\s*\(/,
  /\bgetAllWebContents\s*\(/,
  // electron's `webContents` module: `webContents.fromId(id).send(...)`.
  /\bwebContents\s*\.\s*fromId\s*\(/,
  // An IPC event's sender is a WebContents too, and `event.reply` sends through it.
  /\bsender\s*\??\.\s*(send|postMessage)\s*\(/,
  /\.\s*reply\s*\(/,
  // A `.webContents` access may only read the id, focus the page or listen: anything else (a
  // `send`, `?.send`, an alias `= win.webContents`, a member on the next line) is refused.
  /\??\.\s*webContents\b(?!\s*\??\.\s*(id\b|focus\s*\(|on\s*\())/
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
      'const wc = win.webContents',
      'BrowserWindow.fromId(id)?.webContents',
      'win?.webContents?.send(x)',
      'webContents.fromId(id)?.send(x)',
      'event.sender.send(x)',
      'event.reply(x)',
      '// win.webContents.send(x) is not allowed here',
      ' * getAllWindows() in a doc comment'
    ].join('\n')
    // Every line but the two comments.
    expect(offences('x.ts', sample)).toEqual(Array.from({ length: 11 }, (_, i) => `x.ts:${i + 1}`))
  })

  it('toBrowserViews reaches browser views only, never a desktop view (the hidden page in server mode)', () => {
    const views = new ViewRegistry({ windowIdOf: () => undefined, log: () => {} })
    const got: string[] = []
    const sink = (name: string): DesktopViewSink => ({ send: () => void got.push(name), isClosed: () => false })
    views.addDesktop(1, sink('desktop'))
    views.addRemote(1, remoteViewId(1), sink('web'))
    expect(views.toBrowserViews(1, 'app.linkNotice', { url: 'https://a/' })).toBe(1)
    expect(views.toBrowserViews('all', 'app.linkNotice', { url: 'https://a/' })).toBe(1)
    expect(got).toEqual(['web', 'web'])
  })

  it('lets the read-only webContents uses through', () => {
    const sample = [
      'windows.resolveSender(win.webContents.id)',
      'win.webContents.focus()',
      "win.webContents.on('did-navigate', () => {})",
      'this.log(`refused, webContents ${event.sender.id}`)'
    ].join('\n')
    expect(offences('x.ts', sample)).toEqual([])
  })
})
