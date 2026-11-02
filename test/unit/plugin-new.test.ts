// `ccc plugin new` (plan B Task 6): the scaffold validates with the app's own manifest checker,
// its dist/host.js activates in a real host context as it is, every flag changes what is written,
// and the refusals leave nothing behind.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/args'
import { run } from '../../src/cli/client'
import { defaultPluginId, PluginNewError, scaffoldPlugin, scaffoldSkillId } from '../../src/cli/plugin-new'
import { PLUGIN_ID_MAX_LENGTH, SKILL_ID_PATTERN } from '../../src/shared/manifest'
import { createContext } from '../../src/host/ctx'
import { PluginLoader } from '../../src/host/loader'
import { loadManifest } from '../../src/main/plugins/validate'
import { hostSpec } from '../fakes/host-spec'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-plugin-new-')))
})
afterEach(() => {
  // A test may have taken write access away from a folder: give it back so the cleanup can run.
  chmodSync(root, 0o700)
  for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) chmodSync(join(root, e.name), 0o700)
  rmSync(root, { recursive: true, force: true })
})

const files = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`)
      else out.push(`${prefix}${e.name}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

describe('parseArgs: plugin dev loop', () => {
  it('parses every subcommand', () => {
    expect(parseArgs(['plugin', 'new', 'dir'])).toEqual({ kind: 'plugin-new', dir: 'dir', panel: false, skill: false })
    expect(parseArgs(['plugin', 'new', 'dir', '--id', 'acme.todo', '--panel', '--cli', 'todo', '--skill'])).toEqual({
      kind: 'plugin-new',
      dir: 'dir',
      id: 'acme.todo',
      panel: true,
      cli: 'todo',
      skill: true
    })
    expect(parseArgs(['plugin', 'link', 'dir'])).toEqual({ kind: 'plugin-link', dir: 'dir' })
    expect(parseArgs(['plugin', 'link', '--project', '/p', 'dir'])).toEqual({ kind: 'plugin-link', dir: 'dir', project: '/p' })
    expect(parseArgs(['plugin', 'unlink', 'acme.todo'])).toEqual({ kind: 'plugin-unlink', id: 'acme.todo' })
    expect(parseArgs(['plugin', 'list'])).toEqual({ kind: 'plugin-list', json: false })
    expect(parseArgs(['plugin', 'list', '--json', '--project', '/p'])).toEqual({ kind: 'plugin-list', json: true, project: '/p' })
    expect(parseArgs(['plugin', 'logs', 'acme.todo'])).toEqual({ kind: 'plugin-logs', id: 'acme.todo', follow: false })
    expect(parseArgs(['plugin', 'logs', 'acme.todo', '--follow'])).toEqual({ kind: 'plugin-logs', id: 'acme.todo', follow: true })
  })

  it.each([
    [['plugin']],
    [['plugin', 'bogus']],
    [['plugin', 'new']],
    [['plugin', 'new', 'a', 'b']],
    [['plugin', 'new', 'a', '--id', 'NoDots']],
    [['plugin', 'new', 'a', '--id']],
    [['plugin', 'new', 'a', '--cli', 'Bad_Name']],
    [['plugin', 'new', 'a', '--cli', 'guide']],
    [['plugin', 'new', 'a', '--nope']],
    [['plugin', 'link']],
    [['plugin', 'link', '--project']],
    [['plugin', 'unlink', 'not an id']],
    [['plugin', 'list', 'extra']],
    [['plugin', 'list', '--follow']],
    // The id of `logs` becomes a file name: a path-like one never gets past the parser.
    [['plugin', 'logs', '../../etc/passwd']],
    [['plugin', 'logs', 'a.b/../c']],
    [['plugin', 'logs']]
  ])('%j is a usage error', (argv) => {
    expect(parseArgs(argv).kind).toBe('usage')
  })

  it('plugin <sub> --help prints the plugin usage lines', () => {
    expect(parseArgs(['plugin', '--help'])).toEqual({ kind: 'help', command: 'plugin' })
    expect(parseArgs(['plugin', 'link', '--help'])).toEqual({ kind: 'help', command: 'plugin' })
  })
})

