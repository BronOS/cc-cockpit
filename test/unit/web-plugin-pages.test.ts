// Plugin pages and inline overlays over HTTP for remote views (main/web/plugin-pages.ts, plan Task
// 20, design-web.md §5.5; ported from the plugin-panel spike's tests): a token per (device, plugin),
// the desktop's resolver behind it, the rewritten CSP and the no-leak headers, root-absolute URLs in
// HTML, the SDK at both URLs, inline overlays while open, and the gateway serving these paths
// before its cookie check. What a real browser does with the headers was proved by the spike
// (scripts/web-spike-panel-probe.mjs on spike/web-plugin-panel).
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as wsModule from 'ws'
import { servePluginRequest } from '../../src/main/plugins/plugin-protocol'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import { WebGateway, type WsModule } from '../../src/main/web/gateway'
import {
  PageTokens,
  PluginPages,
  rewriteRootUrls,
  webOverlayCsp,
  webPluginCsp,
  type PluginPagesDeps
} from '../../src/main/web/plugin-pages'
import { webAccessOf } from '../../src/main/web/settings'
import { rootAbsoluteUrls } from '../../src/shared/root-absolute-urls'
import { isOverlayId, webPageUrl, type WebPagePaths } from '../../src/shared/web-protocol'
import { markWebShell, resetShellKindForTest } from '../../src/renderer/shell-kind'
import { resetPagePathsForTest, setPagePaths, shellPageUrl } from '../../src/renderer/web/page-paths'

const ORIGIN = 'http://devbox.local:7777'
const PROXY = 'https://box.tail1234.ts.net'
const OVERLAY_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const OTHER_OVERLAY = '6fa459ea-ee8a-4ca4-894e-db77e160355e'

let root: string
let sdkFile: string
let dirs: Record<string, string>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccc-web-pages-'))
  dirs = { 'a.plugin': join(root, 'a.plugin'), 'b.plugin': join(root, 'b.plugin') }
  mkdirSync(join(dirs['a.plugin']!, 'sub'), { recursive: true })
  mkdirSync(dirs['b.plugin']!)
  writeFileSync(
    join(dirs['a.plugin']!, 'panel.html'),
    '<script src="/__sdk/panel.js"></script>\n<script src="/lib.js"></script>\n<link href=\'/x.css\'>\n' +
      '<a href="//cdn.example/y">y</a>\n<img src="rel.png">\n<img src=/bare.png>\n<img data-src="/data.png">\n<script src="./__sdk/panel.js"></script>\n'
  )
  writeFileSync(join(dirs['a.plugin']!, 'sub', 'x.js'), 'x')
  writeFileSync(join(dirs['b.plugin']!, 'secret.js'), 'secret')
  writeFileSync(join(root, 'outside.txt'), 'outside')
  symlinkSync(join(root, 'outside.txt'), join(dirs['a.plugin']!, 'link.txt'))
  sdkFile = join(root, 'panel-sdk.js')
  writeFileSync(sdkFile, '/* sdk */')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface World {
  /** device id -> the windows/projects its open views are bound to. */
  views: Map<string, Array<{ windowId: number; projectId: string }>>
  /** project id -> the plugins enabled in it. */
  enabled: Map<string, Set<string>>
  /** overlay id -> its window and page, while open. */
  overlays: Map<string, { windowId: number; html: string }>
  installed: string[]
}

function world(): World {
  return {
    views: new Map([['dev1', [{ windowId: 1, projectId: 'p1' }]]]),
    enabled: new Map([
      ['p1', new Set(['a.plugin', 'b.plugin'])],
      ['p2', new Set(['b.plugin'])]
    ]),
    overlays: new Map([[OVERLAY_ID, { windowId: 1, html: '<p>inline</p>' }]]),
    installed: ['b.plugin', 'a.plugin']
  }
}

