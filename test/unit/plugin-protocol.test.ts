// Task 28: what `cc-plugin://<pluginId>/<path>` serves. Real files in a temp dir (a plugin folder,
// a secret next to it, a symlink pointing out); the handler is called the way Electron's
// protocol.handle would, without Electron.
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contentTypeOf,
  PANEL_SDK_PATH,
  pluginCsp,
  pluginFileUrl,
  resolvePluginFile,
  servePluginRequest,
  type PluginProtocolDeps
} from '../../src/main/plugins/plugin-protocol'

// open wrapped so a test can change the folder between the checks and the read; everything else
// is the real module.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open) }
})

/** Run `swap` right before the next open (after every check of the request), then open for real. */
async function swapBeforeRead(swap: () => void): Promise<void> {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof real.open>) => {
    swap()
    return real.open(...args)
  })
}

let root: string
let pluginDir: string
let deps: PluginProtocolDeps
let logs: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-plugin-protocol-')))
  pluginDir = join(root, 'plugins', 'acme.board')
  mkdirSync(join(pluginDir, 'panels', 'deep'), { recursive: true })
  writeFileSync(join(pluginDir, 'panels', 'board.html'), '<p>board</p>')
  writeFileSync(join(pluginDir, 'panels', 'board.js'), 'console.log(1)')
  writeFileSync(join(pluginDir, 'panels', 'deep', 'two words.json'), '{"ok":true}')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  writeFileSync(join(root, 'plugins', 'sibling.txt'), 'sibling')
  // A link inside the folder that points out of it, and one that stays inside.
  symlinkSync(join(root, 'secret.txt'), join(pluginDir, 'escape.txt'))
  symlinkSync(join(root), join(pluginDir, 'escape-dir'))
  symlinkSync(join(pluginDir, 'panels', 'board.html'), join(pluginDir, 'alias.html'))
  writeFileSync(join(root, 'panel.js'), '/* sdk */')
  logs = []
  deps = {
    pluginDir: (id) => (id === 'acme.board' ? pluginDir : undefined),
    sdkFile: join(root, 'panel.js'),
    log: (m) => logs.push(m)
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const get = (url: string, method = 'GET'): Promise<Response> => servePluginRequest(url, method, deps)

describe('servePluginRequest', () => {
  it("serves a plugin's own files with its CSP, a content type and nosniff", async () => {
    const res = await get('cc-plugin://acme.board/panels/board.html')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>board</p>')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(pluginCsp('acme.board'))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // A sandboxed (opaque-origin) panel's fetch of its own files is cross-origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('*')

    const js = await get('cc-plugin://acme.board/panels/board.js?v=2#x')
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await js.text()).toBe('console.log(1)')
    // Encoded names are decoded one segment at a time.
    const json = await get('cc-plugin://acme.board/panels/deep/two%20words.json')
    expect(await json.json()).toEqual({ ok: true })
    // A symlink that stays inside the folder is fine.
    expect(await (await get('cc-plugin://acme.board/alias.html')).text()).toBe('<p>board</p>')
  })

  it('serves the panel SDK inside every served plugin, and only there', async () => {
    const res = await get(`cc-plugin://acme.board${PANEL_SDK_PATH}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('/* sdk */')
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(pluginCsp('acme.board'))
    expect((await get(`cc-plugin://other.plugin${PANEL_SDK_PATH}`)).status).toBe(404)
  })

  it('answers 404, with a CSP, for anything outside the folder', async () => {
    const refused = [
      // Literal dots are folded by the URL parser and stay inside (here: the folder itself).
      'cc-plugin://acme.board/../secret.txt',
      'cc-plugin://acme.board/panels/../../sibling.txt',
      // Encoded dots and separators survive the parser and are refused outright.
      'cc-plugin://acme.board/%2e%2e/sibling.txt',
      'cc-plugin://acme.board/%2E%2E/%2E%2E/secret.txt',
      'cc-plugin://acme.board/panels%2f..%2f..%2fsecret.txt',
      'cc-plugin://acme.board/..%5c..%5csecret.txt',
      'cc-plugin://acme.board/panels/board.html%00.png',
      // Symlinks pointing out of the folder.
      'cc-plugin://acme.board/escape.txt',
      'cc-plugin://acme.board/escape-dir/secret.txt',
      // Not a file.
      'cc-plugin://acme.board/',
      'cc-plugin://acme.board/panels',
      'cc-plugin://acme.board/missing.html',
      // Broken escapes.
      'cc-plugin://acme.board/%E0%A4%A.html',
      // Double-encoded dots decode once, to a literal name `%2e%2e` (no such file), never to `..`.
      'cc-plugin://acme.board/%252e%252e/sibling.txt',
      'cc-plugin://acme.board/panels/%252e%252e/%252e%252e/secret.txt',
      // A literal NUL (the parser encodes it to %00) and a literal backslash (kept as is by a
      // non-special scheme) in a name.
      'cc-plugin://acme.board/panels/board.html\0.png',
      'cc-plugin://acme.board/panels\\..\\..\\secret.txt',
      'cc-plugin://acme.board/..\\secret.txt'
    ]
    for (const url of refused) {
      const res = await get(url)
      expect(res.status, url).toBe(404)
      expect(await res.text(), url).toBe('not found')
      expect(res.headers.get('content-security-policy'), url).toBe(pluginCsp('acme.board'))
    }
  })

  it('serves from a plugin folder that is itself a symlink (a linked plugin), still contained', async () => {
    const link = join(root, 'linked-board')
    symlinkSync(pluginDir, link)
    deps = { ...deps, pluginDir: (id) => (id === 'acme.board' ? link : undefined) }
    const res = await get('cc-plugin://acme.board/panels/board.html')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<p>board</p>')
    // Containment is checked against the folder's realpath, not the link's.
    expect(await resolvePluginFile('cc-plugin://acme.board/alias.html', deps)).toMatchObject({
      ok: true,
      pluginId: 'acme.board',
      file: join(pluginDir, 'panels', 'board.html')
    })
    for (const url of ['cc-plugin://acme.board/escape.txt', 'cc-plugin://acme.board/%2e%2e/secret.txt', 'cc-plugin://acme.board/']) {
      expect((await get(url)).status, url).toBe(404)
    }
  })

  it("serves the built SDK even when the plugin ships a file at the SDK's path", async () => {
    mkdirSync(join(pluginDir, '__sdk'))
    writeFileSync(join(pluginDir, '__sdk', 'panel.js'), '/* plugin impostor */')
    const res = await get(`cc-plugin://acme.board${PANEL_SDK_PATH}`)
    expect(await res.text()).toBe('/* sdk */')
    // HEAD of the SDK: no body, the same headers.
    const head = await get(`cc-plugin://acme.board${PANEL_SDK_PATH}`, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(head.headers.get('content-security-policy')).toBe(pluginCsp('acme.board'))
  })

  it('answers 404 for an unknown (or not enabled) plugin and a host that is not a plugin id', async () => {
    const unknown = await get('cc-plugin://other.plugin/panels/board.html')
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-security-policy')).toBe(pluginCsp('other.plugin'))
    const bad = await get('cc-plugin://not_an_id/panels/board.html')
    expect(bad.status).toBe(404)
    // No plugin to name: the strictest policy.
    expect(bad.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect((await get('cc-overlay://acme.board/panels/board.html')).status).toBe(404)
    expect((await get('not a url')).status).toBe(404)
    expect(logs.some((l) => l.includes('unknown or not enabled plugin'))).toBe(true)
  })

  it('does not serve outside the folder when the file becomes a symlink between the checks and the read', async () => {
    await swapBeforeRead(() => {
      rmSync(join(pluginDir, 'panels', 'board.html'))
      symlinkSync(join(root, 'secret.txt'), join(pluginDir, 'panels', 'board.html'))
    })
    const res = await get('cc-plugin://acme.board/panels/board.html')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret')
    expect(logs).toContain('cc-plugin: 404 for acme.board: the file became a symlink while it was read')
  })

  it('does not serve outside the folder when a folder above the file becomes a symlink between the checks and the read', async () => {
    mkdirSync(join(root, 'evil'))
    writeFileSync(join(root, 'evil', 'board.html'), 'secret')
    await swapBeforeRead(() => {
      renameSync(join(pluginDir, 'panels'), join(root, 'old-panels'))
      symlinkSync(join(root, 'evil'), join(pluginDir, 'panels'))
    })
    const res = await get('cc-plugin://acme.board/panels/board.html')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('secret')
    expect(logs).toContain('cc-plugin: 404 for acme.board: the file changed while it was read')
  })

  it('serves GET and HEAD only', async () => {
    const head = await get('cc-plugin://acme.board/panels/board.html', 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const post = await get('cc-plugin://acme.board/panels/board.html', 'POST')
    expect(post.status).toBe(404)
    // Refused before the URL is looked at: no plugin named, the strictest policy.
    expect(post.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    const missingHead = await get('cc-plugin://acme.board/missing.html', 'HEAD')
    expect(missingHead.status).toBe(404)
    expect(missingHead.headers.get('content-security-policy')).toBe(pluginCsp('acme.board'))
  })
})

describe('resolvePluginFile', () => {
  it('returns the realpath of the file it serves', async () => {
    const res = await resolvePluginFile('cc-plugin://acme.board/alias.html', deps)
    expect(res).toMatchObject({ ok: true, pluginId: 'acme.board', file: join(pluginDir, 'panels', 'board.html') })
  })
})

describe('pluginCsp', () => {
  it("allows the plugin's own origin only, and no network, frames or form posts", () => {
    const csp = pluginCsp('acme.board')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('script-src cc-plugin://acme.board;')
    expect(csp).toContain("style-src cc-plugin://acme.board 'unsafe-inline'")
    expect(csp).toContain('img-src cc-plugin://acme.board data:')
    expect(csp).toContain('font-src cc-plugin://acme.board')
    expect(csp).toContain('connect-src cc-plugin://acme.board;')
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("form-action 'none'")
    // The iframe's sandbox, repeated by the response: opaque origin however the page is loaded.
    expect(csp).toMatch(/(^|; )sandbox allow-scripts($|;)/)
    expect(csp).not.toMatch(/https?:|\*/)
  })
})

describe('pluginFileUrl and contentTypeOf', () => {
  it('builds an encoded URL from a relative path', () => {
    expect(pluginFileUrl('acme.board', 'panels/board.html')).toBe('cc-plugin://acme.board/panels/board.html')
    expect(pluginFileUrl('acme.board', './panels//two words#1.json')).toBe(
      'cc-plugin://acme.board/panels/two%20words%231.json'
    )
  })

  it('knows the usual web types and falls back to octet-stream', () => {
    expect(contentTypeOf('a/b.CSS')).toBe('text/css; charset=utf-8')
    expect(contentTypeOf('icon.svg')).toBe('image/svg+xml')
    expect(contentTypeOf('font.woff2')).toBe('font/woff2')
    expect(contentTypeOf('blob.bin')).toBe('application/octet-stream')
    expect(contentTypeOf('Makefile')).toBe('application/octet-stream')
  })
})