describe('scaffoldPlugin', () => {
  it('a bare scaffold validates and its host activates as it is', async () => {
    const dir = join(root, 'my-tool')
    const made = scaffoldPlugin({ dir, panel: false, skill: false })
    expect(made).toMatchObject({ id: 'local.my-tool', dir })
    expect(files(dir)).toEqual(['README.md', 'dist/host.js', 'plugin.json'])

    const manifest = await loadManifest(dir)
    expect(manifest).toMatchObject({ ok: true, manifest: { id: 'local.my-tool', name: 'My tool', main: 'dist/host.js', api: 1 } })

    const log = vi.fn()
    const loader = new PluginLoader({ makeContext: (spec) => createContext(spec, { log }), log: () => {} })
    const [state] = await loader.activateAll([hostSpec({ id: 'local.my-tool', dir, main: 'dist/host.js' })])
    expect(state).toMatchObject({ id: 'local.my-tool', state: 'active' })
    // The marker lines of the unused flags are gone, not left as comments.
    const host = readFileSync(join(dir, 'dist/host.js'), 'utf8')
    expect(host).not.toContain('//#')
    expect(host).not.toContain('panels.')
    expect(host).not.toContain('cli.register')
    expect(host).not.toContain('__')
  })

  it('--panel, --cli and --skill add their files, manifest entries and host code; all of it validates and activates', async () => {
    const dir = join(root, 'full')
    scaffoldPlugin({ dir, id: 'acme.todo-list', panel: true, cli: 'todo', skill: true })
    expect(files(dir)).toEqual([
      'README.md',
      'dist/host.js',
      'panels/main.html',
      'panels/main.js',
      'plugin.json',
      'skills/todo/SKILL.md'
    ])
    const loaded = await loadManifest(dir)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.manifest.contributes).toMatchObject({
      panels: [{ id: 'main', entry: 'panels/main.html' }],
      cli: [{ name: 'todo' }],
      skills: [{ id: 'todo', dir: 'skills/todo' }]
    })
    expect(loaded.manifest.name).toBe('Todo list')
    expect(readFileSync(join(dir, 'skills/todo/SKILL.md'), 'utf8')).toMatch(/^---\nname: todo\ndescription: [^\n]+\n---\n/)
    const host = readFileSync(join(dir, 'dist/host.js'), 'utf8')
    expect(host).toContain("ctx.cli.register('todo'")
    expect(host).toContain("ctx.panels.onMessage('main'")
    expect(host).not.toContain('//#')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('ccc todo')

    const loader = new PluginLoader({ makeContext: (spec) => createContext(spec, { log: () => {} }), log: () => {} })
    const [state] = await loader.activateAll([hostSpec({ id: 'acme.todo-list', dir, main: 'dist/host.js', panels: ['main'], cli: ['todo'] })])
    expect(state).toMatchObject({ state: 'active' })
  })

  it('the skill id follows the plugin id when there is no command', async () => {
    const dir = join(root, 'x')
    scaffoldPlugin({ dir, id: 'acme.notes', panel: false, skill: true })
    expect(existsSync(join(dir, 'skills/notes/SKILL.md'))).toBe(true)
    expect((await loadManifest(dir)).ok).toBe(true)
  })

  // Review finding: with --skill and no --cli the skill id was the plugin id's last segment as is,
  // and a 65-character one (a valid plugin id) made a scaffold whose manifest failed validation.
  // So every flag combination, with ordinary and longest ids, must validate with validate.ts.
  const LONG_SEGMENT = `a${'b'.repeat(64)}`
  const LONGEST = `x.${'y'.repeat(PLUGIN_ID_MAX_LENGTH - 2)}`
  it.each(['acme.todo', `acme.${LONG_SEGMENT}`, LONGEST])('every scaffold variant of %s validates', async (id) => {
    expect(id.length).toBeLessThanOrEqual(PLUGIN_ID_MAX_LENGTH)
    let n = 0
    for (const panel of [false, true]) {
      for (const cli of [undefined, 'todo']) {
        for (const skill of [false, true]) {
          const dir = join(root, `v${n++}`)
          scaffoldPlugin({ dir, id, panel, skill, ...(cli !== undefined ? { cli } : {}) })
          const loaded = await loadManifest(dir)
          expect(loaded, `${id} panel=${panel} cli=${cli} skill=${skill}`).toMatchObject({ ok: true })
        }
      }
    }
  })

  // Review finding (round 2): a skill id YAML reads as a non-string can never load, so the scaffold
  // refuses it rather than writing a SKILL.md the app would skip.
  it.each([
    ['acme.no', undefined],
    ['acme.null', undefined],
    ['acme.todo', 'true']
  ])('refuses a skill id YAML reads as a non-string: %s --cli %s', (id, cli) => {
    const dir = join(root, 'yaml')
    expect(() => scaffoldPlugin({ dir, id, panel: false, skill: true, ...(cli !== undefined ? { cli } : {}) })).toThrow(
      /reads as a YAML boolean, null or number.*pass --cli <another name>/
    )
    expect(existsSync(dir)).toBe(false)
    // Without --skill the same id is fine: no SKILL.md, no name.
    scaffoldPlugin({ dir, id, panel: false, skill: false, ...(cli !== undefined ? { cli } : {}) })
    expect(existsSync(join(dir, 'plugin.json'))).toBe(true)
  })

  it('the derived skill id fits the skill id rules', () => {
    expect(scaffoldSkillId(`acme.${LONG_SEGMENT}`, undefined)).toBe(LONG_SEGMENT.slice(0, 64))
    expect(SKILL_ID_PATTERN.test(scaffoldSkillId(LONGEST, undefined))).toBe(true)
    expect(scaffoldSkillId('acme.notes', undefined)).toBe('notes')
    expect(scaffoldSkillId('acme.notes', 'nt')).toBe('nt')
  })

  it.skipIf(process.getuid?.() === 0)('a filesystem error is a refusal naming the path, not a crash', () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    const dir = join(locked, 'p')
    expect(() => scaffoldPlugin({ dir, panel: false, skill: false })).toThrow(PluginNewError)
    expect(() => scaffoldPlugin({ dir, panel: false, skill: false })).toThrow(`cannot create the folder ${dir}`)
  })

  it('creates missing parent folders and accepts an existing empty folder', () => {
    scaffoldPlugin({ dir: join(root, 'a', 'b', 'c-plugin'), panel: false, skill: false })
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(scaffoldPlugin({ dir: empty, panel: false, skill: false }).id).toBe('local.empty')
  })

  it('refuses a non-empty folder, a file, a bad id and a bad command name, writing nothing', () => {
    const full = join(root, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'keep.txt'), 'mine')
    // A foreign file does not block: the scaffold goes beside it.
    scaffoldPlugin({ dir: full, panel: false, skill: false })
    expect(readFileSync(join(full, 'keep.txt'), 'utf8')).toBe('mine')
    expect(() => scaffoldPlugin({ dir: full, panel: false, skill: false })).toThrow(/plugin\.json, dist\/host\.js, README\.md/)

    const file = join(root, 'file')
    writeFileSync(file, 'x')
    expect(() => scaffoldPlugin({ dir: file, panel: false, skill: false })).toThrow(/not a folder/)

    const dir = join(root, 'p')
    expect(() => scaffoldPlugin({ dir, id: 'NoDots', panel: false, skill: false })).toThrow(PluginNewError)
    expect(() => scaffoldPlugin({ dir, cli: 'open', panel: false, skill: false })).toThrow(/command name/)
    expect(existsSync(dir)).toBe(false)
  })

  it('derives an id from the folder name, or asks for --id', () => {
    expect(defaultPluginId('/x/My Cool_Tool')).toBe('local.my-cool-tool')
    expect(defaultPluginId('/x/123')).toBeUndefined()
    expect(defaultPluginId('/x/---')).toBeUndefined()
    expect(() => scaffoldPlugin({ dir: join(root, '123'), panel: false, skill: false })).toThrow(/--id/)
  })
})

