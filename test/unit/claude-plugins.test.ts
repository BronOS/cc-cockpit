// The generated `<data>/claude-plugins/` tree, in a temp dir (never the real data dir).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUIDE_TOPICS } from '../../src/cli/guide'
import {
  CORE_PLUGIN_NAME,
  CORE_SKILL_ID,
  CORE_SKILL_TEXT,
  ClaudePlugins,
  ClaudePluginsBuilds,
  claudePluginNames,
  pluginJson,
  type SkillSource
} from '../../src/main/claude-plugins/claude-plugins'
import { readSkillFiles } from '../../src/main/plugins/skill-files'
import { loadManifest } from '../../src/main/plugins/validate'

// Pass-through by default; the destination-collision tests make it return names that a
// case-insensitive test disk cannot hold side by side in a source folder.
vi.mock('../../src/main/plugins/skill-files', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/plugins/skill-files')>()
  return { ...real, readSkillFiles: vi.fn(real.readSkillFiles) }
})

let root: string
let dir: string
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccc-claude-plugins-'))
  dir = join(root, 'claude-plugins')
  logs = []
})

afterEach(() => {
  try {
    chmodSync(root, 0o700)
  } catch {
    // already gone
  }
  rmSync(root, { recursive: true, force: true })
})

function service(version = '1.2.3'): ClaudePlugins {
  return new ClaudePlugins({ dir, version, log: (m) => logs.push(m) })
}

/** Every file under `base`, relative, sorted (dot entries included). */
function tree(base: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(base, rel))) {
      const path = rel ? join(rel, name) : name
      if (statSync(join(base, path)).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk('')
  return out.sort()
}

/** The front matter keys and values of a SKILL.md (the strict two-key shape the plan requires). */
function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error('no front matter')
  const out: Record<string, string> = {}
  for (const line of (m[1] as string).split('\n')) {
    const kv = /^([a-z-]+): (.+)$/.exec(line)
    if (!kv) throw new Error(`bad front matter line: ${line}`)
    out[kv[1] as string] = kv[2] as string
  }
  return out
}

describe('build', () => {
  it('writes core as a Claude Code plugin with the cc-cockpit skill', () => {
    service('1.2.3').build()
    expect(tree(dir)).toEqual(['core/.claude-plugin/plugin.json', 'core/skills/cc-cockpit/SKILL.md'])
    expect(JSON.parse(readFileSync(join(dir, 'core/.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'cc-cockpit',
      version: '1.2.3'
    })
    expect(readFileSync(join(dir, 'core/skills/cc-cockpit/SKILL.md'), 'utf8')).toBe(CORE_SKILL_TEXT)
    expect(logs).toEqual([])
  })

  it('keeps the tree private to the user', () => {
    service().build()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'core/skills/cc-cockpit/SKILL.md')).mode & 0o777).toBe(0o600)
  })

  it('a rebuild replaces stale files and children and sweeps a crashed build', () => {
    service('1.0.0').build()
    // An old skill file inside core, a child whose source went away, and the temp / old folders
    // of a build that died between its renames.
    mkdirSync(join(dir, 'core/skills/old'), { recursive: true })
    writeFileSync(join(dir, 'core/skills/old/SKILL.md'), 'stale')
    writeFileSync(join(dir, 'core/skills/cc-cockpit/SKILL.md'), 'edited by hand')
    mkdirSync(join(dir, 'gone.plugin/skills'), { recursive: true })
    mkdirSync(join(dir, '.core.999.tmp/skills'), { recursive: true })
    mkdirSync(join(dir, '.core.999.old'), { recursive: true })
    writeFileSync(join(dir, 'stray-file'), 'x')

    service('2.0.0').build()
    expect(readdirSync(dir)).toEqual(['core'])
    expect(tree(dir)).toEqual(['core/.claude-plugin/plugin.json', 'core/skills/cc-cockpit/SKILL.md'])
    expect(readFileSync(join(dir, 'core/skills/cc-cockpit/SKILL.md'), 'utf8')).toBe(CORE_SKILL_TEXT)
    expect(JSON.parse(readFileSync(join(dir, 'core/.claude-plugin/plugin.json'), 'utf8')).version).toBe('2.0.0')
  })

  it('resolves ready after the first build, also when it failed', async () => {
    const s = service()
    let ready = false
    void s.ready.then(() => (ready = true))
    await Promise.resolve()
    expect(ready).toBe(false)
    s.build()
    await s.ready
    expect(ready).toBe(true)
  })

  it('never throws; a failed build logs and leaves core out of the dirs', async () => {
    // A file where the tree's folder should be: mkdir fails.
    writeFileSync(dir, 'not a folder')
    const s = service()
    expect(() => s.build()).not.toThrow()
    await s.ready
    expect(s.pluginDirsFor('p')).toEqual([])
    expect(logs.join('\n')).toMatch(/claude-plugins: cannot/)
  })

  it('a later failed build drops core from the dirs instead of naming a half-written folder', () => {
    // An injected writer that fails after the first file (plugin.json written, SKILL.md not):
    // independent of chmod, which does not stop root (CI containers).
    let failing = false
    const s = new ClaudePlugins({
      dir,
      version: '1.2.3',
      log: (m) => logs.push(m),
      writeFile: (path, data) => {
        if (failing && path.endsWith('SKILL.md')) throw new Error('EIO: disk gone')
        writeFileSync(path, data)
      }
    })
    s.build()
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
    failing = true
    s.build()
    expect(s.pluginDirsFor('p')).toEqual([])
    expect(logs.join('\n')).toMatch(/cannot write core: EIO: disk gone/)
    // The previous complete core is still there (the swap never started), and the half-written
    // temp folder is gone.
    expect(existsSync(join(dir, 'core/skills/cc-cockpit/SKILL.md'))).toBe(true)
    expect(readdirSync(dir)).toEqual(['core'])
  })
})

