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
  it('trusted: the folder or a parent has an accepted trust dialog', async () => {
    config({ [project]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(true)
    config({ [join(home, 'work')]: { hasTrustDialogAccepted: true } })
    expect(await folderTrusted(project, { HOME: home })).toBe(true)
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
    expect(trustedIn(JSON.parse('{"projects":{"__proto__":{"hasTrustDialogAccepted":true}}}'), '/a')).toBe(false)
    expect(trustedIn({ projects: [] }, '/a')).toBe(false)
    expect(trustedIn(null, '/a')).toBe(false)
  })
})
