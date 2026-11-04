import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadManifest, validateManifest } from '../../src/main/plugins/validate'
import { PLUGIN_ID_PATTERN, isReservedPluginId, relativePathProblem } from '../../src/shared/manifest'

let dir: string
let outside: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-manifest-'))
  outside = mkdtempSync(join(tmpdir(), 'ccc-manifest-out-'))
  mkdirSync(join(dir, 'dist'))
  mkdirSync(join(dir, 'panels'))
  mkdirSync(join(dir, 'icons'))
  mkdirSync(join(dir, 'themes'))
  for (const f of ['dist/host.js', 'panels/board.html', 'icons/board.svg', 'themes/solar.json']) {
    writeFileSync(join(dir, f), '{}')
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bronos.jira',
    name: 'Jira',
    version: '0.3.0',
    api: 1,
    main: 'dist/host.js',
    contributes: {
      panels: [{ id: 'board', title: 'Board', icon: 'icons/board.svg', entry: 'panels/board.html', defaultZone: 'left' }],
      settings: {
        project: { type: 'object', properties: { board: { type: 'string', default: 'main' } } },
        app: { type: 'object', properties: { baseUrl: { type: 'string' } } }
      },
      commands: [{ id: 'refresh', title: 'Jira: Refresh', key: 'cmd+shift+j' }],
      themes: [{ id: 'solar', file: 'themes/solar.json' }]
    },
    ...patch
  }
}

async function errorsOf(raw: unknown): Promise<string[]> {
  const r = await validateManifest(raw, dir)
  if (r.ok) throw new Error('expected a validation failure')
  return r.errors
}

