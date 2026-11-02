// Plugin install/link/update/uninstall against a real local bare repo (built once from
// test/fixtures/plugins, one tag per variant) cloned over file://. git runs with the user's
// global and system config switched off so a developer's gpg signing, hooksPath or insteadOf
// rules cannot change the outcome; nothing touches the real data dir.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeFs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneArgs, gitEnv, gitTagProblem, gitUrlProblem } from '../../src/shared/git-source'
import { ProjectRegistry } from '../../src/main/projects/registry'
import { pluginAppDataDir } from '../../src/main/paths'
import {
  defaultGitRunner,
  GIT_STDOUT_CAP,
  PluginInstaller,
  type GitRunner,
  type InstallerOptions,
  type InstallPin
} from '../../src/main/plugins/installer'
import type { FsOps } from '../../src/main/store/json-file'
import { PluginIndex, type PluginEntry } from '../../src/main/plugins/plugin-index'
import { PluginSecrets } from '../../src/main/secrets/plugin-secrets'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { ThemeService } from '../../src/main/themes/theme-service'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      '-c', 'init.defaultBranch=main',
      ...args
    ],
    { cwd, env: GIT_ENV, stdio: 'pipe' }
  )
}

let repoRoot: string
let repoUrl: string

/** The commit `tag` peels to in the fixture repo. */
function commitOf(tag: string): string {
  return execFileSync('git', ['rev-parse', `${tag}^{commit}`], { cwd: join(repoRoot, 'plugin.git'), env: GIT_ENV, encoding: 'utf8' }).trim()
}

