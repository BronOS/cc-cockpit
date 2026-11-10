// The index repo's CI tools (marketplace/tools). Local temp repos over file:/// and a fake fetch: no
// network and no GitHub. The rules here are what stands between a fork's PR and a merge token.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bumpedId, decideAutoMerge, listAll, main as autoMergeMain, resolvePullRequest, type DecisionInput, type FetchLike, type PullFile, type PullSummary } from '../../marketplace/tools/src/auto-merge'
import { PARTIAL_EXIT, buildIndex } from '../../marketplace/tools/src/build-index'
import {
  MAX_PREVIEW_FETCHES,
  PREVIEW_CLONE_TIMEOUT_MS,
  PREVIEW_FETCH_BUDGET_MS,
  PREVIEW_RETRY_AFTER_MS,
  changedEntryFiles,
  checkEntry,
  fetchPreviews,
  inspectEntry,
  main as checkMain,
  manifestProblems,
  parseRequiredFrom
} from '../../marketplace/tools/src/check-entry'
import { MAX_ENTRY_BYTES, listEntryFiles, parseSourceEntry, quoted } from '../../marketplace/tools/src/common'
import { createHash } from 'node:crypto'
import { DEFAULT_MARKETPLACE_URL as SERVICE_URL, parseMarketplaceIndex, previewPath, type MarketplaceEntry } from '../../src/shared/marketplace'
import { fakePng } from '../fakes/png'

// js-yaml ships no types and this one call needs none.
const { load: parseYaml } = createRequire(__filename)('js-yaml') as { load(text: string): unknown }

const REPO = resolve(__dirname, '../..')
const TEMPLATE = join(REPO, 'marketplace')
const DIST = join(TEMPLATE, 'tools/dist')
const FILE_INDEX = 'file:///index.json'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const MAIN_SHA = 'c'.repeat(40)
const OWNER = 1001

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }
  ).trim()
}

function sourceEntry(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme.tool',
    name: 'Tool',
    description: 'A tool',
    author: 'Acme',
    repo: 'https://example.com/acme/tool.git',
    version: '1.0.0',
    tag: 'v1.0.0',
    commit: COMMIT_A,
    api: 1,
    owners: [OWNER],
    ...patch
  }
}

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-mp-tools-')))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function indexRepo(root: string, entries: Record<string, unknown>[], revoked: unknown = []): string {
  mkdirSync(join(root, 'plugins'), { recursive: true })
  for (const e of entries) writeFileSync(join(root, 'plugins', `${String(e.id)}.json`), JSON.stringify(e))
  writeFileSync(join(root, 'revoked.json'), JSON.stringify(revoked))
  return root
}

describe('the default index URL', () => {
  it('is the one the app uses', () => {
    expect(SERVICE_URL).toBe('https://raw.githubusercontent.com/BronOS/cc-cockpit-marketplace/main/index.json')
  })
})

describe('parseSourceEntry', () => {
  it('accepts a good entry', () => {
    const parsed = parseSourceEntry(JSON.stringify(sourceEntry()), SERVICE_URL)
    expect(parsed.ok && parsed.owners).toEqual([OWNER])
  })

  it.each<[string, Record<string, unknown>]>([
    ['no owners', { owners: [] }],
    ['logins as owners', { owners: ['octocat'] }],
    ['a negative owner', { owners: [-1] }],
    ['an unknown field', { homepage: 'https://x' }],
    ['a short commit', { commit: 'abc' }],
    ['an ssh repo', { repo: 'git@github.com:a/b.git' }],
    ['a file: repo from an https index', { repo: 'file:///tmp/r.git' }],
    // The app reads an unknown category as `other`; CI catches the typo.
    ['an unknown category', { category: 'game' }],
    // build-index writes it from the image it checked; an author cannot claim one.
    ['a preview claimed by the author', { preview: { sha256: 'f'.repeat(64) } }]
  ])('refuses %s', (_name, patch) => {
    expect(parseSourceEntry(JSON.stringify(sourceEntry(patch)), SERVICE_URL).ok).toBe(false)
  })

  it('takes a known category, and none as other', () => {
    const parsed = parseSourceEntry(JSON.stringify(sourceEntry({ category: 'integrations' })), SERVICE_URL)
    expect(parsed.ok && parsed.entry.category).toBe('integrations')
    const none = parseSourceEntry(JSON.stringify(sourceEntry()), SERVICE_URL)
    expect(none.ok && none.entry.category).toBe('other')
    const bad = parseSourceEntry(JSON.stringify(sourceEntry({ category: 'game' })), SERVICE_URL)
    expect(bad.ok ? null : bad.problem).toMatch(/"category" must be one of integrations, productivity, ai, developer, appearance, other/)
  })

  it('says what is wrong, for the author reading the CI log', () => {
    const problem = (patch: Record<string, unknown>): unknown => {
      const parsed = parseSourceEntry(JSON.stringify(sourceEntry(patch)), SERVICE_URL)
      return parsed.ok ? null : parsed.problem
    }
    expect(problem({ commit: 'abc' })).toMatch(/"commit" must be the full/)
    expect(problem({ repo: 'git@github.com:a/b.git' })).toMatch(/"repo": an ssh repo/)
    expect(problem({ name: ' ' })).toMatch(/"name"/)
    // Reserved for the plugins that ship with the app, in any letter case the id rule could let through.
    expect(problem({ id: 'cockpit.tool' })).toBe('"id": ids starting with cockpit. are reserved for plugins that ship with the app')
  })

  it('refuses text that is not an object, or absurdly long', () => {
    expect(parseSourceEntry('nope', SERVICE_URL).ok).toBe(false)
    expect(parseSourceEntry('[]', SERVICE_URL).ok).toBe(false)
    expect(parseSourceEntry(' '.repeat(70_000), SERVICE_URL).ok).toBe(false)
  })
})