describe('validateManifest', () => {
  it('accepts a full valid manifest and returns it typed', async () => {
    const r = await validateManifest(manifest(), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.contributes?.panels?.[0]?.id).toBe('board')
  })

  it('accepts a minimal manifest (no main, no contributions)', async () => {
    const r = await validateManifest({ id: 'a.b', name: 'X', version: '1.0.0', api: 1 }, dir)
    expect(r.ok).toBe(true)
  })

  it('refuses non-objects', async () => {
    for (const raw of [null, [], 'x', 3]) expect(await errorsOf(raw)).toEqual(['plugin.json must be a JSON object'])
  })

  it('refuses a bad id before it can reach a path', async () => {
    for (const id of ['jira', 'Bronos.Jira', '../evil.plugin', 'a/b.c', 'a..b', '.a.b', 'a.b.', 'a b.c', '']) {
      const errors = await errorsOf(manifest({ id }))
      expect(errors.some((e) => e.startsWith('/id ')), id).toBe(true)
    }
  })

  it('the id regex matches the plan', () => {
    expect(PLUGIN_ID_PATTERN.test('bronos.jira')).toBe(true)
    expect(PLUGIN_ID_PATTERN.test('a-b.c-d.e')).toBe(true)
    expect(PLUGIN_ID_PATTERN.test('single')).toBe(false)
  })

  it('refuses ids a URL parser would read as an IPv4 host', () => {
    // WHATWG URL turns `cc-plugin://1.2/` into host 1.0.0.2 and `0x7f.1` into 127.0.0.1.
    for (const id of ['1.2', '1.0.0.2', '0x7f.1', 'a.1', 'a.0xff', 'bronos.9lives']) expect(PLUGIN_ID_PATTERN.test(id), id).toBe(false)
    for (const id of ['1password.cli', 'a.b2', 'x.0x.y']) expect(PLUGIN_ID_PATTERN.test(id), id).toBe(true)
  })

  it('refuses a version that is not path-safe', async () => {
    for (const version of ['1', 'v1.0.0', '../1.0.0', '1.0.0/x', '1.0.0 ']) {
      const errors = await errorsOf(manifest({ version }))
      expect(errors.some((e) => e.startsWith('/version ')), version).toBe(true)
    }
    expect((await validateManifest(manifest({ version: '1.2.3-beta.1+build.5' }), dir)).ok).toBe(true)
  })

  it('refuses another api major with the reason, not a schema pile-up', async () => {
    expect(await errorsOf(manifest({ api: 2 }))).toEqual(['unsupported plugin api 2 (this app supports api 1)'])
    expect(await errorsOf({ ...manifest({ api: 0 }), id: 'bad id' })).toEqual(['unsupported plugin api 0 (this app supports api 1)'])
  })

  it('refuses a missing or non-integer api', async () => {
    const noApi = manifest()
    delete noApi.api
    expect((await errorsOf(noApi)).join()).toContain('required property')
    expect((await errorsOf(manifest({ api: '1' }))).join()).toContain('/api')
    expect((await errorsOf(manifest({ api: 1.5 }))).join()).toContain('/api')
  })

  it('refuses missing required fields and wrong types', async () => {
    expect((await errorsOf({ id: 'a.b' })).join()).toContain("required property 'name'")
    expect((await errorsOf(manifest({ name: 5 }))).join()).toContain('/name')
    expect((await errorsOf(manifest({ contributes: { panels: [{ id: 'x' }] } }))).join()).toContain("required property 'entry'")
  })

  it('refuses a duplicate id in each contribution list', async () => {
    const c = manifest().contributes as Record<string, unknown[]>
    const panel = c.panels?.[0]
    expect(await errorsOf(manifest({ contributes: { panels: [panel, panel] } }))).toContain('duplicate panel id "board"')
    const cmd = { id: 'refresh', title: 'R' }
    expect(await errorsOf(manifest({ contributes: { commands: [cmd, { ...cmd, title: 'Again' }] } }))).toContain(
      'duplicate command id "refresh"'
    )
    const theme = { id: 'solar', file: 'themes/solar.json' }
    expect(await errorsOf(manifest({ contributes: { themes: [theme, theme] } }))).toContain('duplicate theme id "solar"')
  })

  it('refuses contributes.accounts, naming the APIs that replace it', async () => {
    const account = { kind: 'atlassian', auth: 'token', fields: [{ key: 'token', label: 'Token', secret: true }] }
    const errors = await errorsOf(manifest({ contributes: { ...(manifest().contributes as object), accounts: [account] } }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^contributes\.accounts is no longer supported/)
    for (const api of ['ctx.secrets', '"format": "secret"', 'ctx.oauth']) expect(errors[0]).toContain(api)
    // Whatever its value: the key itself is the problem, not the shape of what it holds.
    expect(await errorsOf(manifest({ contributes: { accounts: [] } }))).toEqual([errors[0]])
  })

  it('reports contributes.accounts next to schema errors, so one round fixes both', async () => {
    const errors = await errorsOf(manifest({ name: 5, contributes: { accounts: 'x' } }))
    expect(errors[0]).toMatch(/^contributes\.accounts is no longer supported/)
    expect(errors.join()).toContain('/name')
  })

  it('refuses a contribution id with the namespace separator', async () => {
    const errors = await errorsOf(manifest({ contributes: { commands: [{ id: 'a/b', title: 'x' }] } }))
    expect(errors.join()).toContain('/contributes/commands/0/id')
  })

  it('refuses an invalid command chord', async () => {
    const errors = await errorsOf(manifest({ contributes: { commands: [{ id: 'x', title: 'X', key: 'j' }] } }))
    expect(errors).toEqual(['command "x": "j" is not a valid key chord'])
  })

  it('refuses a chord whose "modifier" is an Object.prototype member (it normalised to a bare key)', async () => {
    for (const key of ['constructor+p', '__proto__+p', 'toString+p', 'hasOwnProperty+p']) {
      const errors = await errorsOf(manifest({ contributes: { commands: [{ id: 'x', title: 'X', key }] } }))
      expect(errors, key).toEqual([`command "x": "${key}" is not a valid key chord`])
    }
  })

  it('refuses a defaultZone that is not a zone', async () => {
    const panel = { id: 'p', title: 'P', entry: 'panels/board.html', defaultZone: 'top' }
    expect((await errorsOf(manifest({ contributes: { panels: [panel] } }))).join()).toContain('defaultZone')
  })

  it('reports an invalid settings schema with its scope', async () => {
    const errors = await errorsOf(manifest({ contributes: { settings: { project: { type: 'object', properties: { a: { type: 'nope' } } } } } }))
    expect(errors.some((e) => e.startsWith('settings.project: invalid settings schema'))).toBe(true)
  })
})

describe('isReservedPluginId', () => {
  it('reserves the cockpit. prefix in any letter case, padding or compatibility form', () => {
    for (const id of ['cockpit.reviewer', 'cockpit.x.y', 'Cockpit.Foo', 'COCKPIT.FOO', ' cockpit.foo', '\tcockpit.foo', 'coc\u212Apit.foo', '\uFF43ockpit.foo']) {
      expect(isReservedPluginId(id), JSON.stringify(id)).toBe(true)
    }
    for (const id of ['acme.cockpit', 'cockpitx.foo', 'my-cockpit.foo', 'cockpit-tools.foo', 'cockpit', 'acme.cockpit.foo']) {
      expect(isReservedPluginId(id), id).toBe(false)
    }
  })

  it('holds for every id the manifest pattern accepts: a valid id under the prefix is reserved', () => {
    for (const id of ['cockpit.a', 'cockpit.a1-b', 'cockpit.0.a', 'cockpit.browser']) {
      expect(PLUGIN_ID_PATTERN.test(id), id).toBe(true)
      expect(isReservedPluginId(id), id).toBe(true)
    }
  })
})

describe('manifest file references', () => {
  it('refuses a ../ escape in each kind of reference', async () => {
    writeFileSync(join(outside, 'x.js'), '')
    const rel = '../' + outside.split('/').pop() + '/x.js'
    expect(await errorsOf(manifest({ main: rel }))).toEqual([`main "${rel}" must not contain ".." segments`])
    const panel = { id: 'p', title: 'P', entry: '../x.html', icon: 'a/../../i.svg' }
    const errors = await errorsOf(manifest({ main: undefined, contributes: { panels: [panel] } }))
    expect(errors).toEqual([
      'panel "p" entry "../x.html" must not contain ".." segments',
      'panel "p" icon "a/../../i.svg" must not contain ".." segments'
    ])
    const themes = await errorsOf(manifest({ main: undefined, contributes: { themes: [{ id: 't', file: '../t.json' }] } }))
    expect(themes).toEqual(['theme "t" file "../t.json" must not contain ".." segments'])
  })

  it('refuses absolute and non-portable paths', async () => {
    for (const main of ['/etc/passwd', 'C:\\x.js', 'C:/x.js', 'dist\\host.js']) {
      const errors = await errorsOf(manifest({ main }))
      expect(errors.length, main).toBe(1)
      expect(errors[0], main).toContain(`main "${main}"`)
    }
  })

  it('refuses a file that does not exist', async () => {
    expect(await errorsOf(manifest({ main: 'dist/missing.js' }))).toEqual(['main "dist/missing.js": file not found'])
  })

  it('refuses a directory where a file is expected', async () => {
    expect(await errorsOf(manifest({ main: 'dist' }))).toEqual(['main "dist": is not a file'])
  })

  it('refuses a symlink that resolves outside the folder', async () => {
    writeFileSync(join(outside, 'secret.js'), 'x')
    symlinkSync(join(outside, 'secret.js'), join(dir, 'dist', 'link.js'))
    expect(await errorsOf(manifest({ main: 'dist/link.js' }))).toEqual([
      'main "dist/link.js": resolves outside the plugin folder'
    ])
  })

  it('refuses a file reached through a symlinked directory that leaves the folder', async () => {
    writeFileSync(join(outside, 'host.js'), 'x')
    symlinkSync(outside, join(dir, 'ext'))
    expect(await errorsOf(manifest({ main: 'ext/host.js' }))).toEqual(['main "ext/host.js": resolves outside the plugin folder'])
  })

  it('accepts a symlink that stays inside the folder', async () => {
    symlinkSync(join(dir, 'dist', 'host.js'), join(dir, 'dist', 'alias.js'))
    expect((await validateManifest(manifest({ main: 'dist/alias.js' }), dir)).ok).toBe(true)
  })

  it('accepts a folder given through a symlink', async () => {
    const alias = join(outside, 'alias')
    symlinkSync(dir, alias)
    expect((await validateManifest(manifest(), alias)).ok).toBe(true)
  })

  it('reports a missing plugin folder', async () => {
    const r = await validateManifest(manifest({ main: undefined, contributes: undefined }), join(dir, 'nope'))
    expect(r).toEqual({ ok: false, errors: ['plugin folder not found'] })
  })

  it('relativePathProblem covers the syntax rules', () => {
    expect(relativePathProblem('a/b.js')).toBeNull()
    expect(relativePathProblem('./a/b.js')).toBeNull()
    expect(relativePathProblem('')).not.toBeNull()
    expect(relativePathProblem('.')).not.toBeNull()
    expect(relativePathProblem('a\0b')).not.toBeNull()
    expect(relativePathProblem('a/../b')).not.toBeNull()
  })
})

describe('loadManifest', () => {
  it('reads and validates plugin.json', async () => {
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest()))
    const r = await loadManifest(dir)
    expect(r.ok).toBe(true)
  })

  it('reports a missing, unparsable or oversized plugin.json', async () => {
    expect(await loadManifest(dir)).toEqual({ ok: false, errors: ['plugin.json: file not found'] })
    writeFileSync(join(dir, 'plugin.json'), '{nope')
    const bad = await loadManifest(dir)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toContain('not valid JSON')
    writeFileSync(join(dir, 'plugin.json'), ' '.repeat(300 * 1024))
    const big = await loadManifest(dir)
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.errors[0]).toContain('larger than')
  })

  it('refuses a plugin.json that is a symlink out of the folder', async () => {
    writeFileSync(join(outside, 'plugin.json'), JSON.stringify(manifest()))
    symlinkSync(join(outside, 'plugin.json'), join(dir, 'plugin.json'))
    expect(await loadManifest(dir)).toEqual({ ok: false, errors: ['plugin.json: resolves outside the plugin folder'] })
  })

  it('reports a missing folder', async () => {
    expect(await loadManifest(join(dir, 'nope'))).toEqual({ ok: false, errors: ['plugin folder not found'] })
  })
})

