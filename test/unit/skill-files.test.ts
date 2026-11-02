// Plugin skill folders (contributes.skills): the strict SKILL.md front matter and the bounded,
// symlink-refusing read that both the manifest check and the copy into claude-plugins/ use.
import { lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORE_SKILL_ID, CORE_SKILL_TEXT } from '../../src/main/claude-plugins/claude-plugins'
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_DEPTH,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_DIRS,
  MAX_SKILL_ENTRIES,
  MAX_SKILL_FILES,
  pathCollision,
  readSkillFiles,
  skillFrontMatterProblem,
  skillNameProblem
} from '../../src/main/plugins/skill-files'
import { SKILL_ID_PATTERN } from '../../src/shared/manifest'

// lstatSync and openSync wrapped so a test can swap a folder between the walk's lstat of a file
// and its open; everything else is the real module.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, lstatSync: vi.fn(real.lstatSync), openSync: vi.fn(real.openSync) }
})

const GOOD = '---\nname: demo\ndescription: Shows a demo page. Use when asked for the demo.\n---\n\n# Demo\n'

describe('skillFrontMatterProblem', () => {
  it('accepts name and description, in either order, with blank lines and a body', () => {
    expect(skillFrontMatterProblem(GOOD, 'demo')).toBeNull()
    expect(skillFrontMatterProblem('---\ndescription: Does it.\n\nname: demo\n---\n', 'demo')).toBeNull()
    // The closing line may be the file's last, with no newline after it.
    expect(skillFrontMatterProblem('---\nname: demo\ndescription: Does it.\n---', 'demo')).toBeNull()
  })

  it('accepts the core skill (the app holds itself to the same rule)', () => {
    expect(skillFrontMatterProblem(CORE_SKILL_TEXT, CORE_SKILL_ID)).toBeNull()
  })

  it.each(['allowed-tools', 'model', 'hooks', 'disable-model-invocation', 'license', 'Name'])(
    'refuses any other key: %s',
    (key) => {
      const text = `---\nname: demo\ndescription: Does it.\n${key}: Bash\n---\n`
      expect(skillFrontMatterProblem(text, 'demo')).toMatch(new RegExp(`key "${key}" is not allowed`))
    }
  )

  it('refuses YAML shapes a different parser could read differently', () => {
    const fm = (lines: string): string | null => skillFrontMatterProblem(`---\n${lines}\n---\n`, 'demo')
    // A list under a key, an indented continuation, a comment line: not "key: value".
    expect(fm('name: demo\ndescription: Does it.\nallowed-tools:\n  - Bash')).toMatch(/allowed-tools/)
    expect(fm('name: demo\ndescription: Does it\n  and more')).toMatch(/is not "key: value"/)
    expect(fm('# comment\nname: demo\ndescription: Does it.')).toMatch(/is not "key: value"/)
    expect(fm('name: demo\nname: demo\ndescription: Does it.')).toMatch(/appears twice/)
    // Values YAML would not read as the plain string written.
    expect(fm('name: demo\ndescription: "quoted"')).toMatch(/must start with a letter or digit/)
    expect(fm('name: demo\ndescription: >')).toMatch(/must start with a letter or digit/)
    expect(fm('name: demo\ndescription: Use when: always')).toMatch(/": "/)
    expect(fm('name: demo\ndescription: Does it #not really')).toMatch(/" #"/)
    expect(fm('name: demo\ndescription: true')).toMatch(/boolean, null or number/)
    expect(fm('name: demo\ndescription: 12.5')).toMatch(/boolean, null or number/)
    expect(fm('name: demo\ndescription: 2024-01-01')).toMatch(/must not start with a date/)
    expect(fm('name: demo\ndescription: 2024-01-01 10:00 report')).toMatch(/must not start with a date/)
    expect(fm('name: demo\ndescription: Tab\there')).toMatch(/control characters/)
  })

  // Review finding (ext round 10): YAML 1.1 reads NEL and U+2028/U+2029 as line breaks, js-yaml
  // refuses the other C1 controls; only C0 and DEL were refused.
  it.each(['\x85', '\x80', '\x9f'])('refuses a C1 control in a description: %j', (c) => {
    expect(skillFrontMatterProblem(`---\nname: demo\ndescription: Does${c}it\n---\n`, 'demo')).toMatch(/control characters/)
  })

  // The line regex's `.` already stops at U+2028/U+2029 ("not key: value"); the scalar check
  // refuses them too, for a value that does not come through that regex (skillNameProblem).
  it.each([' ', ' '])('refuses a line separator in a value: %j', (c) => {
    expect(skillFrontMatterProblem(`---\nname: demo\ndescription: Does${c}it\n---\n`, 'demo')).not.toBeNull()
    expect(skillNameProblem(`de${c}mo`)).toMatch(/control characters or line separators/)
  })

  // Review finding (ext round 10): String.trim took the NBSP off, YAML keeps it in the name.
  it('trims only spaces and tabs around a value, as YAML does', () => {
    expect(skillFrontMatterProblem('---\nname: demo \ndescription: Does it.\n---\n', 'demo')).toMatch(/must equal the skill id/)
    expect(skillFrontMatterProblem('---\nname:  demo\ndescription: Does it.\n---\n', 'demo')).toMatch(/must equal the skill id/)
    expect(skillFrontMatterProblem('---\nname:  demo \t\ndescription: Does it.  \n---\n', 'demo')).toBeNull()
  })

  // Review finding (ext round 8): a YAML 1.1 reader takes base-60 values as numbers (`12:30` is 750).
  it.each(['12:30', '1:30:00', '1_0:05', '190:20:30.15'])('refuses a sexagesimal description: %s', (d) => {
    expect(skillFrontMatterProblem(`---\nname: demo\ndescription: ${d}\n---\n`, 'demo')).toMatch(/boolean, null or number/)
  })

  it.each(['Run at 12:30 daily', '12:3x', '1.2.3 notes', 'e5 tuning'])('accepts a description that stays a string: %s', (d) => {
    expect(skillFrontMatterProblem(`---\nname: demo\ndescription: ${d}\n---\n`, 'demo')).toBeNull()
  })

  // Review finding: only the description had the YAML scalar check, so `name: true` with skill id
  // "true" passed, though YAML reads it as a boolean and not the string id.
  it.each(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '123', '0x1f', '0o17', '0b101', '1e5', '0777', '2024-01-01'])(
    'refuses a name YAML reads as a non-string, even equal to the id: %s',
    (id) => {
      expect(SKILL_ID_PATTERN.test(id)).toBe(true) // the manifest allows the id itself
      const problem = skillFrontMatterProblem(`---\nname: ${id}\ndescription: Does it.\n---\n`, id)
      expect(problem).toMatch(/boolean, null or number|must not start with a date/)
      expect(problem).toContain(`skill id "${id}"`)
      expect(skillNameProblem(id)).toBe(problem)
    }
  )

  // Review finding (ext round 8): every part before the exponent was optional, so `e5` read as a number.
  it.each(['demo', 'no-op', 'true-up', 'n2', 'yes-or-no', '123abc', 'x1f', 'e5', 'e10', 'e-5'])('accepts a name that stays a string: %s', (id) => {
    expect(skillFrontMatterProblem(`---\nname: ${id}\ndescription: Does it.\n---\n`, id)).toBeNull()
    expect(skillNameProblem(id)).toBeNull()
  })

  it('requires name equal to the id and a one-line description of at most 1024 characters', () => {
    const fm = (lines: string): string | null => skillFrontMatterProblem(`---\n${lines}\n---\n`, 'demo')
    expect(fm('description: Does it.')).toMatch(/no "name"/)
    expect(fm('name: other\ndescription: Does it.')).toMatch(/must equal the skill id "demo"/)
    expect(fm('name: demo')).toMatch(/no "description"/)
    expect(fm('name: demo\ndescription:')).toMatch(/no "description"/)
    expect(fm(`name: demo\ndescription: ${'a'.repeat(MAX_SKILL_DESCRIPTION)}`)).toBeNull()
    expect(fm(`name: demo\ndescription: ${'a'.repeat(MAX_SKILL_DESCRIPTION + 1)}`)).toMatch(/longer than 1024/)
  })

  it('refuses a missing or unclosed front matter, CRLF and a BOM', () => {
    expect(skillFrontMatterProblem('# Demo\n', 'demo')).toMatch(/must start with a "---"/)
    expect(skillFrontMatterProblem('---\nname: demo\ndescription: Does it.\n', 'demo')).toMatch(/not closed/)
    expect(skillFrontMatterProblem(GOOD.replaceAll('\n', '\r\n'), 'demo')).toMatch(/LF line endings/)
    expect(skillFrontMatterProblem('﻿' + GOOD, 'demo')).toMatch(/byte order mark/)
    expect(skillFrontMatterProblem('---\n---\n', 'demo')).toMatch(/no "name"/)
  })
})