describe('buildIndex', () => {
  it('produces what the app accepts, sorted, without owners', () => {
    const root = indexRepo(tmp, [sourceEntry({ id: 'zed.tool' }), sourceEntry({ id: 'acme.tool' })], [
      { id: 'acme.tool', commit: COMMIT_B, reason: 'bad' }
    ])
    const { text, problems } = buildIndex(root)
    expect(problems).toEqual([])
    expect(text).not.toContain('owners')
    const parsed = parseMarketplaceIndex(text, { indexUrl: SERVICE_URL })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.skippedEntries).toBe(0)
    expect(parsed.index.plugins.map((p) => p.id)).toEqual(['acme.tool', 'zed.tool'])
    expect(parsed.index.revoked).toEqual([{ id: 'acme.tool', commit: COMMIT_B, reason: 'bad' }])
    // Same input, same bytes: an unchanged index must make no commit.
    expect(buildIndex(root).text).toBe(text)
  })

  it('builds the template as shipped: an empty index', () => {
    expect(JSON.parse(buildIndex(TEMPLATE).text)).toEqual({ schema: 1, plugins: [], revoked: [] })
  })

  const revocation = { id: 'acme.tool', commit: COMMIT_B, reason: 'bad' }

  it('a bad entry names the file and does not stop a new revocation from publishing', () => {
    const root = indexRepo(tmp, [sourceEntry(), sourceEntry({ id: 'bad.tool', commit: 'nope' })], [revocation])
    const { text, problems } = buildIndex(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/bad\.tool\.json.*"commit".*not listed/)
    expect(JSON.parse(text)).toMatchObject({ plugins: [{ id: 'acme.tool' }], revoked: [revocation] })
  })

  it('refuses a reserved cockpit. id: a problem, not listed', () => {
    const root = indexRepo(tmp, [sourceEntry(), sourceEntry({ id: 'cockpit.tool' })], [])
    const { text, problems } = buildIndex(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/cockpit\.tool\.json.*reserved for plugins that ship with the app.*not listed/)
    expect(JSON.parse(text)).toMatchObject({ plugins: [{ id: 'acme.tool' }] })
  })

  it('a bad entry keeps its published listing, neither unlisted nor changed', () => {
    const good = indexRepo(tmp, [sourceEntry({ description: 'as published' })], [])
    writeFileSync(join(good, 'index.json'), buildIndex(good).text)
    writeFileSync(join(good, 'plugins/acme.tool.json'), JSON.stringify(sourceEntry({ description: 'new', commit: 'nope' })))
    writeFileSync(join(good, 'revoked.json'), JSON.stringify([revocation]))
    const { text, problems } = buildIndex(good)
    expect(problems[0]).toMatch(/published listing stays/)
    expect(JSON.parse(text)).toMatchObject({ plugins: [{ description: 'as published' }], revoked: [revocation] })
  })

  it('a deleted entry leaves, published or not, and an unusable index.json is no source of listings', () => {
    const root = indexRepo(tmp, [sourceEntry()], [])
    writeFileSync(join(root, 'index.json'), buildIndex(root).text)
    rmSync(join(root, 'plugins/acme.tool.json'))
    expect(JSON.parse(buildIndex(root).text).plugins).toEqual([])
    writeFileSync(join(root, 'index.json'), 'nope')
    writeFileSync(join(root, 'plugins/acme.tool.json'), JSON.stringify(sourceEntry({ commit: 'nope' })))
    expect(JSON.parse(buildIndex(root).text).plugins).toEqual([])
  })

  it('a misnamed or symlinked entry is a problem like any other', () => {
    const root = indexRepo(tmp, [])
    writeFileSync(join(root, 'plugins', 'other.name.json'), JSON.stringify(sourceEntry()))
    symlinkSync('/etc/passwd', join(root, 'plugins', 'acme.tool.json'))
    const { text, problems } = buildIndex(root)
    expect(problems.join('\n')).toMatch(/other\.name\.json.*file name must be the id/)
    expect(problems.join('\n')).toMatch(/acme\.tool\.json.*not a regular file/)
    expect(JSON.parse(text).plugins).toEqual([])
  })

  it('an absent plugins/ is an empty list: removing the last entry must not crash the publish', () => {
    const root = indexRepo(tmp, [], [revocation])
    rmSync(join(root, 'plugins'), { recursive: true })
    expect(listEntryFiles(join(root, 'plugins'))).toEqual([])
    expect(JSON.parse(buildIndex(root).text)).toMatchObject({ plugins: [], revoked: [revocation] })
  })

  it('fails on a bad revocation or a missing revoked.json: revocations are never silently lost', () => {
    expect(() => buildIndex(indexRepo(tmp, [], [{ id: 'acme.tool', commit: 'x', reason: '' }]))).toThrow(/invalid row \(1\): "commit"/)
    expect(() => buildIndex(indexRepo(tmp, [], { revoked: [] }))).toThrow(/not a list/)
    rmSync(join(tmp, 'revoked.json'))
    expect(() => buildIndex(tmp)).toThrow()
  })

  describe('with a base checkout', () => {
    const bad = sourceEntry({ id: 'bad.tool', commit: 'nope' })
    const planted = (root: string): void => {
      symlinkSync('/etc/passwd', join(root, 'plugins', 'link.tool.json'))
      writeFileSync(join(root, 'plugins', 'huge.tool.json'), 'x'.repeat(MAX_ENTRY_BYTES + 1))
    }

    it('a bad entry the PR leaves alone is inherited, of any kind, and the revocation still builds', () => {
      const base = indexRepo(join(tmp, 'base'), [sourceEntry(), bad])
      const head = indexRepo(join(tmp, 'head'), [sourceEntry(), bad], [revocation])
      planted(base)
      planted(head)
      const { text, problems, inherited } = buildIndex(head, undefined, base)
      expect(problems).toEqual([])
      expect(inherited.join('\n')).toMatch(/bad\.tool\.json/)
      expect(inherited.join('\n')).toMatch(/link\.tool\.json/)
      expect(inherited.join('\n')).toMatch(/huge\.tool\.json/)
      expect(JSON.parse(text)).toMatchObject({ plugins: [{ id: 'acme.tool' }], revoked: [revocation] })
    })

    it.each<[string, (head: string) => void]>([
      ['added', (head) => writeFileSync(join(head, 'plugins/new.tool.json'), JSON.stringify(sourceEntry({ id: 'new.tool', commit: 'nope' })))],
      ['changed', (head) => writeFileSync(join(head, 'plugins/bad.tool.json'), JSON.stringify({ ...bad, name: 'Still bad' }))],
      ['made bad', (head) => writeFileSync(join(head, 'plugins/acme.tool.json'), JSON.stringify(sourceEntry({ commit: 'nope' })))],
      ['made a symlink', (head) => {
        rmSync(join(head, 'plugins/acme.tool.json'))
        symlinkSync('/etc/passwd', join(head, 'plugins/acme.tool.json'))
      }]
    ])('a bad entry the PR has %s is a problem', (_name, edit) => {
      const base = indexRepo(join(tmp, 'base'), [sourceEntry(), bad])
      const head = indexRepo(join(tmp, 'head'), [sourceEntry(), bad])
      edit(head)
      expect(buildIndex(head, undefined, base).problems).toHaveLength(1)
    })

    it('a symlink the PR points somewhere else is a problem', () => {
      const base = indexRepo(join(tmp, 'base'), [])
      const head = indexRepo(join(tmp, 'head'), [])
      symlinkSync('/etc/passwd', join(base, 'plugins/link.tool.json'))
      symlinkSync('/etc/hosts', join(head, 'plugins/link.tool.json'))
      expect(buildIndex(head, undefined, base).problems).toHaveLength(1)
    })

    it('with no base, the publish run, every bad entry stays a problem', () => {
      const { problems, inherited } = buildIndex(indexRepo(tmp, [bad]))
      expect(problems).toHaveLength(1)
      expect(inherited).toEqual([])
    })
  })

  describe('previews', () => {
    const plant = (root: string, bytes: Buffer | string, id = 'acme.tool', commit = COMMIT_A): string => {
      const path = join(root, previewPath(id, commit))
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, bytes)
      return path
    }

    it('lists the hash of a published preview of the entry\'s own commit', () => {
      const root = indexRepo(tmp, [sourceEntry(), sourceEntry({ id: 'zed.tool' })])
      const png = fakePng()
      plant(root, png)
      // Another commit's image is not this listing's.
      plant(root, png, 'zed.tool', COMMIT_B)
      const { text, problems, warnings } = buildIndex(root)
      expect(problems).toEqual([])
      const plugins = JSON.parse(text).plugins as Record<string, unknown>[]
      expect(plugins[0]).toMatchObject({ id: 'acme.tool', category: 'other', preview: { sha256: createHash('sha256').update(png).digest('hex') } })
      expect(plugins[1]).not.toHaveProperty('preview')
      expect(warnings).toEqual(['build-index: "zed.tool": no preview published for this commit'])
    })

    it.each<[string, (root: string) => void, RegExp]>([
      ['a wrong-size image', (root) => plant(root, fakePng({ width: 100, height: 100 })), /100x100/],
      ['an animated image', (root) => plant(root, fakePng({ animated: true })), /animated/],
      ['an oversized file', (root) => plant(root, fakePng({ dataBytes: 600 * 1024 })), /too large/],
      ['a symlink', (root) => {
        mkdirSync(join(root, 'previews/acme.tool'), { recursive: true })
        symlinkSync('/etc/passwd', join(root, previewPath('acme.tool', COMMIT_A)))
      }, /not a regular file/]
    ])('lists the entry without a preview for %s, as a warning that fails nothing', (_name, setup, pattern) => {
      const root = indexRepo(tmp, [sourceEntry()], [{ id: 'x.y', commit: COMMIT_B, reason: 'bad' }])
      setup(root)
      const { text, problems, warnings } = buildIndex(root)
      expect(problems).toEqual([])
      expect(warnings.join('\n')).toMatch(pattern)
      expect(JSON.parse(text).plugins[0]).not.toHaveProperty('preview')
      expect(JSON.parse(text).revoked).toHaveLength(1)
    })
  })

  it('refuses a file: repo unless told the index is file:', () => {
    const root = indexRepo(tmp, [sourceEntry({ repo: 'file:///tmp/r.git' })])
    expect(buildIndex(root).problems[0]).toMatch(/a file: repo needs a file: index/)
    expect(JSON.parse(buildIndex(root, FILE_INDEX).text).plugins).toHaveLength(1)
  })
})