describe('contributes.cli', () => {
  const withCli = (cli: unknown, patch: Record<string, unknown> = {}): Record<string, unknown> =>
    manifest({ contributes: { cli }, ...patch })
  const cmd = (name: string): Record<string, unknown> => ({ name, summary: `the ${name} command` })

  it('accepts commands with usage and stdin', async () => {
    const cli = [{ name: 'browser', summary: 'Show a page', usage: 'browser open <url>', stdin: false }, cmd('jira-2')]
    const r = await validateManifest(withCli(cli), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.contributes?.cli).toEqual(cli)
  })

  it.each(['b', 'Browser', '1abc', '-x', 'has space', 'a'.repeat(33), 'dot.ted', 'under_score', ''])(
    'refuses the name %j',
    async (name) => {
      expect((await errorsOf(withCli([cmd(name)]))).join()).toMatch(/cli\/0\/name/)
    }
  )

  it('accepts the longest name (32 characters)', async () => {
    expect((await validateManifest(withCli([cmd('a'.repeat(32))]), dir)).ok).toBe(true)
  })

  it.each(['open', 'hook', 'session', 'overlay', 'sessions', 'notify', 'help', 'guide', 'plugin', 'app', 'config', 'version'])(
    'refuses the reserved name %s',
    async (name) => {
      expect(await errorsOf(withCli([cmd(name)]))).toContain(`cli command "${name}" is reserved for the app`)
    }
  )

  it('refuses more than 10 commands and duplicate names', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => cmd(`cmd-${i}`))
    expect((await errorsOf(withCli(eleven))).join()).toMatch(/cli/)
    expect((await validateManifest(withCli(eleven.slice(0, 10)), dir)).ok).toBe(true)
    expect(await errorsOf(withCli([cmd('same'), cmd('same')]))).toContain('duplicate cli command name "same"')
  })

  it('needs a summary, and a boolean stdin', async () => {
    expect((await errorsOf(withCli([{ name: 'nosummary' }]))).join()).toMatch(/summary/)
    expect((await errorsOf(withCli([{ ...cmd('stdin-x'), stdin: 'yes' }]))).join()).toMatch(/stdin/)
  })

  it('needs main: a command runs in the plugin host', async () => {
    const raw = withCli([cmd('browser')])
    delete raw.main
    expect(await errorsOf(raw)).toContain('contributes.cli needs "main": a plugin\'s commands run in its host')
  })
})

