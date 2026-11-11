// Plan B, Task 10: the built-in browser plugin. The committed dist must be a fresh build of the
// source (as test/unit/hello-dist.test.ts does for hello), the manifest must pass the app's own
// validation, and the host's argument handling is tested against a fake ctx.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activate, resolveTarget } from '../../plugins/browser/src/host'
import { BUNDLED_PLUGINS } from '../../src/main/plugins/bundled'
import { loadManifest } from '../../src/main/plugins/validate'
import type { CliHandler } from '../../src/sdk/types'

const REPO = resolve(__dirname, '../..')
const BROWSER = join(REPO, 'plugins/browser')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccc-browser-plugin-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('plugins/browser build and manifest', () => {
  it('dist/host.js is what a fresh build of src/host.ts produces, with no absolute path', () => {
    const out = join(tmp, 'host.js')
    execFileSync(process.execPath, [join(REPO, 'scripts/build-browser.mjs'), out], { cwd: '/', stdio: 'pipe', timeout: 25_000 })
    const fresh = readFileSync(out)
    expect(fresh.equals(readFileSync(join(BROWSER, 'dist/host.js'))), 'stale plugins/browser/dist/host.js: run `npm run build:browser`').toBe(true)
    expect(fresh.toString('utf8')).not.toContain(REPO)
  }, 30_000)

  it('the manifest passes the app validation and matches the bundled allowlist', async () => {
    const result = await loadManifest(BROWSER)
    if (!result.ok) throw new Error(result.errors.join('; '))
    const m = result.manifest
    expect(m.id).toBe('cockpit.browser')
    expect(BUNDLED_PLUGINS.find((p) => p.dir === 'browser')).toMatchObject({ id: m.id, enabledByDefault: true })
    expect(m.contributes?.panels).toEqual([{ id: 'view', title: 'Browser', kind: 'webview', defaultZone: 'right' }])
    expect(m.contributes?.cli?.map((c) => c.name)).toEqual(['browser'])
    expect(m.contributes?.skills?.map((s) => s.id)).toEqual(['browser'])
    expect(m.contributes?.settings?.app).toBeDefined()
  })
})

