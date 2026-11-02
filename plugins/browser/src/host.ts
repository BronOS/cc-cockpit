// The built-in browser plugin's host side (plan: Claude-operable foundation, Task 10): one webview
// panel driven through `ccc browser open|url|reload`. Only TYPES are imported from the SDK, so the
// bundle (scripts/build-browser.mjs -> dist/host.js, committed) depends on nothing of the app.
import type { PluginContext } from '../../../src/sdk/types'

const PANEL = 'view'

/**
 * What to hand to ctx.webview.navigate: an http(s) URL as is, a bare `localhost:3000` /
 * `127.0.0.1:8080` / `[::1]:3000` as http (the port is required: without one, `localhost` or
 * `10.0.0.1` may as well be a file in the cwd, and the file wins; after the port a path, a query
 * or a fragment may follow: `localhost:3000?x=1`), any other `scheme://` refused (a `file:` URL
 * would otherwise read as a relative path named "file:"), the rest a file path joined onto the
 * caller's cwd.
 */
const BARE_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\]):\d+([/?#]|$)/i

export function resolveTarget(raw: string, cwd: string): { target: string } | { error: string } {
  const text = raw.trim()
  if (text === '') return { error: 'usage: browser open <url|file>' }
  if (/^https?:\/\//i.test(text)) return { target: text }
  if (BARE_HOST.test(text)) return { target: `http://${text}` }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return { error: `only http(s) URLs and file paths can be shown, not ${text.slice(0, text.indexOf(':'))}: (give a file as a path)` }
  }
  if (text.startsWith('/')) return { target: text }
  // A plain join with `.` and `..` left in: main realpaths the target, which follows each symlink
  // before the `..` after it, as the shell and the OS do (`link/../x.html` sits next to the link's
  // target). Collapsing `..` here, or node:path.resolve (which does the same, lexically), would
  // name a different file. The host runs on POSIX (design section 7); the folder that ends up
  // served is checked by main, not here.
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return { target: `${base}${text}` }
}

const failure = (err: unknown): { stderr: string; code: number } => ({
  stderr: `${err instanceof Error ? err.message : String(err)}\n`,
  code: 1
})

const isHttp = (text: string): boolean => /^https?:\/\//i.test(text)

export function activate(ctx: PluginContext): void {
  // The home page is loaded when the plugin starts: that creates the (hidden) view, and the panel
  // shows it the first time the user opens it. An unusable value is logged and ignored.
  const home = String(ctx.settings.app.home ?? '').trim()
  if (home !== '') {
    if (isHttp(home)) void ctx.webview.navigate(PANEL, home).catch((err: unknown) => ctx.log.warn('home page:', String(err)))
    else ctx.log.warn('the home setting must be an http(s) URL; ignored')
  }

  ctx.cli.register('browser', async (argv, call) => {
    const [sub, ...rest] = argv
    if (sub === 'open') {
      const [raw] = rest
      if (rest.length !== 1 || raw === undefined) return { stderr: 'usage: browser open <url|file>\n', code: 2 }
      const resolved = resolveTarget(raw, call.cwd)
      if ('error' in resolved) return { stderr: `${resolved.error}\n`, code: 2 }
      try {
        await ctx.webview.navigate(PANEL, resolved.target)
      } catch (err) {
        // A page that failed to load (a dev server not up yet) is still shown: the panel names
        // the failed URL and the error, and its Reload tries again. A refused target shows nothing.
        const page = await ctx.webview.current(PANEL).catch(() => undefined)
        if (page?.error !== undefined) ctx.panels.show(PANEL)
        return failure(err)
      }
      ctx.panels.show(PANEL)
      return { stdout: 'ok\n' }
    }
    if (sub === 'url') {
      try {
        const page = await ctx.webview.current(PANEL)
        if (page.url === '') return { stdout: 'blank\n' }
        // A failed load: the view shows an empty page at that URL; say why instead of a title.
        if (page.error !== undefined) return { stdout: `${page.url}\tfailed to load: ${page.error}\n` }
        return { stdout: `${page.url}\t${page.title}\n` }
      } catch (err) {
        return failure(err)
      }
    }
    if (sub === 'reload') {
      try {
        await ctx.webview.reload(PANEL)
        return { stdout: 'ok\n' }
      } catch (err) {
        return failure(err)
      }
    }
    return { stderr: 'usage: browser open <url|file> | browser url | browser reload\n', code: 2 }
  })
}