describe('contributes.openFile', () => {
  const withOpenFile = (openFile: unknown): Record<string, unknown> => manifest({ contributes: { openFile } })

  it('accepts a title (an unknown key inside is ignored, as in other contributions)', async () => {
    const r = await validateManifest(withOpenFile({ title: 'Review', later: true }), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.contributes?.openFile).toMatchObject({ title: 'Review' })
  })

  it.each([true, 'Review', [], {}, { title: '' }, { title: 5 }, { title: 'x'.repeat(101) }])('refuses %j', async (openFile) => {
    expect((await errorsOf(withOpenFile(openFile))).join()).toMatch(/openFile/)
  })

  it('needs main: the click is handled in the plugin host', async () => {
    const raw = withOpenFile({ title: 'Review' })
    delete raw.main
    expect(await errorsOf(raw)).toContain(
      'contributes.openFile needs "main": the click is handled by ctx.files.onOpen in the plugin\'s host'
    )
  })
})

describe('contributes.skills', () => {
  const skillMd = (id: string, extra = ''): string => `---\nname: ${id}\ndescription: Does the ${id} thing.\n${extra}---\n\nBody\n`
  beforeEach(() => {
    mkdirSync(join(dir, 'skills/browse'), { recursive: true })
    writeFileSync(join(dir, 'skills/browse/SKILL.md'), skillMd('browse'))
  })
  const withSkills = (skills: unknown): Record<string, unknown> => manifest({ contributes: { skills } })

  it('accepts a skill folder with a valid SKILL.md', async () => {
    const r = await validateManifest(withSkills([{ id: 'browse', dir: 'skills/browse' }]), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.contributes?.skills).toEqual([{ id: 'browse', dir: 'skills/browse' }])
  })

  it('refuses a skill id that is not a lower-case Claude skill name, and more than 10 skills', async () => {
    for (const id of ['Browse', 'a.b', '-x', 'a_b', '']) {
      expect((await errorsOf(withSkills([{ id, dir: 'skills/browse' }]))).join(), id).toMatch(/skills\/0\/id/)
    }
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, dir: 'skills/browse' }))
    expect((await errorsOf(withSkills(eleven))).join()).toMatch(/must NOT have more than 10 items/)
  })

  it('refuses duplicate skill ids', async () => {
    const errors = await errorsOf(withSkills([{ id: 'browse', dir: 'skills/browse' }, { id: 'browse', dir: 'skills/browse' }]))
    expect(errors).toContain('duplicate skill id "browse"')
  })

  it('reports the skill check (extra front matter key, symlink) as a manifest error', async () => {
    writeFileSync(join(dir, 'skills/browse/SKILL.md'), skillMd('browse', 'allowed-tools: Bash(*)\n'))
    const errors = await errorsOf(withSkills([{ id: 'browse', dir: 'skills/browse' }]))
    expect(errors.join()).toMatch(/^skill "browse": SKILL\.md front matter key "allowed-tools" is not allowed/)

    writeFileSync(join(dir, 'skills/browse/SKILL.md'), skillMd('browse'))
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'skills/browse/secret.txt'))
    expect((await errorsOf(withSkills([{ id: 'browse', dir: 'skills/browse' }]))).join()).toMatch(/secret\.txt is a symlink/)
  })

  it('refuses a traversal in the skill dir', async () => {
    const errors = await errorsOf(withSkills([{ id: 'browse', dir: '../x' }]))
    expect(errors.join()).toMatch(/must not contain "\.\." segments/)
  })
})