function pagesOf(w: World): PluginPages {
  const deps: PluginPagesDeps = {
    pluginIds: () => w.installed,
    deviceViews: (deviceId) => w.views.get(deviceId) ?? [],
    pluginDir: (projectId, pluginId) => (w.enabled.get(projectId)?.has(pluginId) ? dirs[pluginId] : undefined),
    overlayPage: (id) => w.overlays.get(id),
    sdkFile
  }
  return new PluginPages(deps)
}

const text = (a: { body: Buffer }): string => a.body.toString('utf8')

describe('PageTokens', () => {
  it('one token per (device, key), stable until dropped; dropping a device or clearing kills them', () => {
    const t = new PageTokens()
    const a1 = t.tokenFor('dev1', 'a.plugin')
    expect(t.tokenFor('dev1', 'a.plugin')).toBe(a1)
    expect(a1).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const b1 = t.tokenFor('dev1', 'b.plugin')
    const a2 = t.tokenFor('dev2', 'a.plugin')
    expect(new Set([a1, b1, a2]).size).toBe(3)
    expect(t.lookup(a2)).toEqual({ deviceId: 'dev2', key: 'a.plugin' })
    t.dropDevice('dev1')
    expect(t.lookup(a1)).toBeUndefined()
    expect(t.lookup(b1)).toBeUndefined()
    expect(t.lookup(a2)).toBeDefined()
    // A device that comes back (a new view) gets a new token, never the dead one.
    expect(t.tokenFor('dev1', 'a.plugin')).not.toBe(a1)
    t.clear()
    expect(t.size()).toBe(0)
  })
})

describe('paths', () => {
  it('names a prefix per installed plugin and one overlay prefix, per device, stable and sorted', () => {
    const pages = pagesOf(world())
    const p = pages.paths('dev1')
    expect(Object.keys(p.plugins)).toEqual(['a.plugin', 'b.plugin'])
    expect(p.plugins['a.plugin']).toMatch(/^\/p\/[A-Za-z0-9_-]{32}\/a\.plugin\/$/)
    expect(p.overlays).toMatch(/^\/o\/[A-Za-z0-9_-]{32}\/$/)
    expect(pages.paths('dev1')).toEqual(p)
    const other = pages.paths('dev2')
    expect(other.plugins['a.plugin']).not.toBe(p.plugins['a.plugin'])
    expect(other.overlays).not.toBe(p.overlays)
  })

  it('webPageUrl maps cc-plugin:// and cc-overlay:// URLs through them, nothing else', () => {
    const paths: WebPagePaths = { plugins: { 'a.plugin': '/p/T/a.plugin/' }, overlays: '/o/O/' }
    expect(webPageUrl('cc-plugin://a.plugin/panel.html', paths)).toBe('/p/T/a.plugin/panel.html')
    expect(webPageUrl('cc-plugin://a.plugin/icons/x%20y.svg?v=1#f', paths)).toBe('/p/T/a.plugin/icons/x%20y.svg?v=1#f')
    expect(webPageUrl('cc-plugin://b.plugin/panel.html', paths)).toBeUndefined()
    expect(webPageUrl('cc-plugin://__proto__/x', paths)).toBeUndefined()
    expect(webPageUrl('cc-plugin://a.plugin', paths)).toBeUndefined()
    expect(webPageUrl(`cc-overlay://${OVERLAY_ID}/`, paths)).toBe(`/o/O/${OVERLAY_ID}/`)
    expect(webPageUrl(`cc-overlay://${OVERLAY_ID}/x`, paths)).toBeUndefined()
    expect(webPageUrl('cc-overlay://../', paths)).toBeUndefined()
    expect(webPageUrl(`cc-overlay://${OVERLAY_ID}/`, { plugins: {}, overlays: '' })).toBeUndefined()
    expect(webPageUrl('https://example.com/x.png', paths)).toBeUndefined()
    expect(webPageUrl('cc-plugin://a.plugin/x', undefined)).toBeUndefined()
  })
})