describe('check-entry', () => {
  let repoRoot: string
  let repoUrl: string
  const commits: Record<string, string> = {}

  // Each tag is one way a listing can be right or wrong about the repo.
  function tagged(work: string, tag: string, manifest: Record<string, unknown> | null, setup?: () => void): void {
    rmSync(join(work, 'plugin.json'), { force: true })
    rmSync(join(work, 'dist'), { recursive: true, force: true })
    rmSync(join(work, 'preview.png'), { force: true })
    rmSync(join(work, 'panels'), { recursive: true, force: true })
    if (manifest !== null) writeFileSync(join(work, 'plugin.json'), JSON.stringify(manifest))
    setup?.()
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '--allow-empty', '-m', tag)
    git(work, 'tag', tag)
    commits[tag] = git(work, 'rev-parse', 'HEAD')
  }

  beforeAll(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-mp-repo-')))
    const work = join(repoRoot, 'work')
    mkdirSync(work)
    git(work, 'init', '-q')
    const manifest = { id: 'acme.tool', name: 'Tool', version: '1.0.0', api: 1, main: 'dist/host.js' }
    const built = (): void => {
      mkdirSync(join(work, 'dist'))
      writeFileSync(join(work, 'dist/host.js'), 'module.exports = {}\n')
    }
    tagged(work, 'good', manifest, built)
    tagged(work, 'theme-only', { id: 'acme.tool', name: 'Tool', version: '1.0.0', api: 1 })
    tagged(work, 'other-id', { ...manifest, id: 'evil.tool' }, built)
    tagged(work, 'other-version', { ...manifest, version: '9.9.9' }, built)
    tagged(work, 'other-api', { ...manifest, api: 2 }, built)
    tagged(work, 'no-main', manifest)
    tagged(work, 'escaping-main', { ...manifest, main: '../../etc/passwd' })
    tagged(work, 'symlink-main', manifest, () => {
      mkdirSync(join(work, 'dist'))
      symlinkSync('/etc/passwd', join(work, 'dist/host.js'))
    })
    tagged(work, 'git-main', { ...manifest, main: '.git/HEAD' })
    const withPreview = (bytes: Buffer): (() => void) => () => {
      built()
      writeFileSync(join(work, 'preview.png'), bytes)
    }
    tagged(work, 'preview-good', manifest, withPreview(fakePng()))
    tagged(work, 'preview-oversized', manifest, withPreview(fakePng({ dataBytes: 600 * 1024 })))
    tagged(work, 'preview-wrong-size', manifest, withPreview(fakePng({ width: 800, height: 300 })))
    tagged(work, 'preview-animated', manifest, withPreview(fakePng({ animated: true })))
    tagged(work, 'preview-symlink', manifest, () => {
      built()
      symlinkSync('/etc/passwd', join(work, 'preview.png'))
    })
    tagged(work, 'root-absolute', manifest, () => {
      built()
      mkdirSync(join(work, 'panels'))
      writeFileSync(join(work, 'panels/a.html'), '<script src="/dist/x.js"></script><script src="../__sdk/panel.js"></script>')
    })
    tagged(work, 'relative-urls', manifest, () => {
      built()
      mkdirSync(join(work, 'panels'))
      writeFileSync(join(work, 'panels/a.html'), '<script src="../__sdk/panel.js"></script><script src="a.js"></script>')
      writeFileSync(join(work, 'panels/a.js'), "fetch('./data.json')")
    })
    tagged(work, 'no-manifest', null)
    tagged(work, 'bad-manifest', null, () => writeFileSync(join(work, 'plugin.json'), '{'))
    // Annotated: the tag ref names a tag object, whose hash is not the commit's.
    git(work, 'checkout', '-q', 'good')
    git(work, 'tag', '-a', 'annotated', '-m', 'annotated')
    git(repoRoot, 'clone', '-q', '--bare', work, 'plugin.git')
    repoUrl = pathToFileURL(join(repoRoot, 'plugin.git')).href
  })
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  function entryAt(tag: string, patch: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
    return {
      id: 'acme.tool',
      name: 'Tool',
      description: '',
      author: 'Acme',
      repo: repoUrl,
      version: '1.0.0',
      tag,
      commit: commits[tag] ?? commits.good!,
      api: 1,
      category: 'developer',
      ...patch
    }
  }
  const check = (entry: MarketplaceEntry): Promise<string[]> => checkEntry(entry, { env: GIT_ENV })

  it('passes a good entry, an annotated tag and a plugin with no main', async () => {
    expect(await check(entryAt('good'))).toEqual([])
    expect(await check(entryAt('annotated', { commit: commits.good! }))).toEqual([])
    expect(await check(entryAt('theme-only'))).toEqual([])
  })

  it.each<[string, string, RegExp]>([
    ['a plugin.json id', 'other-id', /id is "evil\.tool"/],
    ['a plugin.json version', 'other-version', /version is "9\.9\.9"/],
    ['a plugin.json api', 'other-api', /api is 2/],
    ['a main that is not built', 'no-main', /main "dist\/host\.js" is not a file/],
    ['a main outside the repo', 'escaping-main', /main must not contain "\.\."/],
    ['a main symlinked out of the repo', 'symlink-main', /main "dist\/host\.js" is not a file/],
    ['a main inside .git', 'git-main', /main ".git\/HEAD" is inside \.git/],
    ['no plugin.json', 'no-manifest', /plugin\.json is missing/],
    ['a broken plugin.json', 'bad-manifest', /plugin\.json is missing/]
  ])('reports %s', async (_name, tag, pattern) => {
    expect((await check(entryAt(tag))).join('\n')).toMatch(pattern)
  })

  it('warns, never refuses, about a root-absolute URL in a page, and passes relative ones', async () => {
    const opts = { env: GIT_ENV, previewRequiredFrom: null }
    const bad = await inspectEntry(entryAt('root-absolute'), opts)
    expect(bad.problems).toEqual([])
    expect(bad.warnings.some((w) => /^panels\/a\.html: root-absolute URL "\/dist\/x\.js" \(src\)/.test(w))).toBe(true)
    const good = await inspectEntry(entryAt('relative-urls'), opts)
    expect(good.warnings.filter((w) => w.includes('root-absolute'))).toEqual([])
  })

  describe('preview.png', () => {
    const DAY = '2027-01-10'
    const before = (): Date => new Date('2027-01-09T23:59:59Z')
    const on = (): Date => new Date('2027-01-10T00:00:00Z')

    it('passes a good preview and hands over its bytes', async () => {
      const seen = await inspectEntry(entryAt('preview-good'), { env: GIT_ENV, previewRequiredFrom: DAY, now: on })
      expect(seen).toMatchObject({ problems: [], warnings: [], atCommit: true })
      expect(seen.preview?.equals(fakePng())).toBe(true)
    })

    it.each<[string, RegExp]>([
      ['preview-oversized', /preview\.png: the preview is over 512 KiB/],
      ['preview-wrong-size', /preview\.png: the preview is 800x300/],
      ['preview-animated', /preview\.png: the preview is animated/],
      ['preview-symlink', /preview\.png is not a regular file/]
    ])('refuses %s, with or without the date', async (tag, pattern) => {
      expect((await check(entryAt(tag))).join('\n')).toMatch(pattern)
      const seen = await inspectEntry(entryAt(tag), { env: GIT_ENV, previewRequiredFrom: null })
      expect(seen.preview).toBeNull()
    })

    it('a missing one is a warning before the date or with none, and refused from the day', async () => {
      const none = await inspectEntry(entryAt('good'), { env: GIT_ENV, previewRequiredFrom: null })
      expect(none.problems).toEqual([])
      expect(none.warnings).toEqual(['there is no preview.png at the tag: the listing shows a placeholder, and one will be required soon'])
      const early = await inspectEntry(entryAt('good'), { env: GIT_ENV, previewRequiredFrom: DAY, now: before })
      expect(early.problems).toEqual([])
      expect(early.warnings[0]).toMatch(/will be required from 2027-01-10/)
      const due = await inspectEntry(entryAt('good'), { env: GIT_ENV, previewRequiredFrom: DAY, now: on })
      expect(due.problems).toEqual(['there is no preview.png at the tag: one is required since 2027-01-10'])
      expect(due.warnings).toEqual([])
    })

    it('--preview-required-from takes a calendar day or none, nothing else', () => {
      expect(parseRequiredFrom(undefined)).toBeNull()
      expect(parseRequiredFrom('none')).toBeNull()
      expect(parseRequiredFrom('2027-01-10')).toBe('2027-01-10')
      // '' is what the workflow passes when preview-policy.json is missing: fail closed.
      for (const bad of ['', 'null', '2027-02-30', '2027-1-10', 'tomorrow']) expect(() => parseRequiredFrom(bad)).toThrow(/YYYY-MM-DD or none/)
    })

    it('--base/--head warns on the PR for a missing preview, and refuses it past the date', async () => {
      const base = indexRepo(join(tmp, 'base'), [])
      const head = indexRepo(join(tmp, 'head'), [{ ...entryAt('good'), owners: [OWNER] }])
      const args = ['--base', base, '--head', head, '--index-url', FILE_INDEX]
      const logged: string[] = []
      const log = console.log
      console.log = (line: string) => logged.push(line)
      try {
        await expect(checkMain([...args, '--preview-required-from', 'none'], { env: GIT_ENV })).resolves.toBeUndefined()
      } finally {
        console.log = log
      }
      expect(logged[0]).toMatch(/^::warning::check-entry: "acme\.tool\.json": there is no preview\.png/)
      await expect(checkMain([...args, '--preview-required-from', '2000-01-01'], { env: GIT_ENV })).rejects.toThrow(/one is required since 2000-01-01/)
    })
  })

  describe('--fetch-previews', () => {
    const quiet = { env: GIT_ENV }

    it('writes the image of a listing that has none, a marker when the repo has none, and skips what is done', async () => {
      const root = indexRepo(join(tmp, 'index'), [
        { ...entryAt('preview-good'), owners: [OWNER] },
        { ...entryAt('good', { id: 'bare.tool' }), owners: [OWNER] },
        { ...entryAt('preview-animated', { id: 'anim.tool' }), owners: [OWNER] },
        // A moved tag: whatever is at the tag is not the pinned commit's, so nothing is written.
        { ...entryAt('preview-good', { id: 'moved.tool', commit: COMMIT_A }), owners: [OWNER] }
      ])
      const out = join(tmp, 'out')
      const log = await fetchPreviews(root, out, FILE_INDEX, quiet)
      expect(readFileSync(join(out, previewPath('acme.tool', commits['preview-good']!))).equals(fakePng())).toBe(true)
      expect(existsSync(join(out, `previews/bare.tool/${commits.good!}.none`))).toBe(true)
      expect(existsSync(join(out, `previews/anim.tool/${commits['preview-animated']!}.none`))).toBe(true)
      // A moved tag only defers the next try: the marker holds the time of this one.
      expect(Number.isNaN(Date.parse(readFileSync(join(out, `previews/moved.tool/${COMMIT_A}.failed`), 'utf8').trim()))).toBe(false)
      expect(existsSync(join(out, `previews/moved.tool/${COMMIT_A}.png`))).toBe(false)
      expect(log.join('\n')).toMatch(/"moved\.tool\.json": not fetched/)

      // Once published (copied into the index checkout), nothing is cloned again, the failed one included.
      execFileSync('cp', ['-R', join(out, 'previews'), root])
      const again = join(tmp, 'again')
      const second = await fetchPreviews(root, again, FILE_INDEX, quiet)
      expect(second).toEqual([])
      expect(existsSync(join(again, 'previews'))).toBe(false)
      // And build-index lists the hash of the image it finds there.
      const built = JSON.parse(buildIndex(root, FILE_INDEX).text) as { plugins: Record<string, unknown>[] }
      expect(built.plugins.find((p) => p.id === 'acme.tool')).toHaveProperty('preview.sha256', createHash('sha256').update(fakePng()).digest('hex'))
      expect(built.plugins.find((p) => p.id === 'bare.tool')).not.toHaveProperty('preview')
    })

    it('fetches at most the cap per run, and failed listings do not keep later ones out', async () => {
      // More failing listings than the cap, all sorted before the one that works.
      const missing = pathToFileURL(join(tmp, 'missing.git')).href
      const failing = Array.from({ length: MAX_PREVIEW_FETCHES + 1 }, (_, i) => ({
        ...entryAt('good', { id: `fail${String.fromCharCode(97 + i)}.tool`, repo: missing }),
        owners: [OWNER]
      }))
      const root = indexRepo(join(tmp, 'index'), [...failing, { ...entryAt('preview-good', { id: 'zz.tool' }), owners: [OWNER] }])
      const t0 = new Date('2027-01-10T12:00:00Z')
      const run = async (dir: string, at: Date): Promise<string[]> => {
        const log = await fetchPreviews(root, join(tmp, dir), FILE_INDEX, { ...quiet, now: () => at })
        if (existsSync(join(tmp, dir, 'previews'))) execFileSync('cp', ['-R', join(tmp, dir, 'previews'), root])
        return log
      }
      const first = await run('one', t0)
      expect(first.filter((l) => l.includes('not fetched'))).toHaveLength(MAX_PREVIEW_FETCHES)
      expect(first.at(-1)).toBe(`more than ${MAX_PREVIEW_FETCHES} previews to fetch: the rest wait for the next run`)
      expect(existsSync(join(tmp, 'one/previews/zz.tool'))).toBe(false)

      // An hour later the failed ones wait their day, so the last failing one and the good one get their turn.
      const second = await run('two', new Date(t0.getTime() + 60 * 60_000))
      expect(second).toEqual([
        `"fail${String.fromCharCode(97 + MAX_PREVIEW_FETCHES)}.tool.json": not fetched, the tag is not at the pinned commit or could not be cloned; retried in a day`,
        '"zz.tool.json": preview fetched'
      ])

      // A day after the first run, the first batch is tried again.
      const third = await run('three', new Date(t0.getTime() + PREVIEW_RETRY_AFTER_MS))
      expect(third.filter((l) => l.includes('not fetched'))).toHaveLength(MAX_PREVIEW_FETCHES)
      expect(third[0]).toMatch(/^"faila\.tool\.json": not fetched/)
      // A marker from the future (a skewed clock, a hand edit) does not block a listing for good.
      writeFileSync(join(root, `previews/faila.tool/${commits.good!}.failed`), '2999-01-01T00:00:00.000Z\n')
      const fourth = await run('four', new Date(t0.getTime() + PREVIEW_RETRY_AFTER_MS + 60 * 60_000))
      expect(fourth[0]).toMatch(/^"faila\.tool\.json": not fetched/)
    }, 30_000)

    it('starts no clone once the time budget is spent', async () => {
      const root = indexRepo(join(tmp, 'index'), [{ ...entryAt('preview-good'), owners: [OWNER] }])
      const out = join(tmp, 'out')
      expect(await fetchPreviews(root, out, FILE_INDEX, { ...quiet, budgetMs: 0 })).toEqual(['out of time for this run: the rest wait for the next run'])
      expect(existsSync(join(out, 'previews'))).toBe(false)
    })

    it('runs as a command from the committed bundle', () => {
      const root = indexRepo(join(tmp, 'index'), [{ ...entryAt('preview-good'), owners: [OWNER] }])
      const out = join(tmp, 'out')
      const run = spawnSync(process.execPath, [join(DIST, 'check-entry.js'), '--fetch-previews', root, '--out', out, '--index-url', FILE_INDEX], {
        env: GIT_ENV,
        encoding: 'utf8',
        timeout: 25_000
      })
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('"acme.tool.json": preview fetched')
      expect(existsSync(join(out, previewPath('acme.tool', commits['preview-good']!)))).toBe(true)
    }, 30_000)
  })

  it('reports a commit that is not where the tag is (a moved tag)', async () => {
    const problems = await check(entryAt('good', { commit: COMMIT_A }))
    expect(problems.join('\n')).toContain(`the entry says "${COMMIT_A}"`)
    expect(problems.join('\n')).toContain(commits.good!)
  })

  it('reports a tag or repo that does not exist on one line, without git\u2019s own text', async () => {
    const [noTag] = await check(entryAt('v404'))
    expect(noTag).toMatch(/could not clone tag "v404"/)
    expect(noTag).not.toContain('\n')
    // A PR picks the host and the log is public: what git says about it would be a free network probe.
    expect(noTag).not.toMatch(/fatal|Remote branch|warning:/)
    const [gone] = await check(entryAt('good', { repo: `${repoUrl}-gone` }))
    expect(gone).toMatch(/could not clone/)
    expect(gone).not.toMatch(/fatal|does not appear|not found/i)
  })

  it('caps what it echoes from a plugin.json', async () => {
    const dir = join(tmp, 'checkout')
    mkdirSync(dir)
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: 'x'.repeat(100_000), version: '1.0.0', api: 1 }))
    const problems = await manifestProblems(dir, entryAt('good'))
    expect(problems[0]!.length).toBeLessThan(400)
    expect(quoted('a\nb')).toBe('"a\\nb"')
  })

  it('runs no hook while cloning, even one from the runner’s own git config', async () => {
    const hooks = join(tmp, 'hooks')
    const marker = join(tmp, 'hook-ran')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
    const config = join(tmp, 'gitconfig')
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`)
    expect(await checkEntry(entryAt('good'), { env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: config } })).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  it('leaves no clone behind', async () => {
    const scratch = join(tmp, 'scratch')
    mkdirSync(scratch)
    const previous = process.env.TMPDIR
    process.env.TMPDIR = scratch
    try {
      await check(entryAt('good'))
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
    expect(spawnSync('ls', ['-A', scratch], { encoding: 'utf8' }).stdout).toBe('')
  })

  it('--base/--head checks only what changed, and fails on a false entry', async () => {
    const base = indexRepo(join(tmp, 'base'), [sourceEntry({ id: 'same.tool' })])
    const good = { ...entryAt('good'), owners: [OWNER] }
    const head = indexRepo(join(tmp, 'head'), [sourceEntry({ id: 'same.tool' }), good])
    expect(changedEntryFiles(base, head)).toEqual(['acme.tool.json'])
    const args = ['--base', base, '--head', head, '--index-url', FILE_INDEX]
    await expect(checkMain(args, { env: GIT_ENV })).resolves.toBeUndefined()

    writeFileSync(join(head, 'plugins/acme.tool.json'), JSON.stringify({ ...good, commit: COMMIT_B }))
    await expect(checkMain(args, { env: GIT_ENV })).rejects.toThrow(/"acme\.tool\.json".*the tag is at commit/)
    // From an https index (the default) a file: repo is not even cloned.
    await expect(checkMain(['--base', base, '--head', head], { env: GIT_ENV })).rejects.toThrow(/a file: repo needs a file: index/)
  })

  it('--base/--head refuses a new commit under the same version: installed copies could not follow it', async () => {
    const base = indexRepo(join(tmp, 'base'), [{ ...entryAt('good', { commit: COMMIT_A }), owners: [OWNER] }])
    const head = indexRepo(join(tmp, 'head'), [{ ...entryAt('good'), owners: [OWNER] }])
    const args = ['--base', base, '--head', head, '--index-url', FILE_INDEX]
    await expect(checkMain(args, { env: GIT_ENV })).rejects.toThrow(/a new commit needs a new version/)
  })

  it('--base/--head with no plugins/ on either side has nothing to check', async () => {
    const base = indexRepo(join(tmp, 'base'), [])
    const head = indexRepo(join(tmp, 'head'), [])
    rmSync(join(head, 'plugins'), { recursive: true })
    await expect(checkMain(['--base', base, '--head', head], { env: GIT_ENV })).resolves.toBeUndefined()
  })

  it('--base/--head refuses a misnamed entry and a symlink', async () => {
    const base = indexRepo(join(tmp, 'base'), [])
    const head = indexRepo(join(tmp, 'head'), [])
    writeFileSync(join(head, 'plugins/other.name.json'), JSON.stringify({ ...entryAt('good'), owners: [OWNER] }))
    const args = ['--base', base, '--head', head, '--index-url', FILE_INDEX]
    await expect(checkMain(args, { env: GIT_ENV })).rejects.toThrow(/file name must be the id/)
    rmSync(join(head, 'plugins/other.name.json'))
    symlinkSync('/etc/passwd', join(head, 'plugins/acme.tool.json'))
    await expect(checkMain(args, { env: GIT_ENV })).rejects.toThrow(/not a regular file/)
  })

  it('--base/--head passes over a bad file on main the PR does not touch, and lets a PR repair it', async () => {
    const plant = (root: string): void => {
      symlinkSync('/etc/passwd', join(root, 'plugins/link.tool.json'))
      writeFileSync(join(root, 'plugins/huge.tool.json'), 'x'.repeat(MAX_ENTRY_BYTES + 1))
      writeFileSync(join(root, 'plugins/bad.tool.json'), '{')
    }
    const base = indexRepo(join(tmp, 'base'), [])
    const head = indexRepo(join(tmp, 'head'), [], [{ id: 'x.y', commit: COMMIT_A, reason: 'bad' }])
    plant(base)
    plant(head)
    expect(changedEntryFiles(base, head)).toEqual([])
    await expect(checkMain(['--base', base, '--head', head], { env: GIT_ENV })).resolves.toBeUndefined()
    // Changing one of them makes it this PR's: the same size, so only the bytes can tell.
    writeFileSync(join(head, 'plugins/bad.tool.json'), '[')
    await expect(checkMain(['--base', base, '--head', head], { env: GIT_ENV })).rejects.toThrow(/"bad\.tool\.json"/)
    writeFileSync(join(head, 'plugins/bad.tool.json'), '{')
    // A good file replacing the symlink: the base side cannot be read, which must not stop the repair.
    rmSync(join(head, 'plugins/link.tool.json'))
    writeFileSync(join(head, 'plugins/link.tool.json'), JSON.stringify({ ...entryAt('good', { id: 'link.tool' }), owners: [OWNER] }))
    await expect(checkMain(['--base', base, '--head', head, '--index-url', FILE_INDEX], { env: GIT_ENV })).rejects.toThrow(/plugin\.json id is "acme\.tool"/)
  })

  it('--entry checks one file; bad usage is refused', async () => {
    const file = join(tmp, 'entry.json')
    writeFileSync(file, JSON.stringify({ ...entryAt('good'), owners: [OWNER] }))
    await expect(checkMain(['--entry', file, '--index-url', FILE_INDEX], { env: GIT_ENV })).resolves.toBeUndefined()
    await expect(checkMain([])).rejects.toThrow(/usage/)
    await expect(checkMain(['--nope', 'x'])).rejects.toThrow(/usage/)
  })

  it('--entry refuses a reserved cockpit. id without cloning anything', async () => {
    const file = join(tmp, 'entry.json')
    // The repo does not exist: a clone would report that instead.
    writeFileSync(file, JSON.stringify({ ...entryAt('good'), id: 'cockpit.tool', repo: pathToFileURL(join(tmp, 'nowhere.git')).href, owners: [OWNER] }))
    await expect(checkMain(['--entry', file, '--index-url', FILE_INDEX], { env: GIT_ENV })).rejects.toThrow(
      /check-entry: "id": ids starting with cockpit\. are reserved/
    )
  })

  it('the committed bundle works as a command, and fails with exit 1 and no stack', () => {
    const file = join(tmp, 'entry.json')
    writeFileSync(file, JSON.stringify({ ...entryAt('good'), owners: [OWNER] }))
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [join(DIST, 'check-entry.js'), '--entry', file, '--index-url', FILE_INDEX], { env: GIT_ENV, encoding: 'utf8', timeout: 25_000 })
    expect(run().status).toBe(0)
    writeFileSync(file, JSON.stringify({ ...entryAt('good', { commit: COMMIT_B }), owners: [OWNER] }))
    const failed = run()
    expect(failed.status).toBe(1)
    expect(String(failed.stderr)).toMatch(/^check-entry: the tag is at commit/)
    expect(String(failed.stderr)).not.toContain('    at ')
  }, 30_000)
})

const FILE: PullFile = { filename: 'plugins/acme.tool.json', status: 'modified' }
const PR: PullSummary = { number: 7, draft: false, authorId: OWNER, headSha: COMMIT_B, headRepo: 'fork/repo', baseRef: 'main' }
const BUMP = { version: '1.1.0', tag: 'v1.1.0', commit: COMMIT_B }

function decision(patch: Partial<DecisionInput> & { head?: Record<string, unknown>; main?: Record<string, unknown>; revoked?: unknown } = {}): ReturnType<typeof decideAutoMerge> {
  const { head, main, revoked, ...rest } = patch
  return decideAutoMerge({
    pr: PR,
    files: [FILE],
    mainEntryText: JSON.stringify(sourceEntry(main)),
    headEntryText: JSON.stringify(sourceEntry({ ...BUMP, ...head })),
    revokedText: JSON.stringify(revoked ?? []),
    ...rest
  })
}

describe('decideAutoMerge', () => {
  it('merges a routine bump, api included', () => {
    expect(decision()).toEqual({ merge: true, id: 'acme.tool' })
    expect(decision({ head: { api: 2 } }).merge).toBe(true)
  })

  it.each<[string, Parameters<typeof decision>[0], RegExp]>([
    ['a second file', { files: [FILE, { filename: 'README.md', status: 'modified' }] }, /exactly one/],
    ['a workflow edit as the second file', { files: [FILE, { filename: '.github/workflows/check.yml', status: 'modified' }] }, /exactly one/],
    ['an added file', { files: [{ ...FILE, status: 'added' }] }, /exactly one/],
    ['a renamed file', { files: [{ ...FILE, status: 'renamed' }] }, /exactly one/],
    ['a removed file', { files: [{ ...FILE, status: 'removed' }] }, /exactly one/],
    ['no files', { files: [] }, /exactly one/],
    ['a file outside plugins/', { files: [{ filename: 'tools/dist/auto-merge.js', status: 'modified' }] }, /exactly one/],
    ['a nested file', { files: [{ filename: 'plugins/a/acme.tool.json', status: 'modified' }] }, /exactly one/],
    ['an edit to owners', { head: { owners: [OWNER, 666] } }, /changes "owners"/],
    ['an edit to repo', { head: { repo: 'https://example.com/evil/tool.git' } }, /changes "repo"/],
    ['an edit to name', { head: { name: 'Totally Official' } }, /changes "name"/],
    ['an edit to description', { head: { description: 'new' } }, /changes "description"/],
    ['an edit to author', { head: { author: 'Other' } }, /changes "author"/],
    ['a non-owner', { pr: { ...PR, authorId: 666 } }, /not an owner/],
    ['an author who added themselves in the PR', { pr: { ...PR, authorId: 666 }, head: { owners: [OWNER, 666] } }, /not an owner/],
    ['a lower version', { head: { version: '0.9.0' } }, /does not increase/],
    ['the same version', { head: { version: '1.0.0' } }, /does not increase/],
    ['the same version with build metadata', { head: { version: '1.0.0+2' } }, /does not increase/],
    ['a pre-release of the current version', { head: { version: '1.0.0-rc.1' } }, /does not increase/],
    ['a revoked commit', { revoked: [{ id: 'acme.tool', commit: COMMIT_B, reason: 'bad' }] }, /revoked/],
    ['a commit revoked under another id', { revoked: [{ id: 'other.tool', commit: COMMIT_B, reason: 'bad' }] }, /revoked/],
    ['a malformed revoked.json', { revokedText: '{' }, /revoked\.json/],
    ['a revoked.json with a bad row', { revokedText: JSON.stringify([{ id: 'x' }]) }, /revoked\.json/],
    ['a missing revoked.json', { revokedText: null }, /revoked\.json/],
    ['a draft', { pr: { ...PR, draft: true } }, /draft/],
    ['another base branch', { pr: { ...PR, baseRef: 'dev' } }, /target main/],
    ['an entry missing on main', { mainEntryText: null }, /does not exist on main/],
    ['an entry unreadable at the head', { headEntryText: null }, /PR head/],
    ['an invalid entry in the PR', { head: { commit: 'nope' } }, /in the PR is invalid/],
    ['an unknown field in the PR', { head: { extra: 1 } }, /in the PR is invalid/],
    ['an id that does not match the file', { head: { id: 'other.tool' } }, /does not match/]
  ])('leaves %s for a human', (_name, patch, reason) => {
    const result = decision(patch)
    expect(result.merge).toBe(false)
    expect(result.merge === false && result.reason).toMatch(reason)
  })

  it('compares with main as it is now: a stale branch rolling back an owners edit is not a bump', () => {
    const result = decision({ main: { owners: [OWNER, 2002] } })
    expect(result.merge === false && result.reason).toMatch(/changes "owners"/)
  })
})

describe('bumpedId', () => {
  it('reads the id only from a clean file name', () => {
    expect(bumpedId([FILE])).toBe('acme.tool')
    expect(bumpedId([{ filename: 'plugins/../revoked.json', status: 'modified' }])).toBeNull()
    expect(bumpedId([{ filename: 'plugins/UPPER.tool.json', status: 'modified' }])).toBeNull()
  })
})

describe('resolvePullRequest', () => {
  it('finds the PR by head commit and repo', () => {
    const other = { ...PR, number: 8, headSha: COMMIT_A }
    expect(resolvePullRequest([other, PR], COMMIT_B, 'fork/repo')).toBe(PR)
  })

  it('finds nothing for another repo with the same commit, or a deleted fork', () => {
    expect(resolvePullRequest([PR], COMMIT_B, 'elsewhere/repo')).toBeNull()
    expect(resolvePullRequest([{ ...PR, headRepo: null }], COMMIT_B, 'fork/repo')).toBeNull()
  })

  it('finds nothing when two PRs have the commit: ambiguous', () => {
    expect(resolvePullRequest([PR, { ...PR, number: 8 }], COMMIT_B, 'fork/repo')).toBeNull()
  })
})

/** A fake GitHub answering the calls `main` makes, paging lists by `per_page`. */
function fakeGitHub(opts: {
  /** What the comparison of the two fixed commits answers. */
  files: PullFile[]
  pulls?: unknown[]
  status?: number
  /** What the PR's live file list answers: wherever the branch happens to be now. */
  liveFiles?: PullFile[]
  /** Replaces the comparison's body. */
  compare?: unknown
}): { fetch: FetchLike; urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  const pulls = opts.pulls ?? [
    { number: 7, draft: false, user: { id: OWNER }, head: { sha: COMMIT_B, repo: { full_name: 'fork/repo' } }, base: { ref: 'main' } }
  ]
  const respond = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  })
  const page = (items: unknown[], url: URL): Awaited<ReturnType<FetchLike>> => {
    const per = Number(url.searchParams.get('per_page'))
    const n = Number(url.searchParams.get('page'))
    return respond(200, items.slice((n - 1) * per, n * per))
  }
  return {
    urls,
    headers,
    fetch: (raw, init) => {
      urls.push(raw)
      headers.push(init.headers)
      const url = new URL(raw)
      if (opts.status !== undefined) return Promise.resolve(respond(opts.status, {}))
      if (url.pathname.endsWith('/pulls')) return Promise.resolve(page(pulls, url))
      if (url.pathname.endsWith('/pulls/7/files')) return Promise.resolve(page(opts.liveFiles ?? opts.files, url))
      if (url.pathname.endsWith('/git/ref/heads/main')) return Promise.resolve(respond(200, { object: { sha: MAIN_SHA } }))
      if (url.pathname.endsWith(`/compare/${MAIN_SHA}...${COMMIT_B}`)) {
        return Promise.resolve(respond(200, opts.compare ?? { files: opts.files, commits: [{ sha: COMMIT_B }], total_commits: 1 }))
      }
      if (url.pathname.endsWith('/contents/revoked.json')) return Promise.resolve(respond(200, '[]'))
      if (url.pathname.endsWith('/contents/plugins/acme.tool.json')) {
        const atHead = url.searchParams.get('ref') === COMMIT_B
        return Promise.resolve(respond(200, JSON.stringify(sourceEntry(atHead ? BUMP : {}))))
      }
      return Promise.resolve(respond(404, {}))
    }
  }
}

describe('auto-merge command', () => {
  function env(): NodeJS.ProcessEnv {
    return {
      GH_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'owner/index',
      GITHUB_OUTPUT: join(tmp, 'output'),
      HEAD_SHA: COMMIT_B,
      HEAD_REPO: 'fork/repo',
      ENTRY_FILE: join(tmp, 'entry.json')
    }
  }
  const output = (): string => readFileSync(join(tmp, 'output'), 'utf8')

  it('says merge with the PR number, and hands over the entry at the head commit', async () => {
    await autoMergeMain([], env(), fakeGitHub({ files: [FILE] }).fetch)
    expect(output()).toBe(`merge=true\nnumber=7\nbase=${MAIN_SHA}\n`)
    expect(JSON.parse(readFileSync(join(tmp, 'entry.json'), 'utf8'))).toMatchObject({ commit: COMMIT_B })
  })

  it('decides from the fixed commits: the branch moved away and back (A->B->A) does not count', async () => {
    // At B the live list is one clean file; the merge is pinned to A, whose diff also changes the tools.
    const github = fakeGitHub({
      files: [FILE, { filename: 'tools/dist/auto-merge.js', status: 'modified' }],
      liveFiles: [FILE]
    })
    await autoMergeMain([], env(), github.fetch)
    expect(output()).toBe('merge=false\n')
    expect(existsSync(join(tmp, 'entry.json'))).toBe(false)
    expect(github.urls.some((u) => u.includes('/pulls/7/files'))).toBe(false)
    expect(github.urls.some((u) => new URL(u).pathname.endsWith(`/compare/${MAIN_SHA}...${COMMIT_B}`))).toBe(true)
  })

  it('reads main at the commit it compared with, not by branch name', async () => {
    const github = fakeGitHub({ files: [FILE] })
    await autoMergeMain([], env(), github.fetch)
    const refs = github.urls.filter((u) => u.includes('/contents/')).map((u) => new URL(u).searchParams.get('ref'))
    expect(refs.sort()).toEqual([COMMIT_B, MAIN_SHA, MAIN_SHA])
  })

  it('leaves a comparison that may be partial for a human', async () => {
    // GitHub names at most 300 files, and files only on the first page of a paged answer.
    const capped = { files: Array.from({ length: 300 }, () => FILE), commits: [], total_commits: 0 }
    await autoMergeMain([], env(), fakeGitHub({ files: [FILE], compare: capped }).fetch)
    expect(output()).toBe('merge=false\n')
    rmSync(join(tmp, 'output'))
    const paged = { files: [FILE], commits: [{ sha: COMMIT_B }], total_commits: 2 }
    await autoMergeMain([], env(), fakeGitHub({ files: [FILE], compare: paged }).fetch)
    expect(output()).toBe('merge=false\n')
    expect(existsSync(join(tmp, 'entry.json'))).toBe(false)
  })

  it('fails, deciding nothing, on a comparison without a file list or a head that is not a hash', async () => {
    await expect(autoMergeMain([], env(), fakeGitHub({ files: [FILE], compare: { commits: [], total_commits: 0 } }).fetch)).rejects.toThrow(/did not answer a comparison/)
    const byBranch = [{ number: 7, draft: false, user: { id: OWNER }, head: { sha: 'patch-1', repo: { full_name: 'fork/repo' } }, base: { ref: 'main' } }]
    await expect(autoMergeMain([], { ...env(), HEAD_SHA: 'patch-1' }, fakeGitHub({ files: [FILE], pulls: byBranch }).fetch)).rejects.toThrow(/not a full commit hash/)
    expect(existsSync(join(tmp, 'output'))).toBe(false)
  })

  it('says no when no open PR has the commit, and when a list row is unreadable', async () => {
    await autoMergeMain([], env(), fakeGitHub({ files: [FILE], pulls: [] }).fetch)
    expect(output()).toBe('merge=false\n')
    rmSync(join(tmp, 'output'))
    await autoMergeMain([], env(), fakeGitHub({ files: [FILE, {} as PullFile] }).fetch)
    expect(output()).toBe('merge=false\n')
  })

  it('fails, deciding nothing, on an API error or a missing setting', async () => {
    await expect(autoMergeMain([], env(), fakeGitHub({ files: [FILE], status: 500 }).fetch)).rejects.toThrow(/answered 500/)
    expect(existsSync(join(tmp, 'output'))).toBe(false)
    await expect(autoMergeMain([], { ...env(), HEAD_SHA: '' }, fakeGitHub({ files: [FILE] }).fetch)).rejects.toThrow(/HEAD_SHA/)
  })

  it('refuses to decide from a truncated list', async () => {
    const endless: FetchLike = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(Array.from({ length: 100 }, () => ({}))), text: () => Promise.resolve('') })
    await expect(listAll({ repo: 'o/r', token: 't', fetch: endless }, '/pulls')).rejects.toThrow(/more than 100 pages/)
  })

  it('sends the token, and only to the API base', async () => {
    const github = fakeGitHub({ files: [FILE] })
    await autoMergeMain([], env(), github.fetch)
    expect(github.headers.every((h) => h.authorization === 'Bearer test-token')).toBe(true)
    expect(github.urls.every((u) => u.startsWith('https://api.github.com/repos/owner/index/'))).toBe(true)
  })

  it('ignores the environment for where the token goes', async () => {
    const github = fakeGitHub({ files: [FILE] })
    await autoMergeMain([], { ...env(), GITHUB_API_URL: 'https://evil.example' }, github.fetch)
    expect(github.urls.every((u) => u.startsWith('https://api.github.com/'))).toBe(true)
  })
})

describe('the committed tools', () => {
  it('dist is what a fresh build of src produces', () => {
    const out = join(tmp, 'dist')
    // A synchronous call is out of reach of vitest's timeout: its own timeout makes a hung build fail.
    execFileSync(process.execPath, [join(REPO, 'scripts/build-marketplace-tools.mjs'), out], { cwd: '/', stdio: 'pipe', timeout: 25_000 })
    for (const tool of ['build-index', 'check-entry', 'auto-merge']) {
      const fresh = readFileSync(join(out, `${tool}.js`))
      // Not toEqual on the buffers: a failure would print both files.
      expect(fresh.equals(readFileSync(join(DIST, `${tool}.js`))), `stale ${tool}.js: run \`npm run build:marketplace-tools\``).toBe(true)
      const text = fresh.toString()
      expect(text).not.toContain(REPO)
      // Self-contained: the index repo has no node_modules and no src/ to import from.
      expect(text).not.toMatch(/require\(["'](\.|\/|electron|ajv)/)
    }
  }, 30_000)

  it('build-index runs as a command', () => {
    const root = indexRepo(join(tmp, 'index'), [sourceEntry()])
    const out = join(tmp, 'index.json')
    const ok = spawnSync(process.execPath, [join(DIST, 'build-index.js'), '--root', root, '--out', out], { encoding: 'utf8', timeout: 25_000 })
    expect(ok.status).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8')).plugins[0]).not.toHaveProperty('owners')
    const failed = spawnSync(process.execPath, [join(DIST, 'build-index.js'), '--root', join(tmp, 'nope'), '--out', out], { encoding: 'utf8', timeout: 25_000 })
    expect(failed.status).toBe(1)
  }, 30_000)

  it('build-index with a bad entry writes the index and exits PARTIAL_EXIT, which the workflow pushes and then fails on', () => {
    const root = indexRepo(join(tmp, 'index'), [sourceEntry({ id: 'bad.tool', commit: 'nope' }), sourceEntry()], [{ id: 'x.y', commit: COMMIT_A, reason: 'bad' }])
    const out = join(tmp, 'index.json')
    const run = spawnSync(process.execPath, [join(DIST, 'build-index.js'), '--root', root, '--out', out], { encoding: 'utf8', timeout: 25_000 })
    expect(run.status).toBe(PARTIAL_EXIT)
    expect(run.stderr).toMatch(/bad\.tool\.json/)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ plugins: [{ id: 'acme.tool' }], revoked: [{ id: 'x.y' }] })
    // The same number the workflow's shell tests for.
    expect(readFileSync(join(TEMPLATE, '.github/workflows/publish-index.yml'), 'utf8')).toContain(`"$status" -ne ${PARTIAL_EXIT}`)
  }, 30_000)

  it('build-index --base exits 0 for a bad entry already on the base, and still fails for one the PR adds', () => {
    const bad = sourceEntry({ id: 'bad.tool', commit: 'nope' })
    const base = indexRepo(join(tmp, 'base'), [bad])
    const head = indexRepo(join(tmp, 'head'), [bad], [{ id: 'x.y', commit: COMMIT_A, reason: 'bad' }])
    const out = join(tmp, 'index.json')
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [join(DIST, 'build-index.js'), '--root', head, '--out', out, '--base', base], { encoding: 'utf8', timeout: 25_000 })
    const inherited = run()
    expect(inherited.status).toBe(0)
    expect(String(inherited.stderr)).toMatch(/already on the base.*bad\.tool\.json/)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ revoked: [{ id: 'x.y' }] })
    writeFileSync(join(head, 'plugins/new.tool.json'), JSON.stringify(sourceEntry({ id: 'new.tool', commit: 'nope' })))
    const added = run()
    expect(added.status).toBe(PARTIAL_EXIT)
    expect(String(added.stderr)).toMatch(/new\.tool\.json/)
  }, 30_000)
})