describe('panel kind (plan B Task 7)', () => {
  const withPanels = (panels: unknown): Record<string, unknown> => manifest({ contributes: { panels } })

  it('keeps old manifests valid: no kind and an entry is an html panel', async () => {
    const r = await validateManifest(withPanels([{ id: 'board', title: 'Board', entry: 'panels/board.html' }]), dir)
    expect(r.ok).toBe(true)
  })

  it('accepts an explicit html panel with an entry and a webview panel without one', async () => {
    const panels = [
      { id: 'board', title: 'Board', kind: 'html', entry: 'panels/board.html' },
      { id: 'view', title: 'Browser', kind: 'webview', defaultZone: 'right' }
    ]
    const r = await validateManifest(withPanels(panels), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.contributes?.panels).toEqual(panels)
  })

  it('refuses a webview panel with an entry, saying why', async () => {
    const errors = await errorsOf(withPanels([{ id: 'view', title: 'Browser', kind: 'webview', entry: 'panels/board.html' }]))
    expect(errors.join('\n')).toMatch(/contributes\/panels\/0 is a "webview" panel: it has no "entry"/)
  })

  it('refuses an html panel without an entry, kind given or not', async () => {
    for (const panel of [
      { id: 'board', title: 'Board' },
      { id: 'board', title: 'Board', kind: 'html' }
    ]) {
      expect((await errorsOf(withPanels([panel]))).join('\n')).toMatch(/panels\/0 must have required property 'entry'/)
    }
  })

  it('refuses an unknown kind', async () => {
    const errors = await errorsOf(withPanels([{ id: 'x', title: 'X', kind: 'iframe', entry: 'panels/board.html' }]))
    expect(errors.join('\n')).toMatch(/panels\/0\/kind/)
  })

  it('validates the host-webview fixture', async () => {
    expect(await loadManifest(join(__dirname, '../fixtures/plugins/host-webview'))).toMatchObject({ ok: true })
  })
})