describe('ccc plugin new through the client', () => {
  const capture = (): { out: { stdout: (t: string) => void; stderr: (t: string) => void }; o: () => string; e: () => string } => {
    let o = ''
    let e = ''
    return { out: { stdout: (t) => void (o += t), stderr: (t) => void (e += t) }, o: () => o, e: () => e }
  }

  it('works with no app, resolves the folder against the cwd and prints the next step', async () => {
    const c = capture()
    const code = await run(['plugin', 'new', 'rel-plugin', '--cli', 'rel'], { CC_COCKPIT_SOCK: '/nonexistent/sock' }, Readable.from([]), c.out, root)
    expect(code).toBe(0)
    const dir = join(root, 'rel-plugin')
    expect(existsSync(join(dir, 'plugin.json'))).toBe(true)
    expect(c.o()).toContain(`ccc plugin link ${dir}`)
    expect(c.o()).toContain('local.rel-plugin')
    expect(c.o()).toContain('then try: ccc rel\n')
    expect(c.o()).toContain('left out: a panel (--panel), a Claude skill (--skill);')
  })

  it('a bare scaffold says it has no command, panel or skill; a full one says nothing is left out', async () => {
    const bare = capture()
    expect(await run(['plugin', 'new', 'bare'], {}, Readable.from([]), bare.out, root)).toBe(0)
    expect(bare.o()).toContain('left out: a panel (--panel), a ccc command (--cli <name>), a Claude skill (--skill);')
    expect(bare.o()).not.toContain('then try:')
    const full = capture()
    expect(await run(['plugin', 'new', 'full', '--panel', '--cli', 'full', '--skill'], {}, Readable.from([]), full.out, root)).toBe(0)
    expect(full.o()).not.toContain('left out:')
    expect(full.o()).toContain('then try: ccc full\n')
  })

  it.skipIf(process.getuid?.() === 0)('a folder it cannot write is exit 1 with the reason, not a silent 0', async () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    const c = capture()
    expect(await run(['plugin', 'new', 'locked/p'], {}, Readable.from([]), c.out, root)).toBe(1)
    expect(c.e()).toMatch(/^ccc: cannot create the folder .*locked\/p: EACCES/)
    expect(c.o()).toBe('')
  })

  it('a folder holding a file the scaffold writes is exit 1 naming the files', async () => {
    mkdirSync(join(root, 'busy'))
    writeFileSync(join(root, 'busy', 'plugin.json'), '')
    writeFileSync(join(root, 'busy', 'README.md'), '')
    const c = capture()
    expect(await run(['plugin', 'new', 'busy'], {}, Readable.from([]), c.out, root)).toBe(1)
    expect(c.e()).toContain('plugin.json, README.md')
    expect(c.o()).toBe('')
  })
})