describe('readSkillFiles', () => {
  let root: string
  let outside: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-skills-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-skills-out-')))
    mkdirSync(join(root, 'skills/demo/ref'), { recursive: true })
    writeFileSync(join(root, 'skills/demo/SKILL.md'), GOOD)
    writeFileSync(join(root, 'skills/demo/ref/notes.md'), 'notes')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const demo = [{ id: 'demo', dir: 'skills/demo' }]
  const errorOf = (skills = demo): string => {
    const r = readSkillFiles(root, skills)
    if (r.ok) throw new Error('expected a refusal')
    return r.error
  }

  it('reads every file of the skill folder, nested ones too', () => {
    const r = readSkillFiles(root, demo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skills.map((s) => s.id)).toEqual(['demo'])
    const files = Object.fromEntries((r.skills[0]?.files ?? []).map((f) => [f.path, f.data.toString('utf8')]))
    expect(files).toEqual({ 'SKILL.md': GOOD, 'ref/notes.md': 'notes' })
  })

  it('refuses a missing SKILL.md, a missing folder and a file in place of the folder', () => {
    rmSync(join(root, 'skills/demo/SKILL.md'))
    expect(errorOf()).toBe('skill "demo": skills/demo/SKILL.md not found')
    expect(errorOf([{ id: 'x', dir: 'skills/none' }])).toBe('skill "x": dir "skills/none" not found')
    expect(errorOf([{ id: 'x', dir: 'skills/demo/ref/notes.md' }])).toMatch(/is not a folder/)
  })

  it('refuses a SKILL.md whose front matter has an extra key', () => {
    writeFileSync(join(root, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Does it.\nallowed-tools: Bash\n---\n')
    expect(errorOf()).toMatch(/^skill "demo": SKILL\.md front matter key "allowed-tools" is not allowed/)
  })

  // Review finding (ext round 9): only the top SKILL.md was checked, but every file is copied.
  it.each(['SKILL.md', 'skill.md', 'Skill.MD', '\u017Fkill.md', 'S\u212AILL.md'])(
    'refuses a nested %s (its front matter would be copied unchecked)',
    (name) => {
      writeFileSync(join(root, 'skills/demo/ref', name), '---\nname: demo\ndescription: x\nallowed-tools: Bash\n---\n')
      expect(errorOf()).toBe(`skill "demo": ref/${name}: a SKILL.md below the skill folder is not allowed (only the top one is checked)`)
    }
  )

  it('accepts a nested file whose name only resembles SKILL.md', () => {
    writeFileSync(join(root, 'skills/demo/ref', 'SKILL.md.txt'), 'x')
    writeFileSync(join(root, 'skills/demo/ref', 'skills.md'), 'x')
    expect(readSkillFiles(root, demo).ok).toBe(true)
  })

  it('refuses traversal and absolute dirs, and a dot-folder', () => {
    expect(errorOf([{ id: 'x', dir: '../out' }])).toMatch(/must not contain "\.\." segments/)
    expect(errorOf([{ id: 'x', dir: outside }])).toMatch(/must be relative/)
    mkdirSync(join(root, '.hidden'))
    expect(errorOf([{ id: 'x', dir: '.hidden' }])).toMatch(/must not contain dot-folders/)
  })

  it('refuses a skill folder that is or goes through a symlink, even one pointing inside', () => {
    symlinkSync(join(root, 'skills/demo'), join(root, 'linked'))
    expect(errorOf([{ id: 'demo', dir: 'linked' }])).toMatch(/must not be or go through a symlink/)
    symlinkSync(outside, join(root, 'skills/out'))
    expect(errorOf([{ id: 'demo', dir: 'skills/out' }])).toMatch(/symlink/)
  })

  it('refuses a symlinked file or folder inside the skill', () => {
    writeFileSync(join(outside, 'secret'), 'secret')
    symlinkSync(join(outside, 'secret'), join(root, 'skills/demo/ref/leak.md'))
    expect(errorOf()).toBe('skill "demo": ref/leak.md is a symlink (only regular files are copied)')
    rmSync(join(root, 'skills/demo/ref/leak.md'))
    symlinkSync(outside, join(root, 'skills/demo/more'))
    expect(errorOf()).toMatch(/more is a symlink/)
  })

  it('skips dot-files and dot-folders (never copied), even a dot symlink pointing outside', () => {
    writeFileSync(join(root, 'skills/demo/.env'), 'TOKEN=x')
    writeFileSync(join(root, 'skills/demo/ref/.DS_Store'), 'finder')
    mkdirSync(join(root, 'skills/demo/.git'))
    writeFileSync(join(root, 'skills/demo/.git/config'), 'x')
    symlinkSync(outside, join(root, 'skills/demo/.link'))
    const r = readSkillFiles(root, demo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skills[0]?.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'ref/notes.md'])
  })

  // A folder above a file flipped to a symlink to elsewhere for the lstat and the open, and back
  // before the walk's per-folder check: the descriptor's inode matches the lstat (both went to the
  // outside file), so only the recheck that the name still leads to that file catches it.
  it('refuses a file whose folder was a symlink to elsewhere while the file was opened', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs')
    writeFileSync(join(outside, 'notes.md'), 'secret')
    const ref = join(root, 'skills/demo/ref')
    const notes = join(ref, 'notes.md')
    vi.mocked(lstatSync).mockImplementation(((p: string, ...rest: never[]) => {
      if (p === notes) {
        renameSync(ref, join(root, 'ref-away'))
        symlinkSync(outside, ref)
      }
      return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof lstatSync)
    vi.mocked(openSync).mockImplementation(((p: string, ...rest: never[]) => {
      const fd = (real.openSync as (...a: unknown[]) => number)(p, ...rest)
      if (p === notes) {
        rmSync(ref)
        renameSync(join(root, 'ref-away'), ref)
      }
      return fd
    }) as typeof openSync)
    try {
      expect(errorOf()).toBe('skill "demo": ref/notes.md changed while it was read')
    } finally {
      vi.mocked(lstatSync).mockImplementation(real.lstatSync)
      vi.mocked(openSync).mockImplementation(real.openSync)
    }
  })

  it('refuses non-regular files', () => {
    execFileSync('mkfifo', [join(root, 'skills/demo/pipe')])
    expect(errorOf()).toBe('skill "demo": pipe is not a regular file')
  })

  it(`refuses more than ${MAX_SKILL_FILES} files across the plugin's skills`, () => {
    // 1 SKILL.md + 1 note already; fill up to the cap exactly, then one over.
    for (let i = 0; i < MAX_SKILL_FILES - 2; i++) writeFileSync(join(root, `skills/demo/f${i}.md`), 'x')
    expect(readSkillFiles(root, demo).ok).toBe(true)
    mkdirSync(join(root, 'skills/two'))
    writeFileSync(join(root, 'skills/two/SKILL.md'), GOOD.replace('name: demo', 'name: two'))
    expect(errorOf([...demo, { id: 'two', dir: 'skills/two' }])).toBe(`skill "two": more than ${MAX_SKILL_FILES} files`)
  })

  it('refuses more than 1 MiB in total', () => {
    // SKILL.md and notes.md are already there: exactly at the cap passes, one byte over does not.
    const room = MAX_SKILL_BYTES - Buffer.byteLength(GOOD) - 'notes'.length
    writeFileSync(join(root, 'skills/demo/big.md'), Buffer.alloc(room, 'a'))
    expect(readSkillFiles(root, demo).ok).toBe(true)
    writeFileSync(join(root, 'skills/demo/big.md'), Buffer.alloc(room + 1, 'a'))
    expect(errorOf()).toBe(`skill "demo": the skill files are larger than ${MAX_SKILL_BYTES} bytes in total`)
  })

  it('refuses a walk of many empty folders (the file cap does not see them)', () => {
    for (let i = 0; i < MAX_SKILL_DIRS + 10; i++) mkdirSync(join(root, `skills/demo/d${i}`))
    expect(errorOf()).toBe(`skill "demo": more than ${MAX_SKILL_DIRS} folders`)
  })

  it('counts skipped dot entries against a traversal cap', () => {
    for (let i = 0; i < MAX_SKILL_ENTRIES + 10; i++) writeFileSync(join(root, `skills/demo/.junk${i}`), 'x')
    expect(errorOf()).toBe(`skill "demo": more than ${MAX_SKILL_ENTRIES} entries`)
  })

  it(`refuses folders nested deeper than ${MAX_SKILL_DEPTH} below the skill folder`, () => {
    // `ref` is depth 1; a chain down to MAX_SKILL_DEPTH passes, one level more does not.
    const chain = (levels: number): string => ['ref', ...Array.from({ length: levels - 1 }, (_, i) => `n${i + 2}`)].join('/')
    mkdirSync(join(root, 'skills/demo', chain(MAX_SKILL_DEPTH)), { recursive: true })
    expect(readSkillFiles(root, demo).ok).toBe(true)
    mkdirSync(join(root, 'skills/demo', chain(MAX_SKILL_DEPTH + 1)))
    expect(errorOf()).toBe(`skill "demo": ${chain(MAX_SKILL_DEPTH + 1)} is nested deeper than ${MAX_SKILL_DEPTH} folders`)
  })
})

describe('pathCollision', () => {
  const f = (...paths: string[]) => paths.map((path) => ({ path, data: Buffer.alloc(0), executable: false }))

  it('refuses SKILL.md next to skill.md (the second would overwrite the validated first)', () => {
    expect(pathCollision(f('SKILL.md', 'skill.md'))).toMatch(/SKILL\.md and skill\.md differ only in letter case/)
  })

  it('refuses folders and Unicode forms that fold together', () => {
    expect(pathCollision(f('Docs/a.md', 'docs/b.md'))).not.toBeNull()
    expect(pathCollision(f('caf\u00e9.md', 'cafe\u0301.md'))).not.toBeNull()
  })

  it('accepts distinct names, and the same folder used twice', () => {
    expect(pathCollision(f('SKILL.md', 'ref/a.md', 'ref/b.md', 'Ref2/a.md'))).toBeNull()
  })
})