describe('services', () => {
  const withServices = (services: unknown): Record<string, unknown> => manifest({ services })

  it('accepts a manifest without services and one with provides and uses', async () => {
    expect((await validateManifest(manifest(), dir)).ok).toBe(true)
    const services = { provides: { triage: 1 }, uses: { 'mail-index': 2 } }
    const r = await validateManifest(withServices(services), dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.services).toEqual(services)
    expect((await validateManifest(withServices({}), dir)).ok).toBe(true)
  })

  it('tolerates unknown top-level keys but refuses unknown keys inside services, naming them', async () => {
    expect((await validateManifest(manifest({ future: 1, services: { provides: { triage: 1 } } }), dir)).ok).toBe(true)
    // The plugin host reads only provides and uses; a key beside them is a declaration that does
    // nothing (and once made the host refuse the whole project's plugins).
    expect(await errorsOf(withServices({ provides: { triage: 1 }, description: 'API' }))).toEqual([
      '/services must NOT have additional properties ("description")'
    ])
    expect((await errorsOf(withServices({ provide: { triage: 1 } }))).join()).toContain('("provide")')
  })

  it.each(['Triage', '1abc', 'has space', 'dot.ted', 'a'.repeat(65), ''])('refuses the service name %j', async (name) => {
    expect((await errorsOf(withServices({ provides: { [name]: 1 } }))).join()).toMatch(/services\/provides|propertyNames|pattern/)
    expect((await errorsOf(withServices({ uses: { [name]: 1 } }))).join()).toMatch(/services\/uses|propertyNames|pattern/)
  })

  it('accepts the longest name and the version bounds', async () => {
    expect((await validateManifest(withServices({ provides: { ['a'.repeat(64)]: 1, b: 9999 } }), dir)).ok).toBe(true)
  })

  it.each([0, -1, 10000, 1.5, '1', null, true])('refuses the version %j', async (v) => {
    expect((await errorsOf(withServices({ provides: { triage: v } }))).join()).toMatch(/services\/provides/)
  })

  it('refuses more than 32 entries in provides or uses', async () => {
    const many = (n: number): Record<string, number> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, 1]))
    expect((await validateManifest(withServices({ provides: many(32), uses: many(32) }), dir)).ok).toBe(false)
    expect((await validateManifest(withServices({ provides: many(32) }), dir)).ok).toBe(true)
    expect((await errorsOf(withServices({ provides: many(33) }))).join()).toMatch(/services\/provides/)
    expect((await errorsOf(withServices({ uses: many(33) }))).join()).toMatch(/services\/uses/)
  })

  it('accepts services.collects for used names and refuses the rest', async () => {
    expect((await validateManifest(withServices({ uses: { 'inbox-feed': 1 }, collects: ['inbox-feed'] }), dir)).ok).toBe(true)
    expect(await errorsOf(withServices({ uses: { other: 1 }, collects: ['inbox-feed'] }))).toEqual([
      'service "inbox-feed" is in services.collects but not in services.uses'
    ])
    expect((await errorsOf(withServices({ uses: { a: 1 }, collects: ['A b'] }))).join()).toMatch(/services\/collects/)
    expect((await errorsOf(withServices({ uses: { a: 1 }, collects: ['a', 'a'] }))).join()).toMatch(/services\/collects/)
    expect((await errorsOf(withServices({ uses: { a: 1 }, collects: 'a' }))).join()).toMatch(/services\/collects/)
  })

  it('refuses a name both provided and used', async () => {
    const errs = await errorsOf(withServices({ provides: { triage: 1 }, uses: { triage: 1, other: 1 } }))
    expect(errs).toEqual(['service "triage" is both provided and used; a plugin cannot use a service it provides'])
  })

  it('refuses non-object services, provides and uses', async () => {
    expect((await errorsOf(withServices([]))).join()).toMatch(/services/)
    expect((await errorsOf(withServices({ provides: [] }))).join()).toMatch(/services\/provides/)
    expect((await errorsOf(withServices({ uses: 'x' }))).join()).toMatch(/services\/uses/)
  })
})