describe('scaffold layout', () => {
  it('indents every generated file with multiples of two spaces, whatever the flags', () => {
    const dir = join(root, 'indent')
    const made = scaffoldPlugin({ dir, panel: true, cli: 'tool', skill: true })
    for (const rel of made.files) {
      for (const line of readFileSync(join(dir, rel), 'utf8').split('\n')) {
        if (rel.endsWith('.md')) continue // markdown lists and code fences have their own rules
        const indent = /^ */.exec(line)?.[0].length ?? 0
        expect(indent % 2, `${rel}: ${JSON.stringify(line)}`).toBe(0)
      }
    }
  })

  it('makes a nested plugin inside a plugin, and a parent around a nested one', () => {
    const a = join(root, 'a')
    scaffoldPlugin({ dir: a, panel: false, skill: false })
    expect(scaffoldPlugin({ dir: join(a, 'inner'), panel: false, skill: false }).id).toBe('local.inner')

    const b = join(root, 'b')
    scaffoldPlugin({ dir: join(b, 'inner'), panel: false, skill: false })
    expect(scaffoldPlugin({ dir: b, panel: false, skill: false }).id).toBe('local.b')
    expect(existsSync(join(b, 'inner', 'plugin.json'))).toBe(true)
  })

  it('refuses naming the files, and writes nothing', () => {
    const d = join(root, 'c')
    mkdirSync(join(d, 'dist'), { recursive: true })
    writeFileSync(join(d, 'dist', 'host.js'), 'mine')
    expect(() => scaffoldPlugin({ dir: d, panel: false, skill: false })).toThrow(/dist\/host\.js/)
    expect(existsSync(join(d, 'plugin.json'))).toBe(false)
    expect(readFileSync(join(d, 'dist', 'host.js'), 'utf8')).toBe('mine')
  })
})