describe('resolveTarget', () => {
  it('keeps http(s) URLs and adds http:// to a bare localhost or IP with a port', () => {
    expect(resolveTarget('https://example.com/a?b=1', '/w')).toEqual({ target: 'https://example.com/a?b=1' })
    expect(resolveTarget('localhost:5173', '/w')).toEqual({ target: 'http://localhost:5173' })
    expect(resolveTarget('127.0.0.1:8080/x', '/w')).toEqual({ target: 'http://127.0.0.1:8080/x' })
  })
  // Review finding (ext round 9): a query or fragment right after the port, and IPv6 loopback,
  // were read as relative file paths.
  it('adds http:// when a query or fragment follows the port, and to [::1]:PORT', () => {
    expect(resolveTarget('localhost:3000?x=1', '/w')).toEqual({ target: 'http://localhost:3000?x=1' })
    expect(resolveTarget('localhost:3000#a', '/w')).toEqual({ target: 'http://localhost:3000#a' })
    expect(resolveTarget('127.0.0.1:8080?q', '/w')).toEqual({ target: 'http://127.0.0.1:8080?q' })
    expect(resolveTarget('[::1]:3000', '/w')).toEqual({ target: 'http://[::1]:3000' })
    expect(resolveTarget('[::1]:3000/app?x#y', '/w')).toEqual({ target: 'http://[::1]:3000/app?x#y' })
    // Still a file without a port, or with something else after it.
    expect(resolveTarget('[::1]', '/w')).toEqual({ target: '/w/[::1]' })
    expect(resolveTarget('localhost:3000x', '/w')).toEqual({ target: '/w/localhost:3000x' })
  })
  it('reads a bare localhost or IP without a port as a file in the cwd', () => {
    expect(resolveTarget('localhost', '/w')).toEqual({ target: '/w/localhost' })
    expect(resolveTarget('10.0.0.1', '/w')).toEqual({ target: '/w/10.0.0.1' })
    expect(resolveTarget('localhost/index.html', '/w')).toEqual({ target: '/w/localhost/index.html' })
  })
  it('joins a relative file onto the caller cwd and leaves dots for main to resolve', () => {
    expect(resolveTarget('./mock.html', '/w/proj')).toEqual({ target: '/w/proj/./mock.html' })
    expect(resolveTarget('../other/a.html', '/w/proj/')).toEqual({ target: '/w/proj/../other/a.html' })
    expect(resolveTarget('/abs/./b/../c.html', '/w')).toEqual({ target: '/abs/./b/../c.html' })
  })
  it('a `..` after a symlink names the file the OS finds (main realpaths the target)', async () => {
    // tmp/link -> tmp/deep/real; `link/../x.html` is tmp/deep/x.html to the shell, not tmp/x.html.
    mkdirSync(join(tmp, 'deep/real'), { recursive: true })
    writeFileSync(join(tmp, 'deep/x.html'), 'deep')
    writeFileSync(join(tmp, 'x.html'), 'top')
    symlinkSync(join(tmp, 'deep/real'), join(tmp, 'link'))
    const resolved = resolveTarget('link/../x.html', tmp)
    if (!('target' in resolved)) throw new Error(resolved.error)
    // fs/promises realpath, as main's resolveWebviewTarget uses: the OS's realpath(3). (The sync JS
    // realpathSync runs path.resolve first, which collapses the `..` lexically.)
    expect(await realpath(resolved.target)).toBe(await realpath(join(tmp, 'deep/x.html')))
    expect(readFileSync(resolved.target, 'utf8')).toBe('deep')
  })
  it('refuses other schemes and an empty target', () => {
    expect(resolveTarget('file:///etc/passwd', '/w')).toMatchObject({ error: expect.stringContaining('file:') })
    expect(resolveTarget('javascript://x', '/w')).toHaveProperty('error')
    expect(resolveTarget('  ', '/w')).toHaveProperty('error')
  })
})

