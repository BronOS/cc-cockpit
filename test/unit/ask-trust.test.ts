// D15: the owner's Ask in a folder Claude Code never trusted runs isolated. Trust is read from a temp HOME's or
// CLAUDE_CONFIG_DIR's .claude.json, never the real one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeConfigPath, folderTrusted, trustedIn } from '../../src/main/ask/ask-trust'

let home: string
let project: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-ask-trust-')))
  project = join(home, 'work', 'proj')
  mkdirSync(project, { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const config = (projects: unknown, dir = home): void => writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects }))

describe('folderTrusted', () => {
  it('trusted: the folder itself, or outside a git repo a parent (not the home folder)', async () => {
    config({ [project]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(true)
    config({ [join(home, 'work')]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(true)
    // Claude Code keeps home trust for one session only: its record never counts, for the home or below it.
    config({ [home]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    expect(await folderTrusted(home, { HOME: home })).toBe(false)
  })

  it("inside a git repo only the folder and the repo's root count, never a folder above the repo (as Claude Code)", async () => {
    const repo = join(home, 'work')
    mkdirSync(join(repo, '.git'))
    config({ [home + '/']: {}, [repo]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(true)
    // Above the repo: not counted, as claude's walk stops at the root.
    const outer = join(home, 'outer')
    mkdirSync(join(outer, 'repo', 'sub', '.git'), { recursive: true })
    config({ [outer]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(join(outer, 'repo', 'sub'), { HOME: home })).toBe(false)
    // A .git file (a worktree) bounds it the same way.
    const wt = join(home, 'wt')
    mkdirSync(join(wt, 'inner'), { recursive: true })
    writeFileSync(join(wt, 'inner', '.git'), 'gitdir: /elsewhere')
    config({ [wt]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(join(wt, 'inner'), { HOME: home })).toBe(false)
    config({ [join(wt, 'inner')]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(join(wt, 'inner'), { HOME: home })).toBe(true)
  })

  it('untrusted, unreadable or a missing key: not trusted', async () => {
    config({ [project]: { hasTrustDialogAccepted: false } })
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    config({ [project]: { hasTrustDialogAccepted: 'true' } })
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    config({ [project]: {} })
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    config({ '/elsewhere': { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    writeFileSync(join(home, '.claude.json'), '{ not json')
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    rmSync(join(home, '.claude.json'))
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
    // A folder where the file should be (unreadable as a file).
    mkdirSync(join(home, '.claude.json'))
    expect(await folderTrusted(project, { HOME: home })).toBe(false)
  })

  it('no HOME or a relative one, a relative folder: not trusted (never the process HOME)', async () => {
    config({ [project]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, {})).toBe(false)
    expect(await folderTrusted(project, { HOME: 'relative' })).toBe(false)
    expect(await folderTrusted('work/proj', { HOME: home })).toBe(false)
    expect(claudeConfigPath({})).toBeUndefined()
  })

  it('CLAUDE_CONFIG_DIR wins over HOME, as for claude', async () => {
    const cfg = join(home, 'cfg')
    mkdirSync(cfg)
    config({ [project]: { hasTrustDialogAccepted: true } })
    config({}, cfg)
    expect(await folderTrusted(project, { HOME: home, CLAUDE_CONFIG_DIR: cfg })).toBe(false)
    config({ [project]: { hasTrustDialogAccepted: true } }, cfg)
    expect(await folderTrusted(project, { HOME: home, CLAUDE_CONFIG_DIR: cfg })).toBe(true)
  })

  it('a folder reached through a link counts by its real path', async () => {
    const link = join(home, 'link')
    symlinkSync(project, link)
    config({ [project]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(link, { HOME: home })).toBe(true)
  })

  it('projects keys are data: __proto__ and inherited names never count', () => {
    expect(trustedIn(JSON.parse('{"projects":{"__proto__":{"hasTrustDialogAccepted":true}}}'), '/a', null)).toBe(false)
    expect(trustedIn({ projects: [] }, '/a', null)).toBe(false)
    expect(trustedIn(null, '/a', null)).toBe(false)
  })
})