describe('a failed publish (review finding, round 7)', () => {
  let dir: string
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'ccc-pub-')), 'claude-plugins')
  })
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }))

  it('restores the moved-aside tree when the publish rename fails', () => {
    let failing = false
    const logs: string[] = []
    const s = new ClaudePlugins({
      dir,
      version: '1',
      log: (m) => logs.push(m),
      rename: (from, to) => {
        if (failing && from.endsWith('.tmp')) throw new Error('EIO: publish')
        renameSync(from, to)
      }
    })
    s.build()
    failing = true
    s.build()
    expect(existsSync(join(dir, 'core/skills/cc-cockpit/SKILL.md'))).toBe(true)
    expect(readdirSync(dir)).toEqual(['core'])
    expect(logs.join('\n')).toMatch(/cannot write core: EIO: publish/)
  })

  it('the stale sweep restores a backup that is the only copy instead of deleting it', () => {
    let failing = false
    const s = new ClaudePlugins({
      dir,
      version: '1',
      log: () => {},
      // The publish and the rollback both fail (the disk is gone for renames).
      rename: (from, to) => {
        if (failing && (from.endsWith('.tmp') || from.endsWith('.old'))) throw new Error('EIO')
        renameSync(from, to)
      }
    })
    s.build()
    failing = true
    s.build()
    expect(existsSync(join(dir, 'core/skills/cc-cockpit/SKILL.md'))).toBe(true)
    expect(readdirSync(dir)).toEqual(['core'])
  })
})

describe('pluginDirsFor', () => {
  it('is empty before the first build', () => {
    expect(service().pluginDirsFor('p')).toEqual([])
  })

  it('is the core folder after a build, for any project', () => {
    const s = service()
    s.build()
    expect(s.pluginDirsFor('aaaa')).toEqual([join(dir, 'core')])
    expect(s.pluginDirsFor('bbbb')).toEqual([join(dir, 'core')])
  })
})

describe('the core skill', () => {
  it('has exactly a name equal to its id and a one-line description', () => {
    const fm = frontMatter(CORE_SKILL_TEXT)
    expect(Object.keys(fm).sort()).toEqual(['description', 'name'])
    expect(fm.name).toBe(CORE_SKILL_ID)
    expect(CORE_PLUGIN_NAME).toBe('cc-cockpit')
    expect((fm.description as string).length).toBeLessThanOrEqual(1024)
  })

  it('says it runs inside cc-cockpit and to use ccc guide', () => {
    const fm = frontMatter(CORE_SKILL_TEXT)
    expect(fm.description).toMatch(/inside cc-cockpit/)
    expect(fm.description).toContain('`ccc guide`')
  })

  it('maps every guide topic (drift guard: a new topic must be added to the skill)', () => {
    for (const topic of GUIDE_TOPICS) {
      const run = topic.name === 'overview' ? '`ccc guide`' : `\`ccc guide ${topic.name}\``
      expect(CORE_SKILL_TEXT, topic.name).toContain(run)
    }
  })
})