/** Commit `fixture` (optionally with plugin.json fields replaced) as the whole tree, tagged `tag`. */
function commitVariant(work: string, fixture: string, tag: string, patch: Record<string, unknown> = {}): void {
  for (const name of readdirSync(work)) if (name !== '.git') rmSync(join(work, name), { recursive: true, force: true })
  cpSync(join(FIXTURES, fixture), work, { recursive: true })
  if (Object.keys(patch).length > 0) {
    const manifest = JSON.parse(readFileSync(join(work, 'plugin.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(work, 'plugin.json'), JSON.stringify({ ...manifest, ...patch }))
  }
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', tag)
  git(work, 'tag', tag)
}

beforeAll(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-plugin-repo-')))
  const work = join(repoRoot, 'work')
  mkdirSync(work)
  git(work, 'init', '-q')
  commitVariant(work, 'good', 'v1.0.0')
  commitVariant(work, 'good', 'v1.1.0', { version: '1.1.0' })
  commitVariant(work, 'good', 'v1.2.0-rc', { version: '1.2.0-rc' })
  commitVariant(work, 'good', 'rc-upper', { version: '1.2.0-RC' })
  commitVariant(work, 'good', 'other-id', { id: 'test.other', version: '2.0.0' })
  const cli = [{ name: 'browser', summary: 'the browser command' }]
  commitVariant(work, 'good', 'cli-browser', { version: '3.0.0', contributes: { cli } })
  commitVariant(work, 'good', 'cli-browser-2', { version: '3.0.1', contributes: { cli } })
  const themes = [{ id: 'solar', file: 'themes/solar.json' }]
  commitVariant(work, 'good', 'cli-themed', { version: '3.0.2', contributes: { cli, themes } })
  // Annotated: the tag ref names a tag object, whose hash is not the commit's.
  commitVariant(work, 'good', 'annotated-base', { version: '1.4.0' })
  git(work, 'tag', '-a', 'v1.4.0', '-m', 'v1.4.0')
  commitVariant(work, 'good', 'reserved', { id: 'cockpit.good', version: '4.0.0' })
  commitVariant(work, 'bad-api', 'bad-api')
  commitVariant(work, 'escape', 'escape')
  commitVariant(work, 'bad-theme', 'bad-theme')
  git(repoRoot, 'clone', '-q', '--bare', work, 'plugin.git')
  repoUrl = pathToFileURL(join(repoRoot, 'plugin.git')).href
})

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

let dataDir: string
let pluginsDir: string
let logs: string[]

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-installer-')))
  pluginsDir = join(dataDir, 'plugins')
  logs = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function newThemes(): ThemeService {
  return new ThemeService({ settings: { data: {}, save: () => {} }, isDark: () => false, onChange: () => {} })
}

function setup(overrides: Partial<InstallerOptions> = {}): {
  installer: PluginInstaller
  index: PluginIndex
  themes: ThemeService
} {
  const index = new PluginIndex({ filePath: join(dataDir, 'plugins.json'), log: (m) => logs.push(m) })
  const themes = newThemes()
  const installer = new PluginInstaller({
    dataDir,
    index,
    themes,
    env: () => GIT_ENV,
    log: (m) => logs.push(m),
    ...overrides
  })
  return { installer, index, themes }
}

/** plugins.json as a fresh process would read it. */
function onDisk(): PluginIndex {
  return new PluginIndex({ filePath: join(dataDir, 'plugins.json'), log: () => {} })
}

function pluginsDirEntries(): string[] {
  return existsSync(pluginsDir) ? readdirSync(pluginsDir) : []
}

describe('gitUrlProblem', () => {
  it('accepts https, git@ ssh and file:/// URLs', () => {
    for (const url of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'file:///tmp/repo.git']) {
      expect(gitUrlProblem(url), url).toBeNull()
    }
  })

  it.each([
    ['', 'empty'],
    ['-uhttps://x', 'leading dash'],
    ['--upload-pack=touch /tmp/x', 'option'],
    ['ext::sh -c touch% /tmp/pwned', 'ext'],
    ['EXT::sh', 'ext upper case'],
    ['fd::17', 'remote helper'],
    ['http://github.com/a/b', 'plain http'],
    ['git://github.com/a/b', 'git protocol'],
    ['ssh://git@github.com/a/b', 'ssh:// form'],
    ['https://user:pw@github.com/a/b', 'credentials'],
    ['https://github.com/a b', 'whitespace'],
    ['https://github.com/a\nb', 'newline'],
    ['git@-oProxyCommand=touch:x', 'ssh host option'],
    ['git@github.com:-x', 'ssh path option'],
    ['git@github.com', 'ssh without path'],
    ['file://host/repo', 'file with host'],
    ['/tmp/repo.git', 'bare path'],
    ['https://' + 'a'.repeat(2000), 'too long']
  ])('refuses %j (%s)', (url) => {
    expect(gitUrlProblem(url)).not.toBeNull()
  })

  it('refuses non-strings', () => {
    expect(gitUrlProblem(undefined)).not.toBeNull()
    expect(gitUrlProblem(42)).not.toBeNull()
  })
})

describe('gitTagProblem', () => {
  it('accepts ordinary tags', () => {
    for (const tag of ['v1.0.0', '1.2.3-beta.1', 'release/2026_10']) expect(gitTagProblem(tag), tag).toBeNull()
  })

  it.each(['', '-x', '--upload-pack=x', 'a b', 'a..b', 'x;y', '$(id)', 'a\nb', 'v'.repeat(201)])('refuses %j', (tag) => {
    expect(gitTagProblem(tag)).not.toBeNull()
  })
})

describe('cloneArgs and gitEnv', () => {
  it('puts the URL after -- and locks protocols to the URL transport', () => {
    const args = cloneArgs('https://h/r.git', 'v1', '/d')
    expect(args.slice(-3)).toEqual(['--', 'https://h/r.git', '/d'])
    expect(args.slice(args.indexOf('clone'), -3)).toEqual(['clone', '--depth', '1', '--branch', 'v1'])
    expect(args).toContain('protocol.allow=never')
    expect(args).toContain('protocol.ext.allow=never')
    expect(args).toContain('protocol.file.allow=never')
    expect(args).toContain('protocol.https.allow=always')
    expect(args).toContain('core.hooksPath=/dev/null')
    expect(cloneArgs('git@h:r.git', 'v1', '/d')).toContain('protocol.ssh.allow=always')
    expect(cloneArgs('file:///r.git', 'v1', '/d')).toContain('protocol.file.allow=always')
  })

  it('turns off prompts and drops repository-location variables', () => {
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_WORK_TREE: '/y', HOME: '/h' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' })
  })

  it('drops GIT_ALLOW_PROTOCOL (it would override the protocol lock) and skips lfs smudge', () => {
    const env = gitEnv({ GIT_ALLOW_PROTOCOL: 'ext:file', PATH: '/bin' })
    expect(env.GIT_ALLOW_PROTOCOL).toBeUndefined()
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe('1')
  })

  it('reports a missing git binary', async () => {
    await expect(defaultGitRunner(['--version'], { cwd: dataDir, env: { PATH: dataDir }, timeoutMs: 5000 })).rejects.toThrow(
      /git is not installed/
    )
  })
})

describe('defaultGitRunner stdout', () => {
  it('returns stdout', async () => {
    const { stdout, code } = await defaultGitRunner(['--version'], { cwd: dataDir, env: GIT_ENV, timeoutMs: 5000 })
    expect(code).toBe(0)
    expect(stdout).toMatch(/^git version/)
  })

  it('caps stdout and still reads to the end, so a chatty git cannot stall on a full pipe', async () => {
    const bin = join(dataDir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/head -c ${GIT_STDOUT_CAP * 4} /dev/zero\necho done >&2\n`, { mode: 0o755 })
    const result = await defaultGitRunner([], { cwd: dataDir, env: { PATH: bin }, timeoutMs: 5000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toHaveLength(GIT_STDOUT_CAP)
    expect(result.stderr).toBe('done\n')
  })
})

describe('recorded commit and pin', () => {
  const MARKETPLACE = 'https://example.com/index.json'
  const pinFor = (tag: string, version: string, patch: Partial<InstallPin> = {}): InstallPin => ({
    commit: commitOf(tag),
    id: 'test.good',
    version,
    marketplace: MARKETPLACE,
    ...patch
  })
  const OTHER_COMMIT = 'a'.repeat(40)

  it('records the commit of a plain git install, and no marketplace', async () => {
    const { installer } = setup()
    const p = await installer.install(repoUrl, 'v1.0.0')
    expect(p.commit).toBe(commitOf('v1.0.0'))
    expect(p.marketplace).toBeUndefined()
    expect(onDisk().get('test.good')).toMatchObject({ commit: commitOf('v1.0.0') })
    expect(onDisk().get('test.good')?.marketplace).toBeUndefined()
  })

  it('a matching pin installs and records commit and marketplace', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0'))
    expect(onDisk().get('test.good')).toMatchObject({ commit: commitOf('v1.0.0'), marketplace: MARKETPLACE })
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
  })

  it('an annotated tag pins and records the commit, not the tag object', async () => {
    const tagObject = execFileSync('git', ['rev-parse', 'v1.4.0'], { cwd: join(repoRoot, 'plugin.git'), env: GIT_ENV, encoding: 'utf8' }).trim()
    expect(tagObject).not.toBe(commitOf('v1.4.0'))
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.4.0', pinFor('v1.4.0', '1.4.0'))
    expect(onDisk().get('test.good')?.commit).toBe(commitOf('v1.4.0'))
    // .git is still gone from the install, as for any git install.
    expect(existsSync(join(pluginsDir, 'test.good@1.4.0', '.git'))).toBe(false)
  })

  it.each([
    ['commit', { commit: OTHER_COMMIT }, /at commit [0-9a-f]{40}, but the marketplace index pins a{40}/],
    ['id', { id: 'test.other' }, /contains plugin "test\.good", but the marketplace index lists "test\.other"/],
    ['version', { version: '9.9.9' }, /contains version 1\.0\.0, but the marketplace index lists 9\.9\.9/]
  ])('a %s mismatch refuses the install and leaves nothing behind', async (_name, patch, reason) => {
    const { installer, themes } = setup()
    await expect(installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0', patch))).rejects.toThrow(reason)
    expect(pluginsDirEntries()).toEqual([])
    expect(installer.list()).toEqual([])
    expect(existsSync(join(dataDir, 'plugins.json'))).toBe(false)
    expect(themes.list().map((t) => t.id)).not.toContain('test.good/solar')
  })

  it('the mismatch names both commits', async () => {
    const { installer } = setup()
    const failure = installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0', { commit: OTHER_COMMIT }))
    await expect(failure).rejects.toThrow(commitOf('v1.0.0'))
    await expect(failure).rejects.toThrow(OTHER_COMMIT)
  })

  it('an update records the new commit and the marketplace of a pin', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0')
    await installer.update('test.good', 'v1.1.0', pinFor('v1.1.0', '1.1.0'))
    expect(onDisk().get('test.good')).toMatchObject({ version: '1.1.0', commit: commitOf('v1.1.0'), marketplace: MARKETPLACE })
    expect(pluginsDirEntries()).toEqual(['test.good@1.1.0'])
  })

  it('an update without a pin records the new commit and keeps the recorded index', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0'))
    await installer.update('test.good', 'v1.1.0')
    expect(onDisk().get('test.good')).toMatchObject({ commit: commitOf('v1.1.0'), marketplace: MARKETPLACE })
  })

  it('a pin from another index than the recorded one refuses the update', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0'))
    const before = onDisk().get('test.good')
    await expect(
      installer.update('test.good', 'v1.1.0', pinFor('v1.1.0', '1.1.0', { marketplace: 'https://other.example/index.json' }))
    ).rejects.toThrow(/another marketplace index/)
    expect(onDisk().get('test.good')).toEqual(before)
  })

  it('refuses a pin whose index URL a reload would drop', async () => {
    const { installer } = setup()
    const marketplace = 'https://example.com/' + 'a'.repeat(2048)
    await expect(installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0', { marketplace }))).rejects.toThrow(/longer than 2048/)
    expect(pluginsDirEntries()).toEqual([])
  })

  it('a pinned move to an older version is allowed (a revoked plugin leaving its version)', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.1.0', pinFor('v1.1.0', '1.1.0'))
    await installer.update('test.good', 'v1.0.0', pinFor('v1.0.0', '1.0.0'))
    expect(onDisk().get('test.good')).toMatchObject({ version: '1.0.0', commit: commitOf('v1.0.0') })
  })

  it.each([
    ['commit', { commit: OTHER_COMMIT }, /marketplace index pins/],
    ['id', { id: 'test.other' }, /marketplace index lists "test\.other"/],
    ['version', { version: '9.9.9' }, /marketplace index lists 9\.9\.9/]
  ])('a %s mismatch refuses the update and leaves the installed version untouched', async (_name, patch, reason) => {
    const { installer, themes } = setup()
    await installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0'))
    const before = onDisk().get('test.good')
    await expect(installer.update('test.good', 'v1.1.0', pinFor('v1.1.0', '1.1.0', patch))).rejects.toThrow(reason)
    expect(onDisk().get('test.good')).toEqual(before)
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
    expect(existsSync(join(pluginsDir, 'test.good@1.0.0', 'plugin.json'))).toBe(true)
    expect(themes.list().map((t) => t.id)).toContain('test.good/solar')
  })

  it.each([
    ['a failure', { code: 1, stdout: '', stderr: 'fatal' }],
    ['something that is no commit', { code: 0, stdout: 'not-a-hash\n', stderr: '' }]
  ])('rev-parse answering with %s refuses the install', async (_name, answer) => {
    const runGit: GitRunner = (args, options) =>
      args[0] === 'rev-parse' ? Promise.resolve(answer) : defaultGitRunner(args, options)
    const { installer } = setup({ runGit })
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/could not read the cloned commit/)
    expect(pluginsDirEntries()).toEqual([])
  })

  it('a rev-parse that cannot run refuses the install', async () => {
    const runGit: GitRunner = (args, options) =>
      args[0] === 'rev-parse' ? Promise.reject(new Error('git timed out')) : defaultGitRunner(args, options)
    const { installer } = setup({ runGit })
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/git rev-parse failed: git timed out/)
    expect(pluginsDirEntries()).toEqual([])
  })

  it('the commit survives a state change and a restart', async () => {
    await setup().installer.install(repoUrl, 'v1.0.0', pinFor('v1.0.0', '1.0.0'))
    rmSync(join(pluginsDir, 'test.good@1.0.0', 'host.js'))
    const { installer } = setup()
    await installer.load()
    expect(onDisk().get('test.good')).toMatchObject({ state: { ok: false }, commit: commitOf('v1.0.0'), marketplace: MARKETPLACE })
  })

  it('a stored record: old ones stay valid, a bad commit is dropped, only git plugins keep these fields', () => {
    const commit = 'b'.repeat(40)
    const git = { kind: 'git', url: 'x', tag: 'y' }
    writeFileSync(
      join(dataDir, 'plugins.json'),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'test.old', version: '1.0.0', source: git, state: { ok: true } },
          { id: 'test.bad', version: '1.0.0', source: git, state: { ok: true }, commit: 'B'.repeat(40), marketplace: 7 },
          { id: 'test.fine', version: '1.0.0', source: git, state: { ok: true }, commit, marketplace: MARKETPLACE },
          { id: 'test.linked', version: '1.0.0', source: { kind: 'linked', path: '/x' }, state: { ok: true }, commit, marketplace: MARKETPLACE }
        ]
      })
    )
    const plain = (id: string): PluginEntry => ({ id, version: '1.0.0', source: git as PluginEntry['source'], state: { ok: true } })
    const index = onDisk()
    expect(index.get('test.old')).toEqual(plain('test.old'))
    expect(index.get('test.bad')).toEqual(plain('test.bad'))
    expect(index.get('test.fine')).toEqual({ ...plain('test.fine'), commit, marketplace: MARKETPLACE })
    expect(index.get('test.linked')).toEqual({ id: 'test.linked', version: '1.0.0', source: { kind: 'linked', path: '/x' }, state: { ok: true } })
  })
})

describe('install', () => {
  it('a (re)install lets the open hosts start the plugin, with the entry and themes already in place', async () => {
    // An uninstall keeps the plugin in the projects' enabled lists: reinstalling it must start it
    // in the windows that still have it on (HostManager.reloadPlugin), as enabling does.
    const seen: { version?: string; dir: boolean; themed: boolean }[] = []
    const { installer, themes } = setup({
      reloadHosts: async (id) => {
        seen.push({
          version: onDisk().get(id)?.version,
          dir: existsSync(join(pluginsDir, 'test.good@1.0.0', 'plugin.json')),
          themed: themes.list().some((t) => t.id === 'test.good/solar')
        })
      }
    })
    await installer.install(repoUrl, 'v1.0.0')
    await installer.uninstall('test.good')
    await installer.install(repoUrl, 'v1.0.0')
    // install, uninstall, install again.
    expect(seen).toEqual([
      { version: '1.0.0', dir: true, themed: true },
      { version: undefined, dir: true, themed: false },
      { version: '1.0.0', dir: true, themed: true }
    ])
  })

  it('installing over the id of a bundled plugin says it is built in, not "update it"', async () => {
    writeFileSync(
      join(dataDir, 'plugins.json'),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ id: 'test.good', version: '1.0.0', source: { kind: 'bundled', path: '/app/good' }, state: { ok: true } }]
      })
    )
    const { installer } = setup()
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/built in; it updates with the app/)
  })

  it('runs beforeRecord after the checks and the last await, before the plugin is recorded or any host hears of it', async () => {
    const events: string[] = []
    const { installer, index } = setup({ reloadHosts: async () => void events.push('hosts') })
    await installer.install(repoUrl, 'v1.0.0', undefined, () => {
      events.push('before')
      // A crash here restarts with no record of the plugin: nothing to start.
      expect(index.get('test.good')).toBeUndefined()
      expect(onDisk().get('test.good')).toBeUndefined()
      // Folder in place already: no await is left in which a check made here could go stale.
      expect(pluginsDirEntries().filter((n) => !n.startsWith('.tmp-'))).toEqual(['test.good@1.0.0'])
    })
    expect(events).toEqual(['before', 'hosts'])
    expect(onDisk().get('test.good')).toBeDefined()
  })

  it('does not run beforeRecord for a refused install', async () => {
    const before = vi.fn()
    const { installer } = setup()
    await expect(installer.install(repoUrl, 'v1.0.0', { commit: '0'.repeat(40), id: 'test.good', version: '1.0.0', marketplace: 'https://example.com/i.json' }, before)).rejects.toThrow()
    expect(before).not.toHaveBeenCalled()
  })

  it('a beforeRecord that throws stops the install: no record, no folder, no host', async () => {
    const reloadHosts = vi.fn(async () => {})
    const { installer } = setup({ reloadHosts })
    await expect(installer.install(repoUrl, 'v1.0.0', undefined, () => { throw new Error('cannot write') })).rejects.toThrow('cannot write')
    expect(onDisk().get('test.good')).toBeUndefined()
    expect(pluginsDirEntries()).toEqual([])
    expect(reloadHosts).not.toHaveBeenCalled()
  })

  it('a beforeRecord that throws stops an update: the old version stays recorded and running, no new folder', async () => {
    const reloadHosts = vi.fn(async () => {})
    const { installer } = setup({ reloadHosts })
    await installer.install(repoUrl, 'v1.0.0')
    reloadHosts.mockClear()
    await expect(installer.update('test.good', 'v1.1.0', undefined, () => { throw new Error('no longer newer') })).rejects.toThrow('no longer newer')
    expect(onDisk().get('test.good')?.version).toBe('1.0.0')
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
    expect(reloadHosts).not.toHaveBeenCalled()
  })

  it('a crash right after a repo-change install restarts with the plugin off, on the real record files', async () => {
    const project = join(dataDir, 'proj')
    mkdirSync(project)
    const registry = new ProjectRegistry({ dataDir, debounceMs: 60_000, log: (m) => logs.push(m) })
    const id = registry.openPath(project).id
    registry.update(id, (r) => void (r.enabledPlugins = ['test.good']))
    registry.flushAll()
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0', undefined, () => registry.disablePluginEverywhere('test.good'))
    // No flush and no timer here: what a fresh process reads now is what a crash would leave.
    expect(onDisk().get('test.good')).toBeDefined()
    expect(new ProjectRegistry({ dataDir, log: () => {} }).get(id)?.enabledPlugins).toEqual([])
  })

  it('a failing host reload does not fail the install', async () => {
    const { installer } = setup({ reloadHosts: () => Promise.reject(new Error('host crashed')) })
    await expect(installer.install(repoUrl, 'v1.0.0')).resolves.toMatchObject({ id: 'test.good' })
    expect(logs.join('\n')).toMatch(/host crashed/)
  })

  it('clones the tag, moves it into plugins/<id>@<version> and records the source', async () => {
    const { installer, themes } = setup()
    const p = await installer.install(repoUrl, 'v1.0.0')
    const dir = join(pluginsDir, 'test.good@1.0.0')
    expect(p).toMatchObject({ id: 'test.good', version: '1.0.0', dir, state: { ok: true }, themes: ['test.good/solar'] })
    expect(p.manifest?.name).toBe('Good')
    expect(existsSync(join(dir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(dir, 'host.js'))).toBe(true)
    // Only the plugin's files: no git internals, no staging folder left.
    expect(existsSync(join(dir, '.git'))).toBe(false)
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
    expect(onDisk().list()).toEqual([
      { id: 'test.good', version: '1.0.0', source: { kind: 'git', url: repoUrl, tag: 'v1.0.0' }, state: { ok: true }, commit: commitOf('v1.0.0') }
    ])
    expect(themes.list().map((t) => t.id)).toContain('test.good/solar')
  })

  it('refuses bad URLs and tags without running git', async () => {
    const runGit = vi.fn<GitRunner>()
    const { installer } = setup({ runGit })
    for (const [url, tag] of [
      ['ext::sh -c id', 'v1'],
      ['-oProxyCommand=id', 'v1'],
      ['http://example.com/r', 'v1'],
      [repoUrl, '--upload-pack=id'],
      [repoUrl, '-v1'],
      [repoUrl, 'a b']
    ]) {
      await expect(installer.install(url!, tag!), `${url} ${tag}`).rejects.toThrow()
    }
    expect(runGit).not.toHaveBeenCalled()
    expect(pluginsDirEntries()).toEqual([])
  })

  it.each([
    ['bad-api', /unsupported plugin api 2/],
    ['escape', /must not contain "\.\." segments/]
  ])('a manifest failure (%s) leaves nothing behind', async (tag, reason) => {
    const { installer, themes } = setup()
    await expect(installer.install(repoUrl, tag)).rejects.toThrow(reason)
    expect(pluginsDirEntries()).toEqual([])
    expect(existsSync(join(dataDir, 'plugins.json'))).toBe(false)
    expect(installer.list()).toEqual([])
    expect(themes.list()).toHaveLength(2)
  })

  it('a clone failure (unknown tag) leaves nothing behind', async () => {
    const { installer } = setup()
    await expect(installer.install(repoUrl, 'v9.9.9')).rejects.toThrow(/git clone failed \(exit \d+\)/)
    expect(pluginsDirEntries()).toEqual([])
    expect(installer.list()).toEqual([])
  })

  it('a git runner that throws (timeout) leaves nothing behind', async () => {
    const { installer } = setup({ runGit: () => Promise.reject(new Error('git timed out after 120 s')) })
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/timed out/)
    expect(pluginsDirEntries()).toEqual([])
  })

  it('refuses a second install of the same plugin and removes the clone', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0')
    await expect(installer.install(repoUrl, 'v1.1.0')).rejects.toThrow(/already installed \(version 1\.0\.0\); update it instead/)
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
  })

  it('serializes concurrent installs: exactly one wins', async () => {
    const { installer } = setup()
    const results = await Promise.allSettled([installer.install(repoUrl, 'v1.0.0'), installer.install(repoUrl, 'v1.0.0')])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
  })

  it('replaces an unrecorded folder left by a crash', async () => {
    mkdirSync(join(pluginsDir, 'test.good@1.0.0'), { recursive: true })
    writeFileSync(join(pluginsDir, 'test.good@1.0.0', 'stale.txt'), 'x')
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0')
    expect(existsSync(join(pluginsDir, 'test.good@1.0.0', 'stale.txt'))).toBe(false)
    expect(existsSync(join(pluginsDir, 'test.good@1.0.0', 'plugin.json'))).toBe(true)
  })

  it('fails and leaves no folder when plugins.json cannot be written', async () => {
    // Every rename of the index file fails (ENOSPC-like); the clone's own renames are fs.promises.
    const fs = { ...nodeFs, renameSync: () => { throw new Error('ENOSPC') } } as unknown as FsOps
    const index = new PluginIndex({ filePath: join(dataDir, 'plugins.json'), fs, log: (m) => logs.push(m) })
    const { installer } = setup({ index })
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/could not write plugins\.json/)
    expect(pluginsDirEntries()).toEqual([])
    expect(index.get('test.good')).toBeUndefined()
  })

  it('refuses every change while plugins.json is read-only (written by a newer app)', async () => {
    writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify({ schemaVersion: 99, plugins: [] }))
    const runGit = vi.fn<GitRunner>()
    const { installer } = setup({ runGit })
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/cannot be written/)
    expect(runGit).not.toHaveBeenCalled()
  })

  it('registers valid themes and skips an invalid theme without failing the install', async () => {
    const { installer, themes } = setup()
    const p = await installer.install(repoUrl, 'bad-theme')
    expect(p.state).toEqual({ ok: true })
    expect(p.themes).toEqual([])
    expect(themes.list()).toHaveLength(2)
    expect(logs.join('\n')).toMatch(/theme "broken" skipped: invalid theme: kind must be/)
  })
})

describe('update', () => {
  it('installs the new tag side by side, switches the entry, reloads hosts, then removes the old folder', async () => {
    const seen: { oldExists: boolean; newExists: boolean; version?: string }[] = []
    const { installer, themes } = setup({
      reloadHosts: async (id) => {
        seen.push({
          oldExists: existsSync(join(pluginsDir, 'test.good@1.0.0')),
          newExists: existsSync(join(pluginsDir, 'test.good@1.1.0')),
          version: onDisk().get(id)?.version
        })
      }
    })
    await installer.install(repoUrl, 'v1.0.0')
    const p = await installer.update('test.good', 'v1.1.0')
    expect(seen).toEqual([
      // The install itself (a project may have it enabled from before an uninstall).
      { oldExists: true, newExists: false, version: '1.0.0' },
      { oldExists: true, newExists: true, version: '1.1.0' }
    ])
    expect(p).toMatchObject({ version: '1.1.0', source: { kind: 'git', url: repoUrl, tag: 'v1.1.0' }, dir: join(pluginsDir, 'test.good@1.1.0') })
    expect(pluginsDirEntries()).toEqual(['test.good@1.1.0'])
    expect(onDisk().get('test.good')?.version).toBe('1.1.0')
    expect(themes.list().filter((t) => t.id === 'test.good/solar')).toHaveLength(1)
  })

  it('removes the old folder even when the host reload fails', async () => {
    const { installer } = setup({ reloadHosts: () => Promise.reject(new Error('host crashed')) })
    await installer.install(repoUrl, 'v1.0.0')
    await installer.update('test.good', 'v1.1.0')
    expect(pluginsDirEntries()).toEqual(['test.good@1.1.0'])
    expect(logs.join('\n')).toMatch(/host crashed/)
  })

  it('treats versions differing only in case as the same folder', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.2.0-rc')
    await expect(installer.update('test.good', 'rc-upper')).rejects.toThrow(/already at version/)
    expect(pluginsDirEntries()).toEqual(['test.good@1.2.0-rc'])
  })

  it('refuses a tag holding another plugin or the same version and keeps the install intact', async () => {
    const { installer, themes } = setup()
    await installer.install(repoUrl, 'v1.0.0')
    await expect(installer.update('test.good', 'other-id')).rejects.toThrow(/contains plugin "test.other"/)
    await expect(installer.update('test.good', 'v1.0.0')).rejects.toThrow(/already at version 1\.0\.0/)
    await expect(installer.update('test.good', '../x')).rejects.toThrow(/must not contain/)
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
    expect(onDisk().get('test.good')?.source).toEqual({ kind: 'git', url: repoUrl, tag: 'v1.0.0' })
    expect(themes.list().map((t) => t.id)).toContain('test.good/solar')
  })

  it('refuses unknown and linked plugins', async () => {
    const { installer } = setup()
    await expect(installer.update('test.none', 'v1.1.0')).rejects.toThrow(/not installed/)
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-')))
    try {
      cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
      await installer.link(folder)
      await expect(installer.update('test.good', 'v1.1.0')).rejects.toThrow(/linked/)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('uninstall', () => {
  it('removes the folder, the entry and the themes, and keeps per-project and app-wide plugin data', async () => {
    const reloadHosts = vi.fn(async () => {})
    const { installer, themes } = setup({ reloadHosts })
    await installer.install(repoUrl, 'v1.0.0')
    const data = join(dataDir, 'plugin-data', '0123456789abcdef', 'test.good')
    // ctx.appDataDir and main's ctx.appStorage file (app-storage.ts): kept like the project data.
    const appData = pluginAppDataDir(dataDir, 'test.good')
    for (const dir of [data, appData]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'storage.json'), '{}')
    }
    await installer.uninstall('test.good')
    expect(reloadHosts).toHaveBeenCalledWith('test.good')
    expect(pluginsDirEntries()).toEqual([])
    expect(onDisk().list()).toEqual([])
    expect(themes.list().map((t) => t.id)).not.toContain('test.good/solar')
    expect(existsSync(join(data, 'storage.json'))).toBe(true)
    expect(existsSync(join(appData, 'storage.json'))).toBe(true)
  })

  it('runs beforeRemove while the plugin is still recorded; when it throws nothing is removed', async () => {
    const { installer, index } = setup()
    await installer.install(repoUrl, 'v1.0.0')
    await expect(installer.uninstall('test.good', () => { throw new Error('cannot write') })).rejects.toThrow('cannot write')
    expect(onDisk().get('test.good')).toBeDefined()
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
    const seen: string[] = []
    await installer.uninstall('test.good', (entry) => {
      seen.push(entry.source.kind === 'git' ? entry.source.url : '')
      expect(index.get('test.good')).toBeDefined()
    })
    expect(seen).toEqual([repoUrl])
    expect(onDisk().get('test.good')).toBeUndefined()
  })

  it('refuses an unknown plugin', async () => {
    const { installer } = setup()
    await expect(installer.uninstall('test.none')).rejects.toThrow(/not installed/)
  })

  it('deletes the plugin’s secrets once no host runs it, and only its own', async () => {
    const secrets = new PluginSecrets({ dataDir, store: fakeSecretStore(), log: (m) => logs.push(m) })
    await secrets.set('test.good', 'token', 'v')
    await secrets.set('test.other', 'token', 'w')
    const order: string[] = []
    const { installer } = setup({
      reloadHosts: async () => void order.push(`reload:${String(await secrets.keys('test.good'))}`),
      secrets: { removePlugin: (id) => (order.push(`remove:${id}`), secrets.removePlugin(id)) }
    })
    await installer.install(repoUrl, 'v1.0.0')
    order.length = 0
    await installer.uninstall('test.good')
    // The hosts let go first (a running copy could still write a secret), then the store goes.
    expect(order).toEqual(['reload:token', 'remove:test.good'])
    expect(await secrets.keys('test.good')).toEqual([])
    expect(await secrets.get('test.other', 'token')).toBe('w')
  })

  it('still uninstalls when removing the secrets fails', async () => {
    const { installer } = setup({
      secrets: {
        removePlugin: () => {
          throw new Error('disk full')
        }
      }
    })
    await installer.install(repoUrl, 'v1.0.0')
    await installer.uninstall('test.good')
    expect(pluginsDirEntries()).toEqual([])
    expect(onDisk().list()).toEqual([])
    expect(logs.join('\n')).toMatch(/removing its secrets failed: disk full/)
  })
})

describe('link', () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-')))
    cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
  })
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('a (re)link lets the open hosts start the plugin, with the entry already recorded', async () => {
    const seen: (string | undefined)[] = []
    const { installer } = setup({ reloadHosts: async (id) => void seen.push(onDisk().get(id)?.source.kind) })
    await installer.link(folder)
    await installer.uninstall('test.good')
    await installer.link(folder)
    expect(seen).toEqual(['linked', undefined, 'linked'])
  })

  it('a link runs beforeLink before it is recorded; a throw refuses it', async () => {
    const seen: (string | undefined)[] = []
    const { installer } = setup({ beforeLink: (id) => void seen.push(id, onDisk().get(id)?.source.kind) })
    await installer.link(folder)
    expect(seen).toEqual(['test.good', undefined])
    await installer.link(folder, undefined, { keepLinked: true })
    expect(seen).toHaveLength(2)
    await installer.uninstall('test.good')

    const refused = setup({
      beforeLink: () => {
        throw new Error('app.json could not be written')
      }
    })
    await expect(refused.installer.link(folder)).rejects.toThrow(/could not be written/)
    expect(onDisk().get('test.good')).toBeUndefined()
  })

  it('records the folder without copying it; uninstall never deletes it', async () => {
    const { installer, themes } = setup()
    const p = await installer.link(folder)
    expect(p).toMatchObject({ id: 'test.good', version: '1.0.0', dir: folder, source: { kind: 'linked', path: folder } })
    expect(pluginsDirEntries()).toEqual([])
    expect(onDisk().get('test.good')?.source).toEqual({ kind: 'linked', path: folder })
    expect(themes.list().map((t) => t.id)).toContain('test.good/solar')
    await installer.uninstall('test.good')
    expect(existsSync(join(folder, 'plugin.json'))).toBe(true)
    expect(themes.list().map((t) => t.id)).not.toContain('test.good/solar')
  })

  it('inspectLink reports what link would link, changing nothing', async () => {
    const { installer, index } = setup()
    expect(await installer.inspectLink(folder)).toEqual({ id: 'test.good', name: expect.any(String), version: '1.0.0', dir: folder, alreadyLinked: false })
    expect(index.list()).toEqual([])
    await installer.link(folder)
    // The same folder again is "already linked" (ccc plugin link then only enables it); link itself still refuses.
    expect(await installer.inspectLink(folder)).toMatchObject({ id: 'test.good', alreadyLinked: true })
    await expect(installer.link(folder)).rejects.toThrow(/already installed/)
    // Another folder under the same id is a clash, not "already linked".
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-other-')))
    try {
      cpSync(join(FIXTURES, 'good'), other, { recursive: true })
      await expect(installer.inspectLink(other)).rejects.toThrow(/already installed/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    await expect(installer.inspectLink('relative')).rejects.toThrow(/absolute/)
  })

  // Review finding (ext round 10): `ccc plugin link` took "already linked" from before its dialog;
  // linked in Settings meanwhile, Allow failed with "already installed".
  it('link with keepLinked keeps the same folder linked under that id, and still refuses a clash', async () => {
    const { installer, index } = setup()
    await installer.link(folder)
    await expect(installer.link(folder, 'test.good', { keepLinked: true })).resolves.toMatchObject({ id: 'test.good', dir: folder })
    expect(index.list()).toHaveLength(1)
    await installer.uninstall('test.good')
    // Unlinked meanwhile: linked again.
    await expect(installer.link(folder, 'test.good', { keepLinked: true })).resolves.toMatchObject({ id: 'test.good' })
    expect(index.get('test.good')?.source).toEqual({ kind: 'linked', path: folder })
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-other-')))
    try {
      cpSync(join(FIXTURES, 'good'), other, { recursive: true })
      await expect(installer.link(other, 'test.good', { keepLinked: true })).rejects.toThrow(/already installed/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('link with an expected id refuses a folder whose manifest names another plugin now', async () => {
    const { installer, index } = setup()
    await expect(installer.link(folder, 'test.other')).rejects.toThrow(/changed while waiting \(it is test\.good now, not test\.other\)/)
    expect(index.list()).toEqual([])
    await expect(installer.link(folder, 'test.good')).resolves.toMatchObject({ id: 'test.good' })
  })

  it('refuses a relative path, an invalid manifest, a taken id and a folder inside plugins/', async () => {
    const { installer } = setup()
    await expect(installer.link('relative/dir')).rejects.toThrow(/absolute/)
    const broken = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-bad-')))
    try {
      cpSync(join(FIXTURES, 'bad-api'), broken, { recursive: true })
      await expect(installer.link(broken)).rejects.toThrow(/unsupported plugin api 2/)
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
    await installer.install(repoUrl, 'v1.0.0')
    await expect(installer.link(folder)).rejects.toThrow(/already installed/)
    await expect(installer.link(join(pluginsDir, 'test.good@1.0.0'))).rejects.toThrow(/inside the app's plugins directory/)
  })
})

describe('reserved cockpit.* ids (bundled reviewer and editor, Task 3)', () => {
  const RESERVED = /ids starting with cockpit\. are reserved for plugins that ship with the app/

  it('a git install of a reserved id is refused in staging: nothing reaches plugins/ or the index', async () => {
    const { installer } = setup()
    await expect(installer.install(repoUrl, 'reserved')).rejects.toThrow(RESERVED)
    expect(pluginsDirEntries()).toEqual([])
    expect(onDisk().list()).toEqual([])
  })

  it('a marketplace install naming a reserved id is refused before anything is cloned', async () => {
    const calls: string[][] = []
    const { installer } = setup({ runGit: (args, o) => (calls.push(args), defaultGitRunner(args, o)) })
    const pin = { commit: commitOf('reserved'), id: 'cockpit.good', version: '4.0.0', marketplace: 'https://example.com/index.json' }
    await expect(installer.install(repoUrl, 'reserved', pin)).rejects.toThrow(RESERVED)
    expect(calls).toEqual([])
    // Any letter case: the rule is case-insensitive, whatever the id pattern allows.
    await expect(installer.install(repoUrl, 'reserved', { ...pin, id: 'Cockpit.Good' })).rejects.toThrow(RESERVED)
    expect(calls).toEqual([])
    expect(onDisk().list()).toEqual([])
  })

  it('link and inspectLink refuse a reserved id with the reason, before the already-installed check', async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-reserved-')))
    try {
      cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
      const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ ...manifest, id: 'cockpit.good' }))
      const { installer } = setup()
      await expect(installer.inspectLink(folder)).rejects.toThrow(RESERVED)
      await expect(installer.link(folder)).rejects.toThrow(RESERVED)
      expect(onDisk().list()).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('a git record under a reserved id (written before the rule) does not load and cannot be updated', async () => {
    writeFileSync(
      join(dataDir, 'plugins.json'),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [{ id: 'cockpit.good', version: '4.0.0', source: { kind: 'git', url: repoUrl, tag: 'reserved' }, state: { ok: true } }]
      })
    )
    const { installer } = setup()
    // Before load: view already keeps it from the hosts.
    expect(installer.get('cockpit.good')?.manifest).toBeUndefined()
    await installer.load()
    const state = installer.get('cockpit.good')?.state
    expect(state?.ok === false && state.reason).toMatch(RESERVED)
    expect(logs.join('\n')).toMatch(/plugin cockpit\.good disabled: ids starting with cockpit\./)
    await expect(installer.update('cockpit.good', 'v1.1.0')).rejects.toThrow(RESERVED)
  })
})

describe('revalidate and onChange (dev reload, Task 29)', () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-')))
    cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
  })
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })
  const editManifest = (patch: Record<string, unknown>): void => {
    const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ ...manifest, ...patch }))
  }

  it('follows a linked folder edit: version, then an invalid manifest with the reason, then a fix', async () => {
    const { installer, themes } = setup()
    await installer.link(folder)
    editManifest({ version: '1.0.1' })
    expect(await installer.revalidate('test.good')).toEqual({ ok: true })
    expect(installer.get('test.good')).toMatchObject({ version: '1.0.1', state: { ok: true }, themes: ['test.good/solar'] })
    expect(onDisk().get('test.good')?.version).toBe('1.0.1')

    rmSync(join(folder, 'host.js'))
    const bad = await installer.revalidate('test.good')
    expect(bad?.ok).toBe(false)
    expect(bad?.ok === false && bad.reason).toMatch(/main "host.js": file not found/)
    expect(installer.get('test.good')).toMatchObject({ manifest: undefined, themes: [] })
    // Its contributed themes left the registry with the manifest.
    expect(themes.list().map((t) => t.id)).not.toContain('test.good/solar')

    cpSync(join(FIXTURES, 'good', 'host.js'), join(folder, 'host.js'))
    expect(await installer.revalidate('test.good')).toEqual({ ok: true })
    expect(themes.list().map((t) => t.id)).toContain('test.good/solar')
    expect(installer.get('test.good')?.manifest?.name).toBe('Good')
  })

  it('re-registers a changed theme list without tripping over the taken id', async () => {
    const { installer, themes } = setup()
    await installer.link(folder)
    expect(themes.list().filter((t) => t.id === 'test.good/solar')).toHaveLength(1)
    await installer.revalidate('test.good')
    expect(themes.list().filter((t) => t.id === 'test.good/solar')).toHaveLength(1)
  })

  it('does nothing for a git install or an unknown id', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'v1.0.0')
    expect(await installer.revalidate('test.good')).toBeUndefined()
    expect(await installer.revalidate('test.none')).toBeUndefined()
  })

  it('keeps going when the new version cannot be recorded (index write fails)', async () => {
    const { installer, index } = setup()
    await installer.link(folder)
    editManifest({ version: '1.0.2' })
    vi.spyOn(index, 'put').mockImplementation(() => {
      throw new Error('could not write plugins.json')
    })
    expect(await installer.revalidate('test.good')).toEqual({ ok: true })
    expect(logs.some((l) => l.includes('recording version 1.0.2 failed'))).toBe(true)
  })

  it('tells the listener after load, install, link, update and uninstall', async () => {
    const onChange = vi.fn()
    const { installer } = setup({ onChange })
    await installer.load()
    expect(onChange).toHaveBeenCalledTimes(1)
    await installer.link(folder)
    expect(onChange).toHaveBeenCalledTimes(2)
    await installer.uninstall('test.good')
    expect(onChange).toHaveBeenCalledTimes(3)
    await installer.install(repoUrl, 'v1.0.0')
    expect(onChange).toHaveBeenCalledTimes(4)
    await installer.update('test.good', 'v1.1.0')
    expect(onChange).toHaveBeenCalledTimes(5)
    await installer.uninstall('test.good')
    expect(onChange).toHaveBeenCalledTimes(6)
  })

  it('survives a throwing listener', async () => {
    const { installer } = setup({
      onChange: () => {
        throw new Error('listener broke')
      }
    })
    await expect(installer.link(folder)).resolves.toMatchObject({ id: 'test.good' })
    expect(logs.some((l) => l.includes('change listener failed: listener broke'))).toBe(true)
  })
})

describe('load', () => {
  it('registers the themes of recorded plugins and sweeps staging folders', async () => {
    await setup().installer.install(repoUrl, 'v1.0.0')
    mkdirSync(join(pluginsDir, '.tmp-crashed', 'repo'), { recursive: true })
    const { installer, themes } = setup()
    await installer.load()
    expect(themes.list().map((t) => t.id)).toContain('test.good/solar')
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
    expect(installer.get('test.good')).toMatchObject({ state: { ok: true }, themes: ['test.good/solar'] })
  })

  it('keeps a plugin whose folder broke, disabled with the reason', async () => {
    await setup().installer.install(repoUrl, 'v1.0.0')
    rmSync(join(pluginsDir, 'test.good@1.0.0', 'host.js'))
    const { installer, themes } = setup()
    await installer.load()
    const p = installer.get('test.good')
    expect(p?.state.ok).toBe(false)
    expect(p?.state.ok === false && p.state.reason).toMatch(/main "host.js": file not found/)
    expect(p?.manifest).toBeUndefined()
    expect(themes.list()).toHaveLength(2)
    expect(onDisk().get('test.good')?.state.ok).toBe(false)
  })

  it('follows a linked folder version bump', async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-linked-')))
    try {
      cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
      await setup().installer.link(folder)
      const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ ...manifest, version: '1.0.1' }))
      const { installer } = setup()
      await installer.load()
      expect(installer.get('test.good')).toMatchObject({ version: '1.0.1', state: { ok: true } })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('ignores index entries whose id or version could escape plugins/', () => {
    writeFileSync(
      join(dataDir, 'plugins.json'),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'test.good', version: '../../..', source: { kind: 'git', url: 'x', tag: 'y' }, state: { ok: true } },
          { id: '../evil', version: '1.0.0', source: { kind: 'git', url: 'x', tag: 'y' }, state: { ok: true } },
          { id: 'test.linked', version: '1.0.0', source: { kind: 'linked', path: 'relative' }, state: { ok: true } },
          { id: 'test.fine', version: '1.0.0', source: { kind: 'git', url: 'x', tag: 'y' }, state: { ok: true } }
        ]
      })
    )
    const index = onDisk()
    expect(index.list().map((e) => e.id)).toEqual(['test.fine'])
  })
})

describe('cli command clashes (Claude-operable foundation, Task 4)', () => {
  const folders: string[] = []
  /** A linked-plugin folder: the `good` fixture under `id`, declaring `cli` command names. */
  function pluginFolder(id: string, names: string[]): string {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-cli-')))
    folders.push(folder)
    cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
    setCli(folder, id, names)
    return folder
  }
  function setCli(folder: string, id: string, names: string[]): void {
    const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(
      join(folder, 'plugin.json'),
      JSON.stringify({ ...manifest, id, contributes: { cli: names.map((name) => ({ name, summary: `the ${name} command` })) } })
    )
  }
  afterEach(() => {
    for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
  })

  it('refuses to link a plugin that takes a name another plugin owns, naming the owner', async () => {
    const { installer, index } = setup()
    await installer.link(pluginFolder('test.one', ['browser']))
    await expect(installer.link(pluginFolder('test.two', ['other', 'browser']))).rejects.toThrow(
      /cli command "browser" is already provided by plugin test\.one/
    )
    expect(index.get('test.two')).toBeUndefined()
  })

  it('refuses an install and an update that take an owned name, and keeps the install intact', async () => {
    const { installer, index } = setup()
    await installer.link(pluginFolder('test.one', ['browser']))
    await expect(installer.install(repoUrl, 'cli-browser')).rejects.toThrow(/already provided by plugin test\.one/)
    expect(index.get('test.good')).toBeUndefined()
    expect(pluginsDirEntries()).toEqual([])

    await installer.install(repoUrl, 'v1.0.0')
    await expect(installer.update('test.good', 'cli-browser')).rejects.toThrow(/already provided by plugin test\.one/)
    expect(index.get('test.good')?.version).toBe('1.0.0')
  })

  it('lets a plugin keep its own names across an update', async () => {
    const { installer } = setup()
    await installer.install(repoUrl, 'cli-browser')
    const updated = await installer.update('test.good', 'cli-browser-2')
    expect(updated.version).toBe('3.0.1')
    expect(updated.state).toEqual({ ok: true })
  })

  it('a linked manifest edited to take an owned name loses on reload and is not activated', async () => {
    const { installer } = setup()
    await installer.link(pluginFolder('test.one', ['browser']))
    const two = pluginFolder('test.two', ['other'])
    await installer.link(two)
    setCli(two, 'test.two', ['browser'])
    const state = await installer.revalidate('test.two')
    expect(state?.ok).toBe(false)
    expect(state?.ok === false && state.reason).toMatch(/"browser" is already provided by plugin test\.one/)
    expect(installer.get('test.two')).toMatchObject({ state: { ok: false }, manifest: undefined, themes: [] })
    expect(installer.get('test.one')?.state).toEqual({ ok: true })

    // Giving the name up again wins the plugin back.
    setCli(two, 'test.two', ['other'])
    expect(await installer.revalidate('test.two')).toEqual({ ok: true })
  })

  it('the earlier index entry wins when a later reload makes the clash, and the loser recovers on uninstall', async () => {
    const { installer } = setup()
    const one = pluginFolder('test.one', ['alpha'])
    await installer.link(one)
    await installer.link(pluginFolder('test.two', ['browser']))
    // The earlier entry now claims the later one's name.
    setCli(one, 'test.one', ['browser'])
    expect(await installer.revalidate('test.one')).toEqual({ ok: true })
    expect(installer.get('test.one')?.state).toEqual({ ok: true })
    expect(installer.get('test.two')?.state.ok).toBe(false)

    await installer.uninstall('test.one')
    expect(installer.get('test.two')?.state).toEqual({ ok: true })
    expect(installer.get('test.two')?.manifest?.contributes?.cli?.[0]?.name).toBe('browser')
  })

  it('reloads the hosts of a plugin demoted or recovered by someone else\'s change', async () => {
    const reloadHosts = vi.fn((id: string) => Promise.resolve(void id))
    const { installer } = setup({ reloadHosts })
    const one = pluginFolder('test.one', ['alpha'])
    await installer.link(one)
    await installer.link(pluginFolder('test.two', ['browser']))
    reloadHosts.mockClear()

    setCli(one, 'test.one', ['browser'])
    await installer.revalidate('test.one')
    // test.one is reloaded by the dev watcher itself; the demoted test.two is on us.
    expect(reloadHosts.mock.calls).toEqual([['test.two']])

    reloadHosts.mockClear()
    await installer.uninstall('test.one')
    expect(reloadHosts.mock.calls.map((c) => c[0]).sort()).toEqual(['test.one', 'test.two'])
  })

  it('the winner is stable across restarts', async () => {
    const first = setup()
    const one = pluginFolder('test.one', ['alpha'])
    const two = pluginFolder('test.two', ['browser'])
    await first.installer.link(one)
    await first.installer.link(two)
    setCli(one, 'test.one', ['browser'])
    await first.installer.revalidate('test.one')
    expect(onDisk().get('test.two')?.state.ok).toBe(false)

    for (let i = 0; i < 2; i++) {
      const { installer } = setup()
      await installer.load()
      expect(installer.get('test.one')?.state).toEqual({ ok: true })
      const loser = installer.get('test.two')
      expect(loser?.state.ok).toBe(false)
      expect(loser?.state.ok === false && loser.state.reason).toMatch(/provided by plugin test\.one/)
    }
  })
})

describe('revocation', () => {
  const MARKETPLACE = 'https://example.com/index.json'
  const REVOKED = { reason: 'steals tokens', source: MARKETPLACE }
  // Revokes exactly the listed id + commit pairs, the way MarketplaceService answers.
  const revoking = (list: { id: string; commit: string }[]) => (p: { id: string; commit: string }) =>
    list.some((r) => r.id === p.id && r.commit === p.commit) ? REVOKED : null

  it('a revoked commit is stopped at load, with the reason, and survives a reload of the file', async () => {
    const first = setup()
    await first.installer.install(repoUrl, 'v1.0.0')
    const onRevoked = vi.fn()
    const { installer, themes } = setup({ revocation: revoking([{ id: 'test.good', commit: commitOf('v1.0.0') }]), onRevoked })
    await installer.load()
    const p = installer.get('test.good')
    expect(p?.state).toEqual({ ok: false, reason: `revoked by ${MARKETPLACE}: steals tokens`, revoked: REVOKED })
    expect(p?.manifest).toBeUndefined()
    expect(themes.list().some((t) => t.id.startsWith('test.good/'))).toBe(false)
    expect(onDisk().get('test.good')?.state).toEqual(p?.state)
    expect(onRevoked.mock.calls).toEqual([[[{ id: 'test.good', revoked: REVOKED }]]])

    // Already recorded as revoked: the next launch does not tell the user again.
    const again = vi.fn()
    const next = setup({ revocation: revoking([{ id: 'test.good', commit: commitOf('v1.0.0') }]), onRevoked: again })
    await next.installer.load()
    expect(next.installer.get('test.good')?.state.ok).toBe(false)
    expect(again).not.toHaveBeenCalled()
  })

  it('the same id at another commit is not matched', async () => {
    const first = setup()
    await first.installer.install(repoUrl, 'v1.0.0')
    const { installer } = setup({ revocation: revoking([{ id: 'test.good', commit: commitOf('v1.1.0') }]) })
    await installer.load()
    expect(installer.get('test.good')?.state).toEqual({ ok: true })
  })

  it('a linked plugin and a record with no commit are never matched', async () => {
    const first = setup()
    await first.installer.install(repoUrl, 'v1.0.0')
    // A record from before commits were recorded.
    const raw = JSON.parse(readFileSync(join(dataDir, 'plugins.json'), 'utf8')) as { plugins: Record<string, unknown>[] }
    delete raw.plugins[0]!.commit
    writeFileSync(join(dataDir, 'plugins.json'), JSON.stringify(raw))
    const revocation = vi.fn(() => REVOKED)
    const old = setup({ revocation })
    await old.installer.load()
    expect(old.installer.get('test.good')?.state).toEqual({ ok: true })
    expect(revocation).not.toHaveBeenCalled()
    await old.installer.uninstall('test.good')

    await old.installer.link(join(FIXTURES, 'good'))
    await old.installer.applyRevocations()
    expect(old.installer.get('test.good')?.state).toEqual({ ok: true })
    expect(revocation).not.toHaveBeenCalled()
  })

  it('refuses to install a revoked commit, on the git URL path too, and leaves nothing behind', async () => {
    const { installer, index } = setup({ revocation: revoking([{ id: 'test.good', commit: commitOf('v1.0.0') }]) })
    await expect(installer.install(repoUrl, 'v1.0.0')).rejects.toThrow(/is revoked by .*steals tokens/)
    expect(index.get('test.good')).toBeUndefined()
    expect(pluginsDirEntries()).toEqual([])
  })

  it('refuses to update to a revoked commit and keeps the installed version', async () => {
    const { installer } = setup({ revocation: revoking([{ id: 'test.good', commit: commitOf('v1.1.0') }]) })
    await installer.install(repoUrl, 'v1.0.0')
    await expect(installer.update('test.good', 'v1.1.0')).rejects.toThrow(/is revoked/)
    expect(installer.get('test.good')).toMatchObject({ version: '1.0.0', state: { ok: true } })
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
  })

  it('asks about the index the plugin would be recorded from', async () => {
    const revocation = vi.fn(() => null)
    const { installer } = setup({ revocation })
    const pin = { commit: commitOf('v1.0.0'), id: 'test.good', version: '1.0.0', marketplace: MARKETPLACE }
    await installer.install(repoUrl, 'v1.0.0', pin)
    expect(revocation).toHaveBeenLastCalledWith({ id: 'test.good', commit: commitOf('v1.0.0'), marketplace: MARKETPLACE })
    await installer.update('test.good', 'v1.1.0')
    expect(revocation).toHaveBeenLastCalledWith({ id: 'test.good', commit: commitOf('v1.1.0'), marketplace: MARKETPLACE })
  })

  it('applyRevocations stops a running plugin once, and a withdrawn revocation brings it back', async () => {
    let revoked: { id: string; commit: string }[] = []
    const reloadHosts = vi.fn(async () => {})
    const onRevoked = vi.fn()
    const onChange = vi.fn()
    const { installer } = setup({ revocation: (p) => revoking(revoked)(p), reloadHosts, onRevoked, onChange })
    await installer.install(repoUrl, 'v1.0.0')
    reloadHosts.mockClear()
    onChange.mockClear()

    // Nothing revoked: nothing to do.
    await installer.applyRevocations()
    expect(reloadHosts).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    revoked = [{ id: 'test.good', commit: commitOf('v1.0.0') }]
    await installer.applyRevocations()
    expect(installer.get('test.good')?.state.ok).toBe(false)
    expect(installer.get('test.good')?.manifest).toBeUndefined()
    expect(reloadHosts.mock.calls).toEqual([['test.good']])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onRevoked).toHaveBeenCalledTimes(1)

    // Idempotent: no second notice, no second reload.
    await installer.applyRevocations()
    expect(reloadHosts).toHaveBeenCalledTimes(1)
    expect(onRevoked).toHaveBeenCalledTimes(1)

    revoked = []
    await installer.applyRevocations()
    expect(installer.get('test.good')?.state).toEqual({ ok: true })
    expect(installer.get('test.good')?.manifest).toBeDefined()
    expect(reloadHosts).toHaveBeenCalledTimes(2)
    expect(onRevoked).toHaveBeenCalledTimes(1)
  })

  it('no index to ask keeps a recorded revocation; a good index without the entry withdraws it', async () => {
    let answer: typeof REVOKED | null | undefined = null
    const { installer } = setup({ revocation: () => answer })
    await installer.install(repoUrl, 'v1.0.0')
    answer = REVOKED
    await installer.applyRevocations()
    expect(installer.get('test.good')?.state.ok).toBe(false)
    answer = undefined
    await installer.load()
    expect(installer.get('test.good')?.state).toEqual({ ok: false, reason: `revoked by ${MARKETPLACE}: steals tokens`, revoked: REVOKED })
    answer = null
    await installer.applyRevocations()
    expect(installer.get('test.good')?.state).toEqual({ ok: true })
  })

  it('asks with the index behind the recorded revocation, so that index alone can withdraw it', async () => {
    // Like MarketplaceService with a good recorded index and no copy of the default one.
    let row: typeof REVOKED | null = null
    const asked: (string | undefined)[] = []
    const { installer } = setup({
      revocation: (p) => {
        asked.push(p.recordedSource)
        return row ?? (p.recordedSource === MARKETPLACE ? null : undefined)
      }
    })
    await installer.install(repoUrl, 'v1.0.0')
    row = REVOKED
    await installer.applyRevocations()
    expect(installer.get('test.good')?.state.ok).toBe(false)
    row = null
    asked.length = 0
    await installer.applyRevocations()
    expect(asked[0]).toBe(MARKETPLACE)
    expect(installer.get('test.good')?.state).toEqual({ ok: true })
  })

  it('applyRevocations acts on what refreshEntry settled when the index changes meanwhile', async () => {
    let answer: typeof REVOKED | null = null
    let calls = 0
    // The first look (the pre-check) sees a revocation, the second (inside refreshEntry) none.
    const { installer, onRevoked } = (() => {
      const onRevoked = vi.fn()
      const r = setup({ revocation: () => (calls++ === 0 ? answer : null), onRevoked })
      return { ...r, onRevoked }
    })()
    await installer.install(repoUrl, 'v1.0.0')
    calls = 0
    answer = REVOKED
    await installer.applyRevocations()
    expect(installer.get('test.good')?.state).toEqual({ ok: true })
    expect(onRevoked).not.toHaveBeenCalled()
  })

  describe('a revocation arriving while an install or update is being committed', () => {
    // The refresh that brings it queues applyRevocations behind the running operation, which records it
    // and tells the user. Until then the hosts must not get the plugin at all (PluginInstaller.view).
    /** Runs `arrive` when the plugin's theme is registered: after plugins.json holds it, before it is activated. */
    function themesCalling(arrive: () => void): InstallerOptions['themes'] {
      const real = newThemes()
      return {
        register: (input) => {
          arrive()
          return real.register(input)
        },
        unregister: (id) => real.unregister(id)
      }
    }

    it('during the commit, the install is refused and leaves nothing behind', async () => {
      let revoked: { id: string; commit: string }[] = []
      const reloadHosts = vi.fn(async () => {})
      const { installer, index } = setup({ revocation: (p) => revoking(revoked)(p), reloadHosts })
      const rename = nodeFs.promises.rename.bind(nodeFs.promises)
      const spy = vi.spyOn(nodeFs.promises, 'rename').mockImplementation(async (from, to) => {
        revoked = [{ id: 'test.good', commit: commitOf('v1.0.0') }]
        await rename(from, to)
      })
      const before = vi.fn()
      try {
        await expect(installer.install(repoUrl, 'v1.0.0', undefined, before)).rejects.toThrow(/is revoked by .*steals tokens/)
      } finally {
        spy.mockRestore()
      }
      // Refused before beforeRecord, which promises not to run (and turn projects' switches off) for a refusal.
      expect(before).not.toHaveBeenCalled()
      expect(index.get('test.good')).toBeUndefined()
      expect(onDisk().get('test.good')).toBeUndefined()
      expect(pluginsDirEntries()).toEqual([])
      expect(reloadHosts).not.toHaveBeenCalled()
    })

    it('during theme registration, the plugin is never handed to a host, and the queued run records it', async () => {
      let revoked: { id: string; commit: string }[] = []
      const seenByHosts: unknown[] = []
      const onRevoked = vi.fn()
      const { installer } = setup({
        revocation: (p) => revoking(revoked)(p),
        onRevoked,
        themes: themesCalling(() => {
          revoked = [{ id: 'test.good', commit: commitOf('v1.0.0') }]
        }),
        // What a host would start from when it reloads.
        reloadHosts: (id) => {
          const p = installer.get(id)
          seenByHosts.push({ ok: p?.state.ok, manifest: p?.manifest })
          return Promise.resolve()
        }
      })
      const result = await installer.install(repoUrl, 'v1.0.0')
      expect(seenByHosts).toEqual([{ ok: false, manifest: undefined }])
      expect(result).toMatchObject({ state: { ok: false, revoked: REVOKED } })
      expect(result.manifest).toBeUndefined()
      await installer.applyRevocations()
      expect(installer.get('test.good')?.themes).toEqual([])
      expect(onDisk().get('test.good')?.state).toMatchObject({ ok: false, revoked: REVOKED })
      expect(onRevoked.mock.calls).toEqual([[[{ id: 'test.good', revoked: REVOKED }]]])
      // Once told is enough.
      await installer.applyRevocations()
      expect(onRevoked).toHaveBeenCalledTimes(1)
    })

    it('during theme registration of an update, the new code is not activated and the hosts drop the old', async () => {
      let revoked: { id: string; commit: string }[] = []
      let arriving = false
      const seenByHosts: unknown[] = []
      const { installer } = setup({
        revocation: (p) => revoking(revoked)(p),
        themes: themesCalling(() => {
          if (arriving) revoked = [{ id: 'test.good', commit: commitOf('v1.1.0') }]
        }),
        reloadHosts: (id) => {
          const p = installer.get(id)
          seenByHosts.push({ ok: p?.state.ok, manifest: p?.manifest })
          return Promise.resolve()
        }
      })
      await installer.install(repoUrl, 'v1.0.0')
      seenByHosts.length = 0
      arriving = true
      const result = await installer.update('test.good', 'v1.1.0')
      expect(seenByHosts).toEqual([{ ok: false, manifest: undefined }])
      expect(result).toMatchObject({ version: '1.1.0', state: { ok: false, revoked: REVOKED } })
      expect(pluginsDirEntries()).toEqual(['test.good@1.1.0'])
    })

    it('during theme registration, no manifest can be read while another plugin it freed a name for reloads', async () => {
      let revoked: { id: string; commit: string }[] = []
      let arriving = false
      const seenDuringOtherReload: unknown[] = []
      const { installer } = setup({
        revocation: (p) => revoking(revoked)(p),
        themes: themesCalling(() => {
          if (arriving) revoked = [{ id: 'test.good', commit: commitOf('v1.1.0') }]
        }),
        reloadHosts: (id) => {
          if (id === 'test.two') seenDuringOtherReload.push(installer.get('test.good')?.manifest)
          return Promise.resolve()
        }
      })
      await installer.install(repoUrl, 'cli-browser')
      // test.two takes the name by a later edit, and loses it.
      const two = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-cli-')))
      try {
        cpSync(join(FIXTURES, 'good'), two, { recursive: true })
        const manifest = JSON.parse(readFileSync(join(two, 'plugin.json'), 'utf8')) as Record<string, unknown>
        writeFileSync(join(two, 'plugin.json'), JSON.stringify({ ...manifest, id: 'test.two', contributes: {} }))
        await installer.link(two)
        const cli = [{ name: 'browser', summary: 'the browser command' }]
        writeFileSync(join(two, 'plugin.json'), JSON.stringify({ ...manifest, id: 'test.two', contributes: { cli } }))
        expect((await installer.revalidate('test.two'))?.ok).toBe(false)
        seenDuringOtherReload.length = 0
        // v1.1.0 has no `cli`: settling the names gives test.two its name back and reloads its hosts.
        arriving = true
        await installer.update('test.good', 'v1.1.0')
        expect(seenDuringOtherReload).toEqual([undefined])
        expect(installer.get('test.two')?.state.ok).toBe(true)
      } finally {
        rmSync(two, { recursive: true, force: true })
      }
    })

    it('while the command names settle, the hosts are still not told to start it', async () => {
      let looks = 0
      const seenByHosts: unknown[] = []
      const { installer } = setup({
        // After the clone check, the commit and the theme gate: the first look left is the host's own.
        revocation: () => (++looks > 3 ? REVOKED : null),
        reloadHosts: (id) => {
          seenByHosts.push(installer.get(id)?.manifest)
          return Promise.resolve()
        }
      })
      const result = await installer.install(repoUrl, 'v1.0.0')
      expect(seenByHosts).toEqual([undefined])
      expect(result.state).toMatchObject({ ok: false, revoked: REVOKED })
    })
  })

  describe('a revocation arriving while a plugin is being refreshed', () => {
    /**
     * Runs `arrive` during the theme read: the second stat of the theme file, the first being
     * loadManifest's check of it. The only await left after the manifest, so an earlier look misses it.
     */
    function arriveDuringThemeRead(arrive: () => void): { mockRestore(): void } {
      const stat = nodeFs.promises.stat.bind(nodeFs.promises) as (path: string) => Promise<nodeFs.Stats>
      let looks = 0
      const fake = (path: string): Promise<nodeFs.Stats> => {
        if (path.endsWith('solar.json') && ++looks === 2) arrive()
        return stat(path)
      }
      return vi.spyOn(nodeFs.promises, 'stat').mockImplementation(fake as typeof nodeFs.promises.stat)
    }

    it('keeps a plugin being restored stopped, and its hosts are not told to start it', async () => {
      let revoked: { id: string; commit: string }[] = []
      const reloadHosts = vi.fn(async () => {})
      const onRevoked = vi.fn()
      const { installer, themes } = setup({ revocation: (p) => revoking(revoked)(p), reloadHosts, onRevoked })
      await installer.install(repoUrl, 'v1.0.0')
      const again = [{ id: 'test.good', commit: commitOf('v1.0.0') }]
      revoked = again
      await installer.applyRevocations()
      reloadHosts.mockClear()
      onRevoked.mockClear()
      // Withdrawn, so the refresh sets out to bring it back; revoked again before it gets there.
      revoked = []
      const spy = arriveDuringThemeRead(() => {
        revoked = again
      })
      try {
        await installer.applyRevocations()
      } finally {
        spy.mockRestore()
      }
      const p = installer.get('test.good')
      expect(p?.state).toEqual({ ok: false, reason: `revoked by ${MARKETPLACE}: steals tokens`, revoked: REVOKED })
      expect(p?.manifest).toBeUndefined()
      expect(onDisk().get('test.good')?.state).toEqual(p?.state)
      expect(themes.list().some((t) => t.id.startsWith('test.good/'))).toBe(false)
      expect(reloadHosts).not.toHaveBeenCalled()
      expect(onRevoked).not.toHaveBeenCalled()
    })

    it('never registers the themes of a plugin that is revoked', async () => {
      const first = setup()
      await first.installer.install(repoUrl, 'v1.0.0')
      const real = newThemes()
      const register = vi.fn((input: unknown) => real.register(input))
      const { installer } = setup({
        revocation: revoking([{ id: 'test.good', commit: commitOf('v1.0.0') }]),
        themes: { register, unregister: (id) => real.unregister(id) }
      })
      await installer.load()
      expect(installer.get('test.good')?.state).toMatchObject({ ok: false, revoked: REVOKED })
      expect(register).not.toHaveBeenCalled()
    })
  })

  describe('a plugin ok in the index but revoked by the current lookup', () => {
    const v1 = (): { id: string; commit: string }[] => [{ id: 'test.good', commit: commitOf('v1.0.0') }]

    it('is not handed out by list or get until the queued run records it and tells the user', async () => {
      let revoked: { id: string; commit: string }[] = []
      const onRevoked = vi.fn()
      const { installer, index } = setup({ revocation: (p) => revoking(revoked)(p), onRevoked })
      await installer.install(repoUrl, 'v1.0.0')
      revoked = v1()
      for (const p of [installer.get('test.good'), installer.list()[0]]) {
        expect(p?.state).toEqual({ ok: false, reason: `revoked by ${MARKETPLACE}: steals tokens`, revoked: REVOKED })
        expect(p?.manifest).toBeUndefined()
      }
      // Hidden, not recorded: the queued run must still see a change to record and announce.
      expect(index.get('test.good')?.state).toEqual({ ok: true })
      expect(onRevoked).not.toHaveBeenCalled()
      await installer.applyRevocations()
      expect(onDisk().get('test.good')?.state).toMatchObject({ ok: false, revoked: REVOKED })
      expect(onRevoked).toHaveBeenCalledTimes(1)
    })

    it('a command name clash recovering on an uninstall does not start it, nor register its themes', async () => {
      let revoked: { id: string; commit: string }[] = []
      const seenByHosts: Record<string, unknown>[] = []
      const onRevoked = vi.fn()
      const real = newThemes()
      const register = vi.fn((input: unknown) => real.register(input))
      const { installer } = setup({
        revocation: (p) => revoking(revoked)(p),
        onRevoked,
        themes: { register, unregister: (id) => real.unregister(id) },
        reloadHosts: (id) => {
          const p = installer.get(id)
          seenByHosts.push({ id, ok: p?.state.ok, manifest: p?.manifest })
          return Promise.resolve()
        }
      })
      // The linked plugin is the earlier entry, so taking the name by a later edit beats the git plugin.
      const owner = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-cli-')))
      try {
        cpSync(join(FIXTURES, 'good'), owner, { recursive: true })
        const manifest = JSON.parse(readFileSync(join(owner, 'plugin.json'), 'utf8')) as Record<string, unknown>
        writeFileSync(join(owner, 'plugin.json'), JSON.stringify({ ...manifest, id: 'test.owner', contributes: {} }))
        await installer.link(owner)
        await installer.install(repoUrl, 'cli-themed')
        const cli = [{ name: 'browser', summary: 'the browser command' }]
        writeFileSync(join(owner, 'plugin.json'), JSON.stringify({ ...manifest, id: 'test.owner', contributes: { cli } }))
        await installer.revalidate('test.owner')
        expect(installer.get('test.good')?.state.ok).toBe(false)
        revoked = [{ id: 'test.good', commit: commitOf('cli-themed') }]
        seenByHosts.length = 0
        register.mockClear()
        // Uninstalling the owner runs ahead of the queued applyRevocations.
        await installer.uninstall('test.owner')
      } finally {
        rmSync(owner, { recursive: true, force: true })
      }
      expect(seenByHosts.filter((s) => s.id === 'test.good')).toEqual([{ id: 'test.good', ok: false, manifest: undefined }])
      expect(register).not.toHaveBeenCalled()
      await installer.applyRevocations()
      expect(onDisk().get('test.good')?.state).toMatchObject({ ok: false, revoked: REVOKED })
      expect(onRevoked).toHaveBeenCalledTimes(1)
    })

    it('a plugin just restored and revoked again while a later plugin refreshes does not start', async () => {
      const both = (): { id: string; commit: string }[] => [...v1(), { id: 'test.other', commit: commitOf('other-id') }]
      let revoked: { id: string; commit: string }[] = []
      const seenByHosts: Record<string, unknown>[] = []
      const onRevoked = vi.fn()
      const { installer } = setup({
        revocation: (p) => revoking(revoked)(p),
        onRevoked,
        reloadHosts: (id) => {
          const p = installer.get(id)
          seenByHosts.push({ id, ok: p?.state.ok, manifest: p?.manifest })
          return Promise.resolve()
        }
      })
      await installer.install(repoUrl, 'v1.0.0')
      await installer.install(repoUrl, 'other-id')
      revoked = both()
      await installer.applyRevocations()
      seenByHosts.length = 0
      onRevoked.mockClear()
      // Withdrawn, so both come back in clash order; test.good is revoked again once it has been
      // restored, when the run reads the theme of the later plugin.
      revoked = []
      const stat = nodeFs.promises.stat.bind(nodeFs.promises) as (path: string) => Promise<nodeFs.Stats>
      const fake = (path: string): Promise<nodeFs.Stats> => {
        if (path.includes('test.other@') && path.endsWith('solar.json')) revoked = v1()
        return stat(path)
      }
      const spy = vi.spyOn(nodeFs.promises, 'stat').mockImplementation(fake as typeof nodeFs.promises.stat)
      try {
        await installer.applyRevocations()
      } finally {
        spy.mockRestore()
      }
      expect(seenByHosts.find((s) => s.id === 'test.good')).toEqual({ id: 'test.good', ok: false, manifest: undefined })
      expect(installer.get('test.other')?.state).toEqual({ ok: true })
      // The run that revocation queued records it and tells the user.
      await installer.applyRevocations()
      expect(onDisk().get('test.good')?.state).toMatchObject({ ok: false, revoked: REVOKED })
      expect(onRevoked).toHaveBeenCalledTimes(1)
    })
  })

  it('reconciling the command names cannot bring a revoked plugin back', async () => {
    let revoked: { id: string; commit: string }[] = []
    const { installer } = setup({ revocation: (p) => revoking(revoked)(p) })
    await installer.install(repoUrl, 'cli-browser')
    revoked = [{ id: 'test.good', commit: commitOf('cli-browser') }]
    await installer.applyRevocations()
    // Any later change to the set runs reconcileCliClashes.
    await installer.link(join(FIXTURES, 'host-ok'))
    expect(installer.get('test.good')?.state.ok).toBe(false)
  })

  it('a revoked plugin can move to an older commit that is not revoked', async () => {
    let revoked: { id: string; commit: string }[] = []
    const { installer } = setup({ revocation: (p) => revoking(revoked)(p) })
    await installer.install(repoUrl, 'v1.1.0')
    revoked = [{ id: 'test.good', commit: commitOf('v1.1.0') }]
    await installer.applyRevocations()
    const moved = await installer.update('test.good', 'v1.0.0')
    expect(moved).toMatchObject({ version: '1.0.0', commit: commitOf('v1.0.0'), state: { ok: true } })
    expect(moved.manifest).toBeDefined()
    expect(pluginsDirEntries()).toEqual(['test.good@1.0.0'])
  })
})