describe('the workflows', () => {
  const workflow = (name: string): string => readFileSync(join(TEMPLATE, '.github/workflows', name), 'utf8')
  // Comments out: they name `pull_request_target` to forbid it.
  const code = (text: string): string => text.replace(/^\s*#.*$/gm, '')

  interface Step {
    name?: string
    id?: string
    uses?: string
    if?: string
    run?: string
    env?: Record<string, string>
    with?: Record<string, unknown>
  }
  interface Job {
    if?: string
    needs?: string
    uses?: string
    secrets?: Record<string, string>
    permissions?: Record<string, string>
    steps?: Step[]
  }
  interface Workflow {
    on: Record<string, unknown>
    permissions?: Record<string, string>
    jobs: Record<string, Job>
  }
  // Parsed, so a reordered step or a condition gone wrong fails. js-yaml reads the `on` key as a string
  // (YAML 1.2 core), unlike the YAML 1.1 parsers that make it `true`.
  const parsed = (name: string): Workflow => parseYaml(workflow(name)) as Workflow
  const stepIndex = (steps: Step[], name: string): number => {
    const i = steps.findIndex((s) => s.name === name)
    expect(i, name).toBeGreaterThanOrEqual(0)
    return i
  }

  it('check runs on pull_request, read-only, with no secrets and the base commit’s tools', () => {
    const w = parsed('check.yml')
    expect(Object.keys(w.on)).toEqual(['pull_request'])
    expect(w.permissions).toEqual({ contents: 'read' })
    const job = w.jobs.check!
    expect(job.permissions).toBeUndefined()
    const text = code(workflow('check.yml'))
    expect(text).not.toContain('secrets.')
    expect(text).not.toContain('github.token')
    const runs = job.steps!.flatMap((s) => (s.run !== undefined ? [s.run] : []))
    expect(runs).toEqual([
      // The grace date is read from the base: a PR cannot move it.
      `node base/tools/dist/check-entry.js --base base --head pr --preview-required-from "$(jq -r '.requiredFrom // "none"' base/preview-policy.json)"`,
      'node base/tools/dist/build-index.js --root pr --out "$RUNNER_TEMP/index.json" --base base'
    ])
    // The tools' checkout is pinned to the base commit and neither one keeps a credential.
    const checkouts = job.steps!.filter((s) => s.uses?.startsWith('actions/checkout'))
    expect(checkouts[0]!.with).toMatchObject({ ref: '${{ github.event.pull_request.base.sha }}', path: 'base', 'persist-credentials': false })
    expect(checkouts[1]!.with).toMatchObject({ path: 'pr', 'persist-credentials': false })
  })

  it('auto-merge starts from no permissions, decides, re-checks with no token, then merges pinned to the sha', () => {
    const w = parsed('auto-merge.yml')
    expect(Object.keys(w.on)).toEqual(['workflow_run'])
    expect(w.permissions).toEqual({})
    const job = w.jobs.merge!
    expect(job.permissions).toEqual({ contents: 'write', 'pull-requests': 'read' })
    // A condition that is always true would run this on a failed check or on any workflow named check.
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(job.if).toContain("github.event.workflow_run.event == 'pull_request'")
    expect(job.if).toContain("github.event.workflow_run.path == '.github/workflows/check.yml'")
    const steps = job.steps!
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with).toMatchObject({ ref: 'main', 'persist-credentials': false })
    const decide = stepIndex(steps, 'Decide')
    const recheck = stepIndex(steps, 'Re-check the entry')
    const merge = stepIndex(steps, 'Merge')
    expect(decide).toBeLessThan(recheck)
    expect(recheck).toBeLessThan(merge)
    expect(steps[decide]!.run).toBe('node tools/dist/auto-merge.js')
    // It clones a repo somebody else controls: nothing in this step may hold the token.
    expect(steps[recheck]!.run).toContain('check-entry.js')
    expect(Object.keys(steps[recheck]!.env!)).toEqual(['ENTRY_FILE'])
    expect(steps[recheck]!.if).toBe("steps.decide.outputs.merge == 'true'")
    expect(steps[merge]!.if).toBe("steps.decide.outputs.merge == 'true'")
    expect(steps[merge]!.run).toMatch(/pulls\/\$PR_NUMBER\/merge" -f sha="\$HEAD_SHA"/)
    // Untrusted event values reach the shell through env only.
    for (const step of steps) expect(step.run ?? '', step.name).not.toContain('${{')
    expect(w.jobs.publish).toMatchObject({ needs: 'merge', uses: './.github/workflows/publish-index.yml', if: "needs.merge.outputs.merged == 'true'" })
  })

  describe('the Merge step', () => {
    const OTHER_SHA = 'd'.repeat(40)
    /** Runs the step's real script the way Actions does (`bash -e`), with a fake `gh` that logs every call. */
    function runMerge(opts: { mainNow: string; refFails?: boolean; base?: string }): { status: number | null; calls: string[]; output: string } {
      const steps = parsed('auto-merge.yml').jobs.merge!.steps!
      const step = steps[stepIndex(steps, 'Merge')]!
      expect(step.env!.BASE_SHA).toBe('${{ steps.decide.outputs.base }}')
      const bin = join(tmp, 'bin')
      mkdirSync(bin)
      const log = join(tmp, 'gh.log')
      writeFileSync(
        join(bin, 'gh'),
        [
          '#!/usr/bin/env bash',
          `echo "$*" >> ${JSON.stringify(log)}`,
          'case "$*" in',
          `  *git/ref/heads/main*) ${opts.refFails === true ? 'exit 1' : `echo ${opts.mainNow}`} ;;`,
          'esac'
        ].join('\n'),
        { mode: 0o755 }
      )
      const outFile = join(tmp, 'gh-output')
      writeFileSync(outFile, '')
      const r = spawnSync('bash', ['-e', '-c', step.run!], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'owner/index',
          GITHUB_OUTPUT: outFile,
          PR_NUMBER: '7',
          HEAD_SHA: COMMIT_B,
          BASE_SHA: opts.base ?? MAIN_SHA
        }
      })
      return {
        status: r.status,
        calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
        output: readFileSync(outFile, 'utf8')
      }
    }
    const mergeCalls = (calls: string[]): string[] => calls.filter((c) => c.includes('/merge'))

    it('merges, pinned to the head, when main is still the commit the decision read', () => {
      const r = runMerge({ mainNow: MAIN_SHA })
      expect(r.status).toBe(0)
      expect(r.calls[0]).toContain('git/ref/heads/main')
      expect(mergeCalls(r.calls)).toHaveLength(1)
      expect(mergeCalls(r.calls)[0]).toContain(`sha=${COMMIT_B}`)
      expect(r.output).toBe('merged=true\n')
    })

    it('leaves the PR for a human when main moved after the decision: an owner may have been removed', () => {
      const r = runMerge({ mainNow: OTHER_SHA })
      expect(r.status).toBe(0)
      expect(mergeCalls(r.calls)).toEqual([])
      expect(r.output).toBe('')
    })

    it('does not merge when main cannot be read, or no base was handed over', () => {
      const failed = runMerge({ mainNow: MAIN_SHA, refFails: true })
      expect(failed.status).not.toBe(0)
      expect(mergeCalls(failed.calls)).toEqual([])
      rmSync(join(tmp, 'bin'), { recursive: true })
      rmSync(join(tmp, 'gh.log'))
      const noBase = runMerge({ mainNow: MAIN_SHA, base: '' })
      expect(mergeCalls(noBase.calls)).toEqual([])
      expect(noBase.output).toBe('')
    })
  })

  it('publish runs on a push, on a schedule and when called, and its own output cannot retrigger it', () => {
    const w = parsed('publish-index.yml')
    expect(Object.keys(w.on).sort()).toEqual(['push', 'schedule', 'workflow_call', 'workflow_dispatch'])
    const push = w.on.push as { branches: string[]; paths: string[] }
    expect(push.branches).toEqual(['main'])
    expect(push.paths).not.toContain('index.json')
    expect(push.paths).toContain('revoked.json')
    expect(w.permissions).toEqual({ contents: 'read' })
    const steps = w.jobs.publish!.steps!
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with).toMatchObject({ ref: 'main', token: '${{ secrets.PUBLISH_TOKEN }}' })
  })

  it('publish fetches previews in a job with no token, and publishes even when that job fails', () => {
    const w = parsed('publish-index.yml')
    const previews = w.jobs.previews!
    // It clones repos somebody else controls: no secret and no credential anywhere in the job.
    expect(JSON.stringify(previews)).not.toMatch(/secrets\.|github\.token/)
    expect(previews.permissions).toBeUndefined()
    expect(previews.steps!.find((s) => s.uses?.startsWith('actions/checkout'))?.with).toMatchObject({ 'persist-credentials': false })
    const fetch = previews.steps![stepIndex(previews.steps!, 'Fetch missing previews')]!
    expect(fetch.run).toContain('node tools/dist/check-entry.js --fetch-previews . --out "$RUNNER_TEMP/fetched"')
    expect((fetch as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
    // The job outlasts the tool's budget plus one last clone and rev-parse, with room for setup: a job
    // killed by its timeout never uploads what it fetched.
    const jobMs = (previews as { 'timeout-minutes'?: number })['timeout-minutes']! * 60_000
    expect(jobMs).toBeGreaterThanOrEqual(PREVIEW_FETCH_BUDGET_MS + 2 * PREVIEW_CLONE_TIMEOUT_MS + 5 * 60_000)
    const publish = w.jobs.publish!
    expect(publish.needs).toBe('previews')
    // A preview must never hold a revocation back.
    expect(publish.if).toBe('${{ !cancelled() }}')
    const build = publish.steps![stepIndex(publish.steps!, 'Build and push index.json')]!
    expect(build.run).toContain('git add previews')
    // The publish job, which holds the token, never clones a listed repo.
    expect(publish.steps!.map((s) => s.run ?? '').join('\n')).not.toContain('check-entry')
    // The auto-merge re-check reads the same policy file, from main.
    const recheck = parsed('auto-merge.yml').jobs.merge!.steps!.find((s) => s.name === 'Re-check the entry')!
    expect(recheck.run).toContain(`--preview-required-from "$(jq -r '.requiredFrom // "none"' preview-policy.json)"`)
    expect(JSON.parse(readFileSync(join(TEMPLATE, 'preview-policy.json'), 'utf8'))).toEqual({ requiredFrom: null })
  })

  // Pinned to a commit, as the app's workflows are: publish-index holds PUBLISH_TOKEN, and a tag
  // (`@v4`) can be moved to other code. setup-node v5+ caches by itself once package.json names a
  // packageManager, so it is told not to.
  it('every action is first-party and pinned to a commit; setup-node never caches', () => {
    for (const name of ['check.yml', 'auto-merge.yml', 'publish-index.yml']) {
      for (const match of code(workflow(name)).matchAll(/uses:\s*(\S+)/g)) {
        expect(match[1]).toMatch(/^(actions\/[a-z-]+@[0-9a-f]{40}$|\.\/\.github\/workflows\/)/)
      }
      const nodes = code(workflow(name)).match(/uses:\s*actions\/setup-node@/g) ?? []
      expect(code(workflow(name)).match(/package-manager-cache: false/g) ?? []).toHaveLength(nodes.length)
    }
  })
})