describe('slots (design-next §2)', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'slots'))
    writeFileSync(join(dir, 'slots/agenda.html'), '<!doctype html>')
    writeFileSync(join(dir, 'slots/agenda.txt'), 'x')
  })
  const agenda = { type: 'agenda', entry: 'slots/agenda.html', title: "Today's agenda", minHeight: 48, maxHeight: 320 }
  const withSlots = (slots: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    manifest({ contributes: { slots, ...extra } })
  const withPanelSlots = (slots: unknown): Record<string, unknown> =>
    manifest({ contributes: { panels: [{ id: 'main', title: 'Inbox', entry: 'panels/board.html', slots }] } })

  it('accepts a provider and a host panel (an unknown key inside a slot is ignored)', async () => {
    const r = await validateManifest(
      manifest({
        contributes: {
          slots: [{ ...agenda, later: true }, { type: 'sessions-strip', entry: 'slots/agenda.html' }],
          panels: [{ id: 'main', title: 'Inbox', entry: 'panels/board.html', slots: ['agenda', 'weather'] }]
        }
      }),
      dir
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.contributes?.slots?.[0]).toMatchObject(agenda)
      expect(r.manifest.contributes?.panels?.[0]?.slots).toEqual(['agenda', 'weather'])
    }
  })

  it('accepts equal min and max heights and either bound alone', async () => {
    for (const s of [{ minHeight: 100, maxHeight: 100 }, { minHeight: 600 }, { maxHeight: 24 }]) {
      expect((await validateManifest(withSlots([{ type: 'agenda', entry: 'slots/agenda.html', ...s }]), dir)).ok).toBe(true)
    }
  })

  it.each(['Agenda', '1agenda', 'agenda_x', '', 'a'.repeat(65), 5])('refuses the provider type %j', async (type) => {
    expect((await errorsOf(withSlots([{ ...agenda, type }]))).join()).toMatch(/\/contributes\/slots\/0\/type/)
  })

  it.each([{ minHeight: 23 }, { maxHeight: 601 }, { minHeight: 40.5 }, { maxHeight: '100' }])('refuses the height %j', async (h) => {
    expect((await errorsOf(withSlots([{ ...agenda, ...h }]))).join()).toMatch(/\/contributes\/slots\/0\/(min|max)Height/)
  })

  it('refuses a slot without type or entry, and a non-array', async () => {
    expect((await errorsOf(withSlots([{ type: 'agenda' }]))).join()).toMatch(/entry/)
    expect((await errorsOf(withSlots([{ entry: 'slots/agenda.html' }]))).join()).toMatch(/type/)
    expect((await errorsOf(withSlots({ agenda: true }))).join()).toMatch(/\/contributes\/slots/)
  })

  it('refuses more than 10 slots per plugin', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ type: `t${i}`, entry: 'slots/agenda.html' }))
    expect((await errorsOf(withSlots(eleven))).join()).toMatch(/\/contributes\/slots must NOT have more than 10 items/)
    expect((await validateManifest(withSlots(eleven.slice(0, 10)), dir)).ok).toBe(true)
  })

  it('refuses a duplicate type and min above max', async () => {
    const errors = await errorsOf(withSlots([agenda, { type: 'agenda', entry: 'slots/agenda.html', minHeight: 300, maxHeight: 200 }]))
    expect(errors).toContain('duplicate slot type "agenda"')
    expect(errors).toContain('slot "agenda": minHeight 300 is larger than maxHeight 200')
  })

  it('needs an .html entry inside the plugin folder', async () => {
    expect(await errorsOf(withSlots([{ ...agenda, entry: 'slots/agenda.txt' }]))).toContain(
      'slot "agenda" entry "slots/agenda.txt" must be an .html page'
    )
    expect((await errorsOf(withSlots([{ ...agenda, entry: 'slots/gone.html' }]))).join()).toContain('slot "agenda" entry "slots/gone.html": file not found')
    expect((await errorsOf(withSlots([{ ...agenda, entry: '../x.html' }]))).join()).toContain('must not contain ".." segments')
  })

  it('needs main: the page talks to ctx.slots.onOpen in the host', async () => {
    const raw = withSlots([agenda])
    delete raw.main
    expect(await errorsOf(raw)).toContain('contributes.slots needs "main": a slot\'s page talks to ctx.slots.onOpen in the plugin\'s host')
  })

  it.each([['Agenda'], ['a', 'a'], ['a', 'b', 'c', 'd', 'e'], 'agenda', [5]])('refuses the panel slots %j', async (slots) => {
    expect((await errorsOf(withPanelSlots(slots))).join()).toMatch(/\/contributes\/panels\/0\/slots/)
  })

  it('accepts four panel slot types', async () => {
    expect((await validateManifest(withPanelSlots(['a', 'b', 'c', 'd']), dir)).ok).toBe(true)
  })

  it('refuses an app slot type in a panel', async () => {
    expect(await errorsOf(withPanelSlots(['agenda', 'sessions-strip']))).toEqual([
      'panel "main": slot type "sessions-strip" is placed by the app; a panel cannot place it'
    ])
  })
})
