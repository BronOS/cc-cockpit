// Task 34: the hello reference plugin ships a BUILT host (plugins/hello/dist/host.js, committed).
// A source edit without `npm run build:hello` would leave users running stale code, so this test
// rebuilds into a temp dir with the real build script and compares bytes. It also checks that the
// manifest is one the app accepts and that the bundle is self-contained.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activate, deactivate } from '../../plugins/hello/src/host'
import { loadManifest } from '../../src/main/plugins/validate'

const REPO = resolve(__dirname, '../..')
const HELLO = join(REPO, 'plugins/hello')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccc-hello-dist-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('plugins/hello', () => {
  it('dist/host.js is what a fresh build of src/host.ts produces', () => {
    const out = join(tmp, 'host.js')
    // A synchronous call is out of reach of vitest's timeout: its own timeout makes a hung build fail.
    execFileSync(process.execPath, [join(REPO, 'scripts/build-hello.mjs'), out], { cwd: tmp, stdio: 'pipe', timeout: 25_000 })
    const fresh = readFileSync(out)
    const committed = readFileSync(join(HELLO, 'dist/host.js'))
    // Not toEqual on the buffers: a failure would print both files.
    expect(fresh.equals(committed), 'stale plugins/hello/dist/host.js: run `npm run build:hello`').toBe(true)
    // A real esbuild run: generous, a cold start on a loaded machine is far over the 5 s default.
  }, 30_000)

  it('the build is independent of the working directory and carries no absolute path', () => {
    const a = join(tmp, 'a.js')
    execFileSync(process.execPath, [join(REPO, 'scripts/build-hello.mjs'), a], { cwd: '/', stdio: 'pipe', timeout: 25_000 })
    const text = readFileSync(a, 'utf8')
    // Not toBe on the strings: a failure would print both bundles.
    expect(
      text === readFileSync(join(HELLO, 'dist/host.js'), 'utf8'),
      'a build run from / differs from plugins/hello/dist/host.js: the build depends on the cwd, or the dist is stale (run `npm run build:hello`)'
    ).toBe(true)
    expect(text).not.toContain(REPO)
    expect(text).not.toContain(tmp)
    // Bundled for require(): CommonJS, and no import of the app's code is left behind.
    expect(text).toContain('module.exports')
    expect(text).not.toMatch(/require\(["'](\.|\/)/)
  }, 30_000)

  it('the host calls ctx.oauth nowhere (it is documented in a comment only)', () => {
    const src = readFileSync(join(HELLO, 'src/host.ts'), 'utf8')
    // Drop block comments and whole-line `//` comments only: ctx.oauth is documented there on
    // purpose, and a trailing-comment regex would also cut code after a `//` inside a string.
    // Whether the token reaches the panel is the runtime test below, not a source grep.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('ctx.oauth')
  })

  it('the panel is never sent the secret setting, only whether it is set', async () => {
    const TOKEN = 'tok-SECRET-123'
    const posted: string[] = []
    const noop = (): void => {}
    const ctx = {
      pluginId: 'hello',
      settings: { project: {}, app: { apiToken: TOKEN } },
      onSettingsChange: () => noop,
      schedule: () => noop,
      badge: noop,
      notify: async () => {},
      log: { error: noop, info: noop, warn: noop },
      commands: { register: () => noop },
      panels: { post: (_id: string, m: unknown) => void posted.push(JSON.stringify(m)), onMessage: () => noop },
      storage: { get: async () => null, set: async () => {} },
      secrets: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
      sessions: { list: async () => [], onChange: () => noop, send: async () => ({ queued: true }) },
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      overlay: {}
    }
    activate(ctx as never)
    await new Promise((r) => setTimeout(r, 20))
    deactivate()
    expect(posted.length).toBeGreaterThan(0)
    expect(posted.some((m) => m.includes('"tokenSet":true'))).toBe(true)
    expect(posted.filter((m) => m.includes(TOKEN))).toEqual([])
  })

  it('the manifest passes the app validation, with every contribution point', async () => {
    const result = await loadManifest(HELLO)
    if (!result.ok) throw new Error(result.errors.join('; '))
    const c = result.manifest.contributes
    expect(c?.panels?.map((p) => p.id)).toEqual(['hello'])
    expect(c?.settings?.project).toBeDefined()
    expect(c?.settings?.app).toBeDefined()
    // Accounts left core (design §6): the manifest must not declare them any more.
    expect(c).not.toHaveProperty('accounts')
    // The secret settings field (design §6): a top-level string with format "secret". Checked
    // on the raw manifest too, since the loaded one could be normalised.
    const appProps = (c?.settings?.app as { properties?: Record<string, { type?: string; format?: string }> } | undefined)
      ?.properties
    expect(appProps?.apiToken).toMatchObject({ type: 'string', format: 'secret' })
    expect(c?.commands?.map((k) => [k.id, k.key])).toEqual([['say-hello', 'Cmd+Shift+H']])
    expect(c?.themes?.map((t) => t.id)).toEqual(['hello-dusk'])
  })
})