describe('browser host', () => {
  function setup(home?: string, failing = false) {
    const calls: string[] = []
    let handler: CliHandler | undefined
    let page = { url: '', title: '' }
    const warnings: string[] = []
    const ctx = {
      settings: { project: {}, app: home === undefined ? {} : { home } },
      log: { info: () => {}, error: () => {}, warn: (...a: unknown[]) => void warnings.push(a.join(' ')) },
      webview: {
        navigate: async (p: string, t: string) => {
          if (failing) throw new Error('refused by main')
          calls.push(`navigate ${p} ${t}`)
          page = { url: t, title: 'T' }
        },
        reload: async (p: string) => {
          if (failing) throw new Error('no view')
          calls.push(`reload ${p}`)
        },
        current: async () => {
          if (failing) throw new Error('no view')
          return page
        }
      },
      panels: { show: (p: string) => void calls.push(`show ${p}`) },
      cli: { register: (_n: string, h: CliHandler) => ((handler = h), () => {}) }
    }
    activate(ctx as never)
    const run = async (...argv: string[]) => await handler!(argv, { cwd: '/w/proj', stdin: '' } as never)
    return { calls, run, warnings }
  }

  it('open navigates, then shows the panel; url and reload follow', async () => {
    const { calls, run } = setup()
    expect(await run('open', 'mock.html')).toEqual({ stdout: 'ok\n' })
    expect(calls).toEqual(['navigate view /w/proj/mock.html', 'show view'])
    expect(await run('url')).toEqual({ stdout: '/w/proj/mock.html\tT\n' })
    expect(await run('reload')).toEqual({ stdout: 'ok\n' })
  })
  it('url on a blank panel, bad usage and a bad scheme exit 2 without touching the view', async () => {
    const { calls, run } = setup()
    expect(await run('url')).toEqual({ stdout: 'blank\n' })
    expect(await run('open')).toMatchObject({ code: 2 })
    expect(await run('open', 'ftp://x')).toMatchObject({ code: 2 })
    expect(await run('nope')).toMatchObject({ code: 2 })
    expect(calls).toEqual([])
  })
  it('turns a rejection from the webview into exit 1 for open, url and reload', async () => {
    const { run } = setup(undefined, true)
    expect(await run('open', 'http://localhost:1/')).toEqual({ stderr: 'refused by main\n', code: 1 })
    expect(await run('url')).toEqual({ stderr: 'no view\n', code: 1 })
    expect(await run('reload')).toEqual({ stderr: 'no view\n', code: 1 })
  })
  // Review finding (ext round 10): `ccc browser open` said `ok` with the dev server down, and
  // `ccc browser url` could not tell a failed page from a loaded one.
  it('a page that failed to load: open exits 1 with the error and still shows the panel; url says why', async () => {
    const calls: string[] = []
    let handler: CliHandler | undefined
    const failed = { url: 'http://localhost:5173/', title: '', error: 'ERR_CONNECTION_REFUSED (-102)' }
    const ctx = {
      settings: { project: {}, app: {} },
      log: { info: () => {}, error: () => {}, warn: () => {} },
      webview: {
        navigate: async () => {
          throw new Error('webview.navigate: http://localhost:5173/ did not load: ERR_CONNECTION_REFUSED (-102)')
        },
        current: async () => failed
      },
      panels: { show: (p: string) => void calls.push(`show ${p}`) },
      cli: { register: (_n: string, h: CliHandler) => ((handler = h), () => {}) }
    }
    activate(ctx as never)
    const run = async (...argv: string[]) => await handler!(argv, { cwd: '/w', stdin: '' } as never)
    expect(await run('open', 'localhost:5173')).toEqual({
      stderr: 'webview.navigate: http://localhost:5173/ did not load: ERR_CONNECTION_REFUSED (-102)\n',
      code: 1
    })
    expect(calls).toEqual(['show view'])
    expect(await run('url')).toEqual({ stdout: 'http://localhost:5173/\tfailed to load: ERR_CONNECTION_REFUSED (-102)\n' })
  })

  // design-web.md §9.9: in server mode main makes no view; the plugin must still activate, and its
  // command passes main's text on so Claude does not send the person to an empty panel.
  it('server mode: a refused home navigate does not fail activation; open exits 1 with the text and shows nothing', async () => {
    const calls: string[] = []
    const warnings: string[] = []
    let handler: CliHandler | undefined
    const refusal = 'webview.navigate: web views are not available in server mode'
    const ctx = {
      settings: { project: {}, app: { home: 'https://example.com/' } },
      log: { info: () => {}, error: () => {}, warn: (...a: unknown[]) => void warnings.push(a.join(' ')) },
      webview: {
        navigate: async () => {
          throw new Error(refusal)
        },
        current: async () => ({ url: '', title: '' })
      },
      panels: { show: (p: string) => void calls.push(`show ${p}`) },
      cli: { register: (_n: string, h: CliHandler) => ((handler = h), () => {}) }
    }
    expect(() => activate(ctx as never)).not.toThrow()
    expect(handler).toBeDefined()
    await expect.poll(() => warnings.join()).toContain('not available in server mode')
    const run = async (...argv: string[]) => await handler!(argv, { cwd: '/w', stdin: '' } as never)
    expect(await run('open', 'http://localhost:5173/')).toEqual({ stderr: `${refusal}\n`, code: 1 })
    expect(await run('url')).toEqual({ stdout: 'blank\n' })
    expect(calls).toEqual([])
  })

  it('loads an http(s) home on start and ignores any other value', () => {
    expect(setup('https://example.com/').calls).toEqual(['navigate view https://example.com/'])
    const bad = setup('javascript:alert(1)')
    expect(bad.calls).toEqual([])
    expect(bad.warnings.join()).toContain('home')
    expect(setup().calls).toEqual([])
  })
})
