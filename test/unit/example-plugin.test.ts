// examples/plugin is the master copy of the public template repo BronOS/cc-cockpit-plugin-example.
// Authors build from that repo alone, so it carries a copy of the API types and a built host; both
// go stale in silence unless something here compares them. It is also listed in the official index,
// so anyone can install it: the fake ctx below has no exec, sessions, overlay or secrets, and a call
// to any of them would fail these tests.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activate } from '../../examples/plugin/src/host'
import { loadManifest } from '../../src/main/plugins/validate'

const REPO = resolve(__dirname, '../..')
const EXAMPLE = join(REPO, 'examples/plugin')

interface Harness {
  send: (message: unknown) => void
  settle: () => Promise<void>
  posted: unknown[]
  badges: unknown[]
  stored: Map<string, unknown>
  run: (id: string) => unknown
  notes: string[]
}

function start(saved?: number): Harness {
  const stored = new Map<string, unknown>(saved === undefined ? [] : [['clicks', saved]])
  const posted: unknown[] = []
  const badges: unknown[] = []
  const notes: string[] = []
  const commands = new Map<string, () => unknown>()
  let listener: (message: unknown) => void = () => {}
  const noop = (): void => {}
  activate({
    settings: { project: { greeting: 'Hi' }, app: {} },
    onSettingsChange: () => noop,
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => void stored.set(key, value)
    },
    panels: {
      post: (_id: string, message: unknown) => void posted.push(message),
      onMessage: (_id: string, l: (message: unknown) => void) => ((listener = l), noop)
    },
    badge: (_id: string, value: unknown) => void badges.push(value),
    commands: { register: (id: string, run: () => unknown) => (commands.set(id, run), noop) },
    notify: async (text: string) => void notes.push(text),
    log: { info: noop, warn: noop, error: noop }
  } as never)
  return {
    send: (message) => listener(message),
    settle: () => new Promise((r) => setTimeout(r, 5)),
    posted,
    badges,
    stored,
    run: (id) => commands.get(id)?.(),
    notes
  }
}

describe('examples/plugin', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ccc-example-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('its copy of the API types is the app\'s', () => {
    // Not toBe on the strings: a failure would print both files.
    const same = readFileSync(join(EXAMPLE, 'sdk/types.ts')).equals(readFileSync(join(REPO, 'src/sdk/types.ts')))
    expect(same, 'stale examples/plugin/sdk/types.ts: copy src/sdk/types.ts over it').toBe(true)
  })

  it('dist/host.js is a fresh build, self-contained and free of local paths', () => {
    const out = join(tmp, 'host.js')
    execFileSync(process.execPath, [join(EXAMPLE, 'build.mjs'), out], { cwd: '/', stdio: 'pipe', timeout: 25_000 })
    const fresh = readFileSync(out)
    expect(fresh.equals(readFileSync(join(EXAMPLE, 'dist/host.js'))), 'stale dist: run `npm run build:example`').toBe(true)
    const text = fresh.toString()
    expect(text).not.toContain(REPO)
    expect(text).toContain('module.exports')
    expect(text).not.toMatch(/require\(["'](\.|\/)/)
  }, 30_000)

  it('builds with the esbuild the app pins, so the byte comparison above means what a template user gets', () => {
    const read = (p: string): { devDependencies: Record<string, string> } => JSON.parse(readFileSync(p, 'utf8'))
    expect(read(join(EXAMPLE, 'package.json')).devDependencies.esbuild).toBe(read(join(REPO, 'package.json')).devDependencies.esbuild)
  })

  it('the manifest passes the app validation', async () => {
    const result = await loadManifest(EXAMPLE)
    if (!result.ok) throw new Error(result.errors.join('; '))
    expect(result.manifest.id).toBe('cockpit.example')
    expect(result.manifest.contributes?.panels?.map((p) => p.id)).toEqual(['main'])
  })

  it('counts clicks across a restart, shows them on the badge, and clears on reset', async () => {
    const h = start(2)
    h.send({ type: 'click' })
    await h.settle()
    expect(h.stored.get('clicks')).toBe(3)
    expect(h.badges.at(-1)).toBe(3)
    h.send({ type: 'reset' })
    await h.settle()
    expect(h.stored.get('clicks')).toBe(0)
    expect(h.badges.at(-1)).toBeNull()
  })

  it('a click right after a start does not overwrite the saved count', async () => {
    const h = start(5)
    h.send({ type: 'click' })
    h.send({ type: 'click' })
    await h.settle()
    expect(h.stored.get('clicks')).toBe(7)
  })

  it('answers ready with its state, ignores junk, and its command notifies', async () => {
    const h = start()
    await h.settle()
    h.posted.length = 0
    for (const junk of [null, 1, 'click', [], { type: 'nope' }]) h.send(junk)
    await h.settle()
    expect(h.posted).toEqual([])
    h.send({ type: 'ready' })
    await h.settle()
    expect(h.posted).toEqual([{ type: 'state', greeting: 'Hi', clicks: 0 }])
    await h.run('say-hello')
    expect(h.notes).toEqual(['Hi! 0 clicks so far.'])
  })
})