describe('pluginJson', () => {
  it('is the name and version as JSON', () => {
    expect(JSON.parse(pluginJson('x', '0.1.0'))).toEqual({ name: 'x', version: '0.1.0' })
  })
})

describe('plugin skills', () => {
  const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'with-skill')
  let sources: SkillSource[]
  let enabled: Record<string, string[]>

  /** A skill-bearing plugin folder in the temp root: `skills/<skill>/SKILL.md` plus a note. */
  function pluginFolder(id: string, skill = 'demo'): SkillSource {
    const base = join(root, 'src', id)
    mkdirSync(join(base, 'skills', skill, 'ref'), { recursive: true })
    writeFileSync(join(base, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Skill of ${id}.\n---\n\nBody of ${id}\n`)
    writeFileSync(join(base, 'skills', skill, 'ref', 'notes.md'), `notes of ${id}`)
    return { id, version: '0.2.0', dir: base, skills: [{ id: skill, dir: `skills/${skill}` }] }
  }

  function skillService(): ClaudePlugins {
    return new ClaudePlugins({
      dir,
      version: '1.2.3',
      skillPlugins: () => sources,
      enabledPlugins: (projectId) => enabled[projectId] ?? [],
      log: (m) => logs.push(m)
    })
  }

  beforeEach(() => {
    sources = []
    enabled = {}
  })

  it('copies the fixture plugin as a Claude plugin named ccc-<id with dashes>', async () => {
    const loaded = await loadManifest(FIXTURE)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    sources = [{ id: loaded.manifest.id, version: loaded.manifest.version, dir: FIXTURE, skills: loaded.manifest.contributes?.skills ?? [] }]
    skillService().build()
    expect(tree(join(dir, 'test.with-skill'))).toEqual([
      '.claude-plugin/plugin.json',
      'skills/demo/SKILL.md',
      'skills/demo/reference.md'
    ])
    expect(JSON.parse(readFileSync(join(dir, 'test.with-skill/.claude-plugin/plugin.json'), 'utf8'))).toEqual({
      name: 'ccc-test-with-skill',
      version: '1.0.0'
    })
    expect(readFileSync(join(dir, 'test.with-skill/skills/demo/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(FIXTURE, 'skills/demo/SKILL.md'), 'utf8')
    )
    expect(statSync(join(dir, 'test.with-skill/skills/demo/reference.md')).mode & 0o777).toBe(0o600)
    expect(logs).toEqual([])
  })

  it('passes core first, then the skill plugins the project enables, by id', () => {
    sources = [pluginFolder('b.two'), pluginFolder('a.one'), pluginFolder('c.three')]
    // Enabled out of order, one twice, one without skills (not built) and one that is no child.
    enabled = { p: ['c.three', 'a.one', 'c.three', 'x.noskills', '../escape', 'core'], q: ['b.two'] }
    const s = skillService()
    s.build()
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'a.one'), join(dir, 'c.three')])
    expect(s.pluginDirsFor('q')).toEqual([join(dir, 'core'), join(dir, 'b.two')])
    // A project with none of them enabled gets core only.
    expect(s.pluginDirsFor('r')).toEqual([join(dir, 'core')])
  })

  it('a plugin disabled in the project is not passed (read at each spawn)', () => {
    sources = [pluginFolder('a.one')]
    enabled = { p: ['a.one'] }
    const s = skillService()
    s.build()
    expect(s.pluginDirsFor('p')).toContain(join(dir, 'a.one'))
    enabled = { p: [] }
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
  })

  it('a rebuild without the plugin (uninstalled, unlinked, invalid) removes its folder', () => {
    sources = [pluginFolder('a.one'), pluginFolder('b.two')]
    enabled = { p: ['a.one', 'b.two'] }
    const s = skillService()
    s.build()
    expect(readdirSync(dir).sort()).toEqual(['a.one', 'b.two', 'core'])
    sources = sources.filter((p) => p.id !== 'a.one')
    s.build()
    expect(readdirSync(dir).sort()).toEqual(['b.two', 'core'])
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'b.two')])
  })

  // Review finding (ext round 8): every file was written 0600, so a skill's helper script lost its
  // exec bit and `./scripts/run.sh` failed with EACCES inside Claude.
  it('keeps the owner exec bit of a skill file (0700), every other file 0600', () => {
    const src = pluginFolder('a.one')
    mkdirSync(join(src.dir, 'skills/demo/scripts'))
    writeFileSync(join(src.dir, 'skills/demo/scripts/run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(src.dir, 'skills/demo/scripts/run.sh'), 0o755)
    // Group and others' exec bits alone are not the owner's: not kept.
    writeFileSync(join(src.dir, 'skills/demo/scripts/other.sh'), '#!/bin/sh\n')
    chmodSync(join(src.dir, 'skills/demo/scripts/other.sh'), 0o611)
    sources = [src]
    skillService().build()
    expect(statSync(join(dir, 'a.one/skills/demo/scripts/run.sh')).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'a.one/skills/demo/scripts/other.sh')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'a.one/skills/demo/SKILL.md')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'a.one/skills/demo/ref/notes.md')).mode & 0o777).toBe(0o600)
  })

  it('copies again from the folder at each build (a dev edit reaches new tabs)', () => {
    const src = pluginFolder('a.one')
    sources = [src]
    const s = skillService()
    s.build()
    writeFileSync(join(src.dir, 'skills/demo/ref/notes.md'), 'edited')
    rmSync(join(dir, 'a.one/skills/demo/SKILL.md')) // and a hand-damaged copy is replaced
    s.build()
    expect(readFileSync(join(dir, 'a.one/skills/demo/ref/notes.md'), 'utf8')).toBe('edited')
    expect(existsSync(join(dir, 'a.one/skills/demo/SKILL.md'))).toBe(true)
  })

  it('re-checks at copy time: a symlink swapped in after validation drops the plugin, logged', () => {
    const src = pluginFolder('a.one')
    sources = [src]
    enabled = { p: ['a.one'] }
    const s = skillService()
    s.build()
    // Validated (as at install), then the file becomes a link to something outside.
    writeFileSync(join(root, 'secret'), 'SECRET')
    rmSync(join(src.dir, 'skills/demo/ref/notes.md'))
    symlinkSync(join(root, 'secret'), join(src.dir, 'skills/demo/ref/notes.md'))
    s.build()
    expect(existsSync(join(dir, 'a.one'))).toBe(false)
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
    expect(logs.join('\n')).toMatch(/skills of a\.one skipped: skill "demo": ref\/notes\.md is a symlink/)
  })

  it('re-checks at copy time: a skill folder swapped for a symlink, and a new extra front matter key', () => {
    const src = pluginFolder('a.one')
    const other = pluginFolder('b.two')
    sources = [src, other]
    const s = skillService()
    s.build()
    rmSync(join(src.dir, 'skills/demo'), { recursive: true })
    symlinkSync(join(other.dir, 'skills/demo'), join(src.dir, 'skills/demo'))
    // A key that would widen what Claude may do.
    writeFileSync(join(other.dir, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Hi.\nallowed-tools: Bash\n---\n')
    s.build()
    expect(readdirSync(dir)).toEqual(['core'])
    expect(logs.join('\n')).toMatch(/skills of a\.one skipped: skill "demo": dir "skills\/demo" must not be or go through a symlink/)
    expect(logs.join('\n')).toMatch(/skills of b\.two skipped: .*"allowed-tools" is not allowed/)
  })

  it('refuses a traversal in a skill dir at copy time', () => {
    const src = pluginFolder('a.one')
    pluginFolder('b.two')
    sources = [{ ...src, skills: [{ id: 'demo', dir: '../b.two/skills/demo' }] }]
    skillService().build()
    expect(readdirSync(dir)).toEqual(['core'])
    expect(logs.join('\n')).toMatch(/must not contain "\.\." segments/)
  })

  it('a plugin whose folder is gone is skipped; core and the others still build', () => {
    sources = [{ id: 'a.gone', version: '1.0.0', dir: join(root, 'nope'), skills: [{ id: 'demo', dir: 'skills/demo' }] }, pluginFolder('b.two')]
    enabled = { p: ['a.gone', 'b.two'] }
    const s = skillService()
    s.build()
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'b.two')])
    expect(logs.join('\n')).toMatch(/skills of a\.gone skipped/)
  })

  it('a plugin revoked since the last build is not passed to a new tab, with no rebuild (review finding)', () => {
    // A pending clone holds the queued applyRevocations, and with it the rebuild, for minutes: the
    // installer's listing already leaves the plugin out while its child is still on disk.
    const one = pluginFolder('a.one', 'demo')
    const two = pluginFolder('b.two', 'demo')
    sources = [one, two]
    enabled = { p: ['a.one', 'b.two'] }
    const s = skillService()
    s.build()
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'a.one'), join(dir, 'b.two')])
    sources = [two]
    expect(existsSync(join(dir, 'a.one'))).toBe(true)
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'b.two')])
    // Withdrawn again before any rebuild: the child is still whole, so the next tab has it back.
    sources = [one, two]
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'a.one'), join(dir, 'b.two')])
  })

  it('a child built from another version or commit is not handed out until the rebuild', () => {
    // An update records safe v2 before the tree is rebuilt; the child on disk is still revoked v1's.
    const v1: SkillSource = { ...pluginFolder('a.one', 'demo'), version: '1.0.0', commit: 'a'.repeat(40) }
    sources = [v1]
    enabled = { p: ['a.one'] }
    const s = skillService()
    s.build()
    const withChild = [join(dir, 'core'), join(dir, 'a.one')]
    expect(s.pluginDirsFor('p')).toEqual(withChild)
    sources = [{ ...v1, version: '2.0.0', commit: 'b'.repeat(40) }]
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
    s.build()
    expect(s.pluginDirsFor('p')).toEqual(withChild)
    // Same version from another commit (an uninstall and a reinstall whose rebuild failed).
    sources = [{ ...v1, version: '2.0.0', commit: 'c'.repeat(40) }]
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
  })

  it('a listing that throws at spawn passes core only, without failing the spawn', () => {
    let failing = false
    sources = [pluginFolder('a.one', 'demo')]
    enabled = { p: ['a.one'] }
    const s = new ClaudePlugins({
      dir,
      version: '1.2.3',
      skillPlugins: () => {
        if (failing) throw new Error('boom')
        return sources
      },
      enabledPlugins: (projectId) => enabled[projectId] ?? [],
      log: (m) => logs.push(m)
    })
    s.build()
    failing = true
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
    expect(logs.join('\n')).toMatch(/cannot list plugin skills: boom/)
  })

  it('a throwing plugin listing still writes core', () => {
    const s = new ClaudePlugins({
      dir,
      version: '1.2.3',
      skillPlugins: () => {
        throw new Error('boom')
      },
      log: (m) => logs.push(m)
    })
    s.build()
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
    expect(logs.join('\n')).toMatch(/cannot list plugin skills: boom/)
  })

  describe('a destination name collision at copy time (review finding: the fold check is not complete)', () => {
    const GOOD = '---\nname: demo\ndescription: Checked.\n---\n'
    const EVIL = '---\nname: demo\ndescription: Unchecked.\nallowed-tools: Bash\n---\n'

    /** The temp disk treats `a` and `b` as one name (run at collection, before any beforeEach). */
    function sameNameOnDisk(a: string, b: string): boolean {
      const probe = mkdtempSync(join(tmpdir(), 'ccc-fold-probe-'))
      try {
        writeFileSync(join(probe, a), 'x')
        return existsSync(join(probe, b))
      } finally {
        rmSync(probe, { recursive: true, force: true })
      }
    }

    /** a.one's skill read as these files, as from a case-sensitive linked folder (pathCollision bypassed). */
    function readAs(...files: [string, string][]): void {
      vi.mocked(readSkillFiles).mockImplementationOnce(() => ({
        ok: true,
        skills: [{ id: 'demo', files: files.map(([path, text]) => ({ path, data: Buffer.from(text), executable: false })) }]
      }))
    }

    function expectRefused(s: ClaudePlugins, collided: string): void {
      expect(readdirSync(dir).sort()).toEqual(['b.two', 'core'])
      expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core'), join(dir, 'b.two')])
      expect(logs.join('\n')).toContain(`skills of a.one skipped: ${join('skills', 'demo', collided)} is the same name as another of its files`)
      // No published file carries the unchecked front matter.
      for (const child of readdirSync(dir)) {
        for (const f of tree(join(dir, child))) expect(readFileSync(join(dir, child, f), 'utf8')).not.toContain('allowed-tools')
      }
    }

    it('one name twice (any disk): refused, the old child removed, the others built', () => {
      sources = [pluginFolder('a.one'), pluginFolder('b.two')]
      enabled = { p: ['a.one', 'b.two'] }
      const s = skillService()
      s.build()
      expect(readdirSync(dir).sort()).toEqual(['a.one', 'b.two', 'core'])
      readAs(['SKILL.md', GOOD], ['SKILL.md', EVIL])
      s.build()
      expectRefused(s, 'SKILL.md')
    })

    for (const evil of ['skill.md', '\u017fkill.md']) {
      it.runIf(sameNameOnDisk('SKILL.md', evil))(`SKILL.md and ${JSON.stringify(evil)} on a disk that folds them: refused`, () => {
        sources = [pluginFolder('a.one'), pluginFolder('b.two')]
        enabled = { p: ['a.one', 'b.two'] }
        const s = skillService()
        readAs(['SKILL.md', GOOD], [evil, EVIL])
        s.build()
        expectRefused(s, evil)
      })
    }

    it('a file and a folder on one name: refused', () => {
      sources = [pluginFolder('a.one'), pluginFolder('b.two')]
      enabled = { p: ['a.one', 'b.two'] }
      const s = skillService()
      readAs(['SKILL.md', GOOD], ['ref', 'x'], ['ref/a.md', 'y'])
      s.build()
      expectRefused(s, join('ref', 'a.md'))
    })
  })

  it('two ids mapping to the same Claude plugin name stay distinct (both get a hash)', () => {
    sources = [pluginFolder('a.b-c'), pluginFolder('a-b.c')]
    skillService().build()
    const nameOf = (id: string): string => JSON.parse(readFileSync(join(dir, id, '.claude-plugin/plugin.json'), 'utf8')).name
    // Both hashed, so neither name depends on which one sorts first.
    expect(nameOf('a-b.c')).toMatch(/^ccc-a-b-c-[0-9a-f]{8}$/)
    expect(nameOf('a.b-c')).toMatch(/^ccc-a-b-c-[0-9a-f]{8}$/)
    // Stable whatever order the plugins are listed in.
    const hashed = nameOf('a.b-c')
    const hashedOther = nameOf('a-b.c')
    sources.reverse()
    skillService().build()
    expect(nameOf('a-b.c')).toBe(hashedOther)
    expect(nameOf('a.b-c')).toBe(hashed)
  })
})

describe('claudePluginNames uniqueness (review finding, round 7)', () => {
  it('keeps counting past the longest hash when every candidate is another id\'s plain name', () => {
    const base = 'a-b-c'
    const ids = ['a-b.c', 'a.b-c']
    // Squat on every candidate of 'a.b-c' with ids whose plain names are those candidates.
    const h = createHash('sha256').update('a.b-c').digest('hex')
    // Ids sorted before the pair, so their plain names are taken when 'a.b-c' picks its hash.
    const squatters = [8, 16, 64].map((n) => `${base}-${h.slice(0, n)}`)
    const all = claudePluginNames([...ids, ...squatters].sort())
    expect(all.size).toBe(5)
    expect(new Set(all.values()).size).toBe(5)
    expect(claudePluginNames([...ids, ...squatters].sort())).toEqual(all)
  })
})

describe('claudePluginNames', () => {
  it("maps dots to dashes and hashes longer when a hashed name is taken too", () => {
    expect(claudePluginNames(['bronos.jira']).get('bronos.jira')).toBe('ccc-bronos-jira')
    const first = claudePluginNames(['a-b.c', 'a.b-c']).get('a.b-c') as string
    // An id whose plain name is exactly that hashed name, listed before it.
    const tricky = first.slice('ccc-'.length).replace(/^a-b-c-/, 'a.b-c-')
    const all = claudePluginNames(['a-b.c', tricky, 'a.b-c'])
    expect(all.get(tricky)).toBe(first)
    expect(all.get('a.b-c')).toMatch(/^ccc-a-b-c-[0-9a-f]{16}$/)
    expect(new Set(all.values()).size).toBe(3)
    // Both clashing ids carry a hash; neither keeps the plain name.
    const both = claudePluginNames(['a-b.c', 'a.b-c'])
    expect(both.get('a-b.c')).toMatch(/^ccc-a-b-c-[0-9a-f]{8}$/)
    expect(both.get('a.b-c')).toMatch(/^ccc-a-b-c-[0-9a-f]{8}$/)
  })
})

describe('ClaudePluginsBuilds (when main rebuilds the tree)', () => {
  it('builds nothing before start: an installer change during load() does not resolve ready', async () => {
    const s = service()
    const builds = new ClaudePluginsBuilds(() => s.build(), () => ['a.dev'])
    let ready = false
    void s.ready.then(() => (ready = true))
    builds.changed()
    await builds.revalidated('a.dev', async () => 'ok')
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(existsSync(dir)).toBe(false)
    builds.start()
    await s.ready
    expect(s.pluginDirsFor('p')).toEqual([join(dir, 'core')])
  })

  it('after start, every installer change rebuilds', () => {
    let count = 0
    const builds = new ClaudePluginsBuilds(() => count++, () => [])
    builds.start()
    builds.changed()
    builds.changed()
    expect(count).toBe(3)
  })

  it('a dev revalidate rebuilds only when the plugin is in the tree or has skills now', async () => {
    let count = 0
    let skills: string[] = ['other.skills']
    const of = (): string[] => skills
    const builds = new ClaudePluginsBuilds(() => count++, of)
    builds.start()
    count = 0
    expect(await builds.revalidated('a.dev', async () => 'state')).toBe('state')
    expect(count).toBe(0) // no skills in the tree or now, nobody else changed: a file save costs no rebuild
    expect(await builds.revalidated('a.dev', async () => ((skills = [...skills, 'a.dev']), 'gained'))).toBe('gained')
    expect(count).toBe(1)
    await builds.revalidated('a.dev', async () => 'kept')
    expect(count).toBe(2) // has skills: its files may have changed
    await builds.revalidated('a.dev', async () => ((skills = ['other.skills']), 'lost'))
    expect(count).toBe(3)
    // A failed revalidate propagates and builds nothing.
    skills = ['a.dev']
    await expect(builds.revalidated('a.dev', async () => Promise.reject(new Error('bad manifest')))).rejects.toThrow('bad manifest')
    expect(count).toBe(3)
  })

  // Review finding: the edited plugin has no skills, but its edit took a command name from another
  // plugin (demoted: its skills must leave new tabs) or gave one back (recovered: they come back).
  it('a dev revalidate rebuilds when another plugin with skills was demoted or recovered by it', async () => {
    let count = 0
    let skills = ['b.skills']
    const of = (): string[] => skills
    const builds = new ClaudePluginsBuilds(() => count++, of)
    builds.start()
    count = 0
    await builds.revalidated('a.noskills', async () => (skills = []))
    expect(count).toBe(1)
    await builds.revalidated('a.noskills', async () => (skills = ['b.skills']))
    expect(count).toBe(2)
  })

  // Review finding (round 2): two dev reloads overlap, both started before either ran (the
  // installer queues them). The first demotes b.skills (its child goes), the second recovers it.
  // Comparing a snapshot taken when each reload was asked for, the second saw b.skills before and
  // after and skipped the rebuild, so the recovered plugin's skills stayed out of new tabs.
  // Neither edited plugin has skills.
  it('two overlapping dev reloads leave the tree built from the final state', async () => {
    let count = 0
    let skills = ['b.skills']
    const of = (): string[] => skills
    const builds = new ClaudePluginsBuilds(() => count++, of)
    builds.start()
    count = 0
    const gate = (): { wait: Promise<void>; open: () => void } => {
      let open!: () => void
      const wait = new Promise<void>((r) => (open = r))
      return { wait, open }
    }
    const a = gate()
    const c = gate()
    const ra = builds.revalidated('a.noskills', async () => {
      await a.wait
      skills = [] // a's edit takes b's command name: b.skills demoted
    })
    const rc = builds.revalidated('c.noskills', async () => {
      await c.wait
      skills = ['b.skills'] // c's edit gives a name back: b.skills recovered
    })
    a.open()
    await ra
    expect(count).toBe(1) // the tree lost b.skills
    c.open()
    await rc
    expect(count).toBe(2) // and has it again
  })

  it('a dev revalidate rebuilds when the skill listing throws (the tree state is not known)', async () => {
    let count = 0
    const builds = new ClaudePluginsBuilds(
      () => count++,
      () => {
        throw new Error('index unreadable')
      }
    )
    builds.start()
    await builds.revalidated('a.noskills', async () => 'ok')
    expect(count).toBe(2)
  })
})