describe("the shell's plugin images (page-paths.ts)", () => {
  afterEach(() => {
    resetShellKindForTest()
    resetPagePathsForTest()
  })

  it('leaves cc-plugin:// alone on the desktop, maps it to the view path in the web shell', () => {
    const icon = 'cc-plugin://a.plugin/icon.svg'
    setPagePaths({ plugins: { 'a.plugin': '/p/T/a.plugin/' }, overlays: '/o/O/' })
    expect(shellPageUrl(icon)).toBe(icon)
    markWebShell()
    expect(shellPageUrl(icon)).toBe('/p/T/a.plugin/icon.svg')
    // No path for it in this view: a failed load (the letter), never the cc-plugin: URL.
    expect(shellPageUrl('cc-plugin://b.plugin/icon.svg')).toBeUndefined()
    resetPagePathsForTest()
    expect(shellPageUrl(icon)).toBeUndefined()
  })
})

describe('plugin files', () => {
  it('serves a plugin under its token, root-absolute src/href rewritten into the prefix', async () => {
    const pages = pagesOf(world())
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    const page = await pages.serve(`${prefix}panel.html`, 'GET', [ORIGIN])
    expect(page.status).toBe(200)
    expect(text(page)).toBe(
      `<script src="${prefix}__sdk/panel.js"></script>\n<script src="${prefix}lib.js"></script>\n<link href='${prefix}x.css'>\n` +
        `<a href="//cdn.example/y">y</a>\n<img src="rel.png">\n<img src=${prefix}bare.png>\n<img data-src="/data.png">\n<script src="./__sdk/panel.js"></script>\n`
    )
    expect(text(await pages.serve(`${prefix}sub/x.js`, 'GET', [ORIGIN]))).toBe('x')
    // Not HTML: never rewritten.
    writeFileSync(join(dirs['a.plugin']!, 'app.js'), 'load(" src=\\"/x.js")')
    expect(text(await pages.serve(`${prefix}app.js`, 'GET', [ORIGIN]))).toBe('load(" src=\\"/x.js")')
  })

  it('serves the SDK at <prefix>__sdk/panel.js (the rewritten and the relative URL), and at cc-plugin:// on the desktop', async () => {
    const pages = pagesOf(world())
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    const sdk = await pages.serve(`${prefix}__sdk/panel.js`, 'GET', [ORIGIN])
    expect(sdk.status).toBe(200)
    expect(text(sdk)).toBe('/* sdk */')
    expect(sdk.headers['Content-Type']).toBe('text/javascript; charset=utf-8')
    // `./__sdk/panel.js` from `<prefix>panel.html` resolves to the same path.
    expect(new URL('./__sdk/panel.js', `${ORIGIN}${prefix}panel.html`).pathname).toBe(`${prefix}__sdk/panel.js`)
    const desktop = await servePluginRequest('cc-plugin://a.plugin/__sdk/panel.js', 'GET', { pluginDir: (id) => dirs[id], sdkFile })
    expect(desktop.status).toBe(200)
    expect(await desktop.text()).toBe('/* sdk */')
  })

  it('carries the path CSP for every shell origin, an opaque-origin sandbox and the no-leak headers', async () => {
    const pages = pagesOf(world())
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    const res = await pages.serve(`${prefix}sub/x.js`, 'GET', [ORIGIN, PROXY, ORIGIN])
    const selves = `${ORIGIN}${prefix} ${PROXY}${prefix}`
    expect(res.headers).toEqual({
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Security-Policy':
        `default-src 'none'; script-src ${selves}; style-src ${selves} 'unsafe-inline'; img-src ${selves} data:; font-src ${selves}; ` +
        `connect-src ${selves}; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${ORIGIN} ${PROXY}; sandbox allow-scripts`,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': 'null',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    })
    const csp = webPluginCsp('a.plugin', [ORIGIN], prefix)
    expect(csp).not.toContain('cc-plugin:')
    expect(csp).not.toContain('allow-popups')
    expect(csp.match(/sandbox/g)).toHaveLength(1)
  })

  it("refuses another plugin's path under a token, traversal, unknown, malformed and dead tokens", async () => {
    const pages = pagesOf(world())
    const { plugins } = pages.paths('dev1')
    const tokA = plugins['a.plugin']!.split('/')[2]!
    const tokB = plugins['b.plugin']!.split('/')[2]!
    const get = (path: string): Promise<number> => pages.serve(path, 'GET', [ORIGIN]).then((r) => r.status)
    // The page learned tokA from its own URL: b.plugin's files stay out of reach with it.
    expect(await get(`/p/${tokA}/b.plugin/secret.js`)).toBe(404)
    expect(await get(`/p/${tokB}/b.plugin/secret.js`)).toBe(200)
    // Traversal: a raw `..` stays inside a.plugin (refused by the resolver), encoded ones are refused, a symlink out too.
    expect(await get(`/p/${tokA}/a.plugin/../b.plugin/secret.js`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/sub/../../b.plugin/secret.js`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/%2e%2e/b.plugin/secret.js`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/sub%2f..%2f..%2fb.plugin/secret.js`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/..%5c..%5coutside.txt`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/link.txt`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/sub`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin/`)).toBe(404)
    expect(await get(`/p/${tokA}/a.plugin`)).toBe(404)
    expect(await get(`/p/${tokA}/../a.plugin/panel.html`)).toBe(404)
    // Unknown, malformed, missing tokens.
    expect(await get(`/p/${'x'.repeat(32)}/a.plugin/panel.html`)).toBe(404)
    expect(await get(`/p/${tokA}x/a.plugin/panel.html`)).toBe(404)
    expect(await get('/p//a.plugin/panel.html')).toBe(404)
    expect(await get('/p/__proto__/a.plugin/panel.html')).toBe(404)
    // The device is revoked: every token of it is dead.
    pages.tokens.dropDevice('dev1')
    expect(await get(`/p/${tokB}/b.plugin/secret.js`)).toBe(404)
    // A refusal carries the strictest policy and no CORS.
    const refused = await pages.serve(`/p/${tokA}/a.plugin/panel.html`, 'GET', [ORIGIN])
    expect(refused.headers['Content-Security-Policy']).toBe("default-src 'none'; sandbox")
    expect(refused.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('serves a plugin only while the device has a view of a project it is enabled in', async () => {
    const w = world()
    const pages = pagesOf(w)
    const { plugins } = pages.paths('dev1')
    const get = (id: string, file: string): Promise<number> => pages.serve(`${plugins[id]}${file}`, 'GET', [ORIGIN]).then((r) => r.status)
    expect(await get('a.plugin', 'panel.html')).toBe(200)
    // Turned off in the view's project: refused at once (reloads included).
    w.enabled.get('p1')!.delete('a.plugin')
    expect(await get('a.plugin', 'panel.html')).toBe(404)
    // The view moves to p2 (b only): a stays refused, b is served.
    w.views.set('dev1', [{ windowId: 2, projectId: 'p2' }])
    w.enabled.get('p1')!.add('a.plugin')
    expect(await get('a.plugin', 'panel.html')).toBe(404)
    expect(await get('b.plugin', 'secret.js')).toBe(200)
    // No open view of the device: nothing, even with a live token.
    w.views.set('dev1', [])
    expect(await get('b.plugin', 'secret.js')).toBe(404)
    // Another device's view of p1 does not lend dev1 anything.
    w.views.set('dev2', [{ windowId: 1, projectId: 'p1' }])
    expect(await get('a.plugin', 'panel.html')).toBe(404)
  })

  it('answers GET and HEAD only', async () => {
    const pages = pagesOf(world())
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    expect((await pages.serve(`${prefix}sub/x.js`, 'HEAD', [ORIGIN])).status).toBe(200)
    expect((await pages.serve(`${prefix}sub/x.js`, 'POST', [ORIGIN])).status).toBe(404)
    expect((await pages.serve(`${prefix}sub/x.js`, 'PUT', [ORIGIN])).status).toBe(404)
  })

  it('rewrites an HTML page byte for byte: another charset and invalid UTF-8 keep their bytes', async () => {
    const pages = pagesOf(world())
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    // `é` in latin1 (0xE9, invalid UTF-8 on its own) and a lone continuation byte.
    const head = Buffer.from('<meta charset="iso-8859-1"><p>caf', 'latin1')
    const tail = Buffer.from('</p><script src="/x.js"></script>', 'latin1')
    writeFileSync(join(dirs['a.plugin']!, 'latin.html'), Buffer.concat([head, Buffer.from([0xe9, 0x80]), tail]))
    const res = await pages.serve(`${prefix}latin.html`, 'GET', [ORIGIN])
    expect(res.status).toBe(200)
    expect(res.body.equals(Buffer.concat([head, Buffer.from([0xe9, 0x80]), Buffer.from(`</p><script src="${prefix}x.js"></script>`, 'latin1')]))).toBe(true)
  })

  it('rewriteRootUrls takes spaces after the quote (a browser strips them), and stays linear on long space runs', () => {
    expect(rewriteRootUrls('<img src=" /x"><img src= /y><a href=\'  /z\'>', '/p/T/a.b/')).toBe(
      '<img src=" /p/T/a.b/x"><img src= /p/T/a.b/y><a href=\'  /p/T/a.b/z\'>'
    )
    expect(rewriteRootUrls('<a href=" //h/x"><a href=" x">', '/p/')).toBe('<a href=" //h/x"><a href=" x">')
    // No `/` after the spaces: a backtracking regex splitting the run between two quantifiers would
    // take seconds here.
    const long = ` src="${' '.repeat(200_000)}x`.repeat(5)
    const started = Date.now()
    expect(rewriteRootUrls(long, '/p/')).toBe(long)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('rewriteRootUrls leaves protocol-relative, relative and absolute URLs alone', () => {
    expect(rewriteRootUrls('<a href="/x">', '/p/T/a.b/')).toBe('<a href="/p/T/a.b/x">')
    expect(rewriteRootUrls('<a HREF = \'/x\'>', '/p/T/a.b/')).toBe('<a HREF = \'/p/T/a.b/x\'>')
    expect(rewriteRootUrls('<a href="//h/x"><a href="/\\h"><a href="x"><a href="https://h/x">', '/p/')).toBe(
      '<a href="//h/x"><a href="/\\h"><a href="x"><a href="https://h/x">'
    )
  })
  // Two regexes describe "a root-absolute src/href": the rewriter here and the warning of `ccc plugin
  // link` (shared/root-absolute-urls.ts). Every URL the rewriter rewrites must be warned about (a
  // page that relies on the rewrite still works on the desktop only by luck of the prefix), and the
  // only URLs warned about yet left alone are the documented fail-closed ones. A change to one regex
  // that the other does not follow fails here.
  it('the plugin check warns about every URL the rewrite touches, and about exactly the fail-closed rest', () => {
    const rewritten = [
      '<script src="/x.js">',
      "<link href='/a.css'>",
      '<img src=/i.png>',
      '<img src=" /sp.png">',
      "<a HREF = '/x'>",
      '<a\nhref="/n">',
      '<a\thref="/t">',
      '<script src="/__sdk/panel.js">'
    ]
    const failClosed = [
      '<img/src="/slash.png">',
      '<img src="&#47;e.png">',
      '<img src="&#x2F;f.png">',
      '<img src="&sol;g.png">',
      '<img srcset="a.png 1x, /b.png 2x">',
      '<video poster="/p.png">',
      '<form action="/submit">',
      '<img data-src="/lazy.png">'
    ]
    const neither = [
      '<a href="//h/x">',
      '<a href="/\\h">',
      '<a href="x">',
      '<a href="./x">',
      '<a href="https://h/x">',
      '<a href="#top">',
      '<a data-href="/x">'
    ]
    for (const html of [...rewritten, ...failClosed, ...neither]) {
      const touched = rewriteRootUrls(html, '/p/T/a.b/') !== html
      const warned = rootAbsoluteUrls('html', html).length > 0
      const kind = rewritten.includes(html) ? 'rewritten' : failClosed.includes(html) ? 'failClosed' : 'neither'
      expect({ html, touched, warned }).toEqual({ html, touched: kind === 'rewritten', warned: kind !== 'neither' })
    }
  })
})

describe('isOverlayId', () => {
  it('takes the UUIDs main mints and nothing else', () => {
    expect(isOverlayId(randomUUID())).toBe(true)
    expect(isOverlayId('0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe(true)
    for (const bad of [
      '',
      '0A1B2C3D-4E5F-6789-ABCD-EF0123456789',
      '0a1b2c3d-4e5f-6789-abcd-ef012345678',
      '0a1b2c3d-4e5f-6789-abcd-ef01234567890',
      '0a1b2c3d4e5f-6789-abcd-ef0123456789-',
      '0a1b2c3d-4e5f-6789-abcd-ef012345678g',
      '../../../../../../../../../../../..',
      '0a1b2c3d_4e5f_6789_abcd_ef0123456789'
    ]) {
      expect(isOverlayId(bad), bad).toBe(false)
    }
  })
})

describe('inline overlays', () => {
  it('serves an open overlay page at /o/<token>/<id>/ in a window the device has a view of', async () => {
    const w = world()
    const pages = pagesOf(w)
    const { overlays, plugins } = pages.paths('dev1')
    const res = await pages.serve(`${overlays}${OVERLAY_ID}/`, 'GET', [ORIGIN])
    expect(res.status).toBe(200)
    expect(text(res)).toBe('<p>inline</p>')
    expect(res.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': webOverlayCsp([ORIGIN]),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    })
    expect(webOverlayCsp([ORIGIN])).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; " +
        `base-uri 'none'; frame-ancestors ${ORIGIN}; sandbox allow-scripts`
    )
    // A reload is the same request: served again while open.
    expect((await pages.serve(`${overlays}${OVERLAY_ID}/`, 'GET', [ORIGIN])).status).toBe(200)
    const get = (path: string): Promise<number> => pages.serve(path, 'GET', [ORIGIN]).then((r) => r.status)
    // One document only.
    expect(await get(`${overlays}${OVERLAY_ID}`)).toBe(404)
    expect(await get(`${overlays}${OVERLAY_ID}/x`)).toBe(404)
    expect(await get(`${overlays}${OVERLAY_ID}/x/`)).toBe(404)
    // A plugin's token is not the overlay token, nor the other way round.
    const tokA = plugins['a.plugin']!.split('/')[2]!
    expect(await get(`/o/${tokA}/${OVERLAY_ID}/`)).toBe(404)
    expect(await get(`/p/${overlays.split('/')[2]}/@overlays/x`)).toBe(404)
    // Refused for the key itself, before any folder lookup: not only because no project enables
    // `@overlays` (nor because the resolver's id rule refuses the `@`).
    const p1 = w.enabled.get('p1')!
    const asked: string[] = []
    w.enabled.set('p1', { has: (id: string) => (asked.push(id), true) } as unknown as Set<string>)
    dirs['@overlays'] = dirs['a.plugin']!
    expect(await get(`/p/${overlays.split('/')[2]}/@overlays/panel.html`)).toBe(404)
    expect(asked).toEqual([])
    w.enabled.set('p1', p1)
    // Unknown overlay, an overlay of a window the device has no view of.
    expect(await get(`${overlays}${OTHER_OVERLAY}/`)).toBe(404)
    w.overlays.set(OTHER_OVERLAY, { windowId: 2, html: '<p>other window</p>' })
    expect(await get(`${overlays}${OTHER_OVERLAY}/`)).toBe(404)
    // Closed: gone.
    w.overlays.delete(OVERLAY_ID)
    expect(await get(`${overlays}${OVERLAY_ID}/`)).toBe(404)
  })
})

// ---------------------------------------------------------------------------------------------
// Through the gateway: served before the cookie check, with their own headers, tokens dying with
// the device.

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

function http(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = ''
        res.on('data', (d: Buffer) => (body += d.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('through the gateway', () => {
  let gw: WebGateway | undefined
  let dataDir: string
  afterEach(async () => {
    await gw?.stop()
    gw = undefined
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function start(mode: 'link' | 'none') {
    dataDir = mkdtempSync(join(tmpdir(), 'ccc-web-pages-gw-'))
    const accessLog = new AccessLog()
    const devices = new DeviceStore({ filePath: join(dataDir, 'web-access.json'), accessLog })
    const auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog })
    const w = world()
    const pages = pagesOf(w)
    const port = await freePort()
    gw = new WebGateway({ log: () => undefined, loadWs: async (): Promise<WsModule> => wsModule, auth, accessLog, pages })
    expect(await gw.apply(webAccessOf({ enabled: true, port, mode }))).toMatchObject({ state: 'listening' })
    return { port, pages, w, devices, gateway: gw }
  }

  it('serves a plugin file with no cookie (the token is the credential), with its own headers, never the shell framing ones', async () => {
    const { port, pages } = await start('link')
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    const res = await http(port, `${prefix}panel.html?v=2`)
    expect(res.status).toBe(200)
    expect(res.body).toContain(`src="${prefix}__sdk/panel.js"`)
    expect(res.headers['x-frame-options']).toBeUndefined()
    expect(res.headers['access-control-allow-origin']).toBe('null')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['location']).toBeUndefined()
    expect(String(res.headers['content-security-policy'])).toBe(webPluginCsp('a.plugin', [`http://127.0.0.1:${port}`], prefix))
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)))
    // HEAD: the length, no body.
    const head = await http(port, `${prefix}panel.html`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    // The overlay page too.
    const overlay = await http(port, `${pages.paths('dev1').overlays}${OVERLAY_ID}/`)
    expect(overlay.status).toBe(200)
    expect(overlay.body).toBe('<p>inline</p>')
    // Anything else under the paths with no valid token: a plain 404, never the sign-in's 401.
    const unknown = await http(port, `/p/${'x'.repeat(32)}/a.plugin/panel.html`)
    expect(unknown.status).toBe(404)
    expect(String(unknown.headers['content-security-policy'])).toBe("default-src 'none'; sandbox")
  })

  it('still checks Host first, and a post is refused before any route', async () => {
    const { port, pages } = await start('link')
    const prefix = pages.paths('dev1').plugins['a.plugin']!
    expect((await http(port, `${prefix}panel.html`, { host: 'evil.example' })).status).toBe(403)
    expect((await http(port, `${prefix}panel.html`, { method: 'POST', headers: { Origin: 'null' } })).status).toBe(403)
    expect((await http(port, `${prefix}panel.html`, { method: 'PUT' })).status).toBe(405)
  })

  it("a revoked device's tokens die at once; leaving None drops the anonymous device's; stopping drops all", async () => {
    const { port, pages, w, devices } = await start('link')
    const added = devices.add('phone', 'link')!
    w.views.set(added.device.id, [{ windowId: 1, projectId: 'p1' }])
    const mine = pages.paths(added.device.id).plugins['a.plugin']!
    const other = pages.paths('dev1').plugins['a.plugin']!
    expect((await http(port, `${mine}panel.html`)).status).toBe(200)
    devices.revoke(added.device.id)
    expect((await http(port, `${mine}panel.html`)).status).toBe(404)
    expect((await http(port, `${other}panel.html`)).status).toBe(200)

    // None mode: the anonymous device `none`.
    await gw!.apply(webAccessOf({ enabled: true, port, mode: 'none' }))
    w.views.set('none', [{ windowId: 1, projectId: 'p1' }])
    const anon = pages.paths('none').plugins['a.plugin']!
    expect((await http(port, `${anon}panel.html`)).status).toBe(200)
    await gw!.apply(webAccessOf({ enabled: true, port, mode: 'link' }))
    expect((await http(port, `${anon}panel.html`)).status).toBe(404)
    expect(pages.tokens.lookup(anon.split('/')[2]!)).toBeUndefined()

    await gw!.stop()
    expect(pages.tokens.size()).toBe(0)
  })
})
