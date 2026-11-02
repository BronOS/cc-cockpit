// Plugin marketplace, Task 5: the Marketplace view and the install/update/refresh/setUrls calls in
// SettingsService. A real MarketplaceService over a temp dir and a fake fetcher; the installer is a fake
// that records what main handed it, since the point is that repo, tag and commit come from main's state.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MARKETPLACE_URL } from '../../src/shared/marketplace'
import { createIndexFetcher } from '../../src/main/marketplace/fetch-index'
import { MarketplaceService } from '../../src/main/marketplace/marketplace-service'
import { revocationNotice } from '../../src/main/marketplace/marketplace-view'
import { PluginInstaller, type InstallPin, type InstalledPlugin } from '../../src/main/plugins/installer'
import { PluginIndex, type PluginEntry } from '../../src/main/plugins/plugin-index'
import { SettingsService, type SettingsDeps } from '../../src/main/settings/settings-service'
import { ThemeService } from '../../src/main/themes/theme-service'

const A = 'https://a.example/index.json'
const B = 'https://b.example/index.json'
const c = (n: string): string => n.repeat(40)
const REPO = 'https://github.com/x/jira.git'
/** What the confirmation shows for the default listing below. */
const SHOWN = { repo: REPO, commit: c('a') }

interface Listing {
  id?: string
  version?: string
  commit?: string
  repo?: string
  api?: number
}
function entry(l: Listing = {}): Record<string, unknown> {
  return {
    id: l.id ?? 'bronos.jira',
    name: 'Jira',
    description: 'd',
    author: 'me',
    repo: l.repo ?? REPO,
    version: l.version ?? '1.1.0',
    tag: `v${l.version ?? '1.1.0'}`,
    commit: l.commit ?? c('a'),
    api: l.api ?? 1
  }
}
const indexOf = (plugins: Listing[], revoked: { id: string; commit: string }[] = []): string =>
  JSON.stringify({ schema: 1, plugins: plugins.map(entry), revoked: revoked.map((r) => ({ ...r, reason: 'bad' })) })

function installedGit(over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'bronos.jira',
    version: '1.0.0',
    source: { kind: 'git', url: REPO, tag: 'v1.0.0' },
    state: { ok: true },
    dir: '/p/jira',
    themes: [],
    commit: c('1'),
    marketplace: A,
    ...over
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig(opts: {
  texts: Record<string, string>
  installed?: InstalledPlugin[]
  urls?: string[]
  repos?: Record<string, string>
  /** Ids a project still has on. */
  enabled?: string[]
  /** The durable write of the switches fails. */
  failDisable?: boolean
  /** The durable write of the repository history fails. */
  failRepoWrite?: boolean
  /** The clone is refused: the fake throws where the real installer does, before `beforeRecord`. */
  refuseInstall?: boolean
  /** Runs where the real installer waits its turn and clones: operations queued ahead of the install finish here. */
  whileQueued?: (repos: Record<string, string>) => void | Promise<void>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-mkt-view-'))
  dirs.push(dir)
  let urls = opts.urls ?? Object.keys(opts.texts)
  const texts = opts.texts
  const fetched: string[] = []
  const repos = { ...(opts.repos ?? {}) }
  const disabled: string[] = []
  // In call order, so a test can say the switches moved before the plugin's hosts would start.
  const order: string[] = []
  const marketplace = new MarketplaceService({
    dataDir: dir,
    urls: () => urls,
    authorities: () => (opts.installed ?? []).flatMap((p) => (p.marketplace !== undefined ? [p.marketplace] : [])),
    fetcher: async (u) => {
      fetched.push(u)
      const t = texts[u]
      if (t === undefined) throw new Error('offline')
      return t
    }
  })
  await marketplace.refresh()
  const installed = opts.installed ?? []
  const calls: unknown[][] = []
  const stored: string[][] = []
  const service = new SettingsService({
    projects: { list: () => [], get: () => undefined, relink: () => { throw new Error('unused') }, forget: () => {}, update: () => {} },
    hasWindow: () => false,
    openProjectPath: () => {},
    pickFolder: async () => undefined,
    plugins: {
      applyRevocations: async () => {},
      list: () => installed,
      get: (id) => installed.find((p) => p.id === id),
      install: async (url: string, tag: string, pin?: InstallPin, beforeRecord?: (entry: PluginEntry) => void) => {
        calls.push(['install', url, tag, pin])
        if (opts.refuseInstall) throw new Error('the tag is at another commit')
        await opts.whileQueued?.(repos)
        beforeRecord?.({ id: pin?.id ?? 'bronos.jira', version: pin?.version ?? '0', source: { kind: 'git', url, tag }, state: { ok: true } })
        order.push('hosts reload')
        return installedGit({ version: pin?.version ?? '0' })
      },
      update: async (id: string, tag: string, pin?: InstallPin, beforeRecord?: (entry: PluginEntry) => void) => {
        calls.push(['update', id, tag, pin])
        opts.whileQueued?.(repos)
        beforeRecord?.(installedGit({ version: pin?.version ?? '0' }))
        order.push('hosts reload')
        return installedGit({ version: pin?.version ?? '0' })
      },
      link: async () => installedGit(),
      uninstall: async (id: string, beforeRemove?: (entry: PluginEntry) => void) => {
        const found = installed.find((p) => p.id === id)
        if (found) beforeRemove?.(found)
        calls.push(['uninstall', id])
      }
    },
    marketplace,
    pluginRepos: {
      get: (id) => repos[id],
      set: (id, r) => {
        if (opts.failRepoWrite) throw new Error('app.json could not be written')
        repos[id] = r
      }
    },
    disableEverywhere: (id) => {
      if (opts.failDisable) throw new Error('cannot turn it off')
      disabled.push(id)
      order.push('disabled')
    },
    enabledInAProject: (id) => (opts.enabled ?? []).includes(id),
    setMarketplaceUrls: (u) => {
      stored.push(u)
      urls = u
    },
    appPluginSettings: { get: () => undefined, set: () => {} },
    pluginSettingsChanged: async () => {},
    secrets: { hasSetting: () => false, settingsGuard: () => ({ removals: undefined, forgets: new Map() }), checkSettingsGuard: () => {}, writeSettings: async () => {} }
  })
  return { service, calls, stored, texts, fetched, repos, disabled, order }
}

const statusOf = (v: { entries: { indexUrl: string; id: string; status: string; action: string | null; repoChangedFrom?: string }[] }, url = A, id = 'bronos.jira') =>
  v.entries.find((e) => e.indexUrl === url && e.id === id)

describe('marketplace view statuses', () => {
  it('available when nothing is installed', async () => {
    const { service } = await rig({ texts: { [A]: indexOf([{}]) } })
    expect(statusOf(service.marketplace())).toMatchObject({ status: 'available', action: 'install' })
  })

  it('a version differing only in case is not an update', async () => {
    const { service } = await rig({
      texts: { [A]: indexOf([{ version: '1.0.0-RC' }]) },
      installed: [installedGit({ version: '1.0.0-rc' })]
    })
    expect(statusOf(service.marketplace())).toMatchObject({ status: 'installed', action: null })
  })

  it('shows the tag and commit an install would use', async () => {
    const { service } = await rig({ texts: { [A]: indexOf([{}]) } })
    expect(statusOf(service.marketplace())).toMatchObject({ tag: 'v1.1.0', commit: c('a') })
  })

  it('installed at the same version, update available when newer, no downgrade offered', async () => {
    let r = await rig({ texts: { [A]: indexOf([{ version: '1.0.0' }]) }, installed: [installedGit()] })
    expect(statusOf(r.service.marketplace())).toMatchObject({ status: 'installed', action: null, installedVersion: '1.0.0' })
    r = await rig({ texts: { [A]: indexOf([{ version: '1.1.0' }]) }, installed: [installedGit()] })
    expect(statusOf(r.service.marketplace())).toMatchObject({ status: 'update', action: 'update' })
    r = await rig({ texts: { [A]: indexOf([{ version: '0.9.0' }]) }, installed: [installedGit()] })
    expect(statusOf(r.service.marketplace())).toMatchObject({ status: 'installed', action: null })
  })

  it('built-in and linked ids have no button', async () => {
    const bundled: InstalledPlugin = { ...installedGit(), source: { kind: 'bundled', path: '/b' } }
    delete bundled.marketplace
    delete bundled.commit
    let r = await rig({ texts: { [A]: indexOf([{}]) }, installed: [bundled] })
    expect(statusOf(r.service.marketplace())).toMatchObject({ status: 'built-in', action: null })
    const linked: InstalledPlugin = { ...bundled, source: { kind: 'linked', path: '/l' } }
    r = await rig({ texts: { [A]: indexOf([{}]) }, installed: [linked] })
    expect(statusOf(r.service.marketplace())).toMatchObject({ status: 'linked', action: null })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/linked/)
    expect(r.calls).toEqual([])
  })

  it('a changed repo offers no update and says so', async () => {
    const { service } = await rig({ texts: { [A]: indexOf([{ repo: 'https://github.com/evil/jira.git' }]) }, installed: [installedGit()] })
    const e = statusOf(service.marketplace())
    expect(e).toMatchObject({ status: 'repo-changed', action: null })
    expect(e && 'note' in e && e.note).toMatch(/different repository/)
  })

  it('the same id in two indexes: update only from the recorded one', async () => {
    const { service } = await rig({ texts: { [A]: indexOf([{}]), [B]: indexOf([{ version: '2.0.0', commit: c('b') }]) }, installed: [installedGit()] })
    const v = service.marketplace()
    expect(statusOf(v, A)).toMatchObject({ status: 'update', action: 'update' })
    expect(statusOf(v, B)).toMatchObject({ status: 'installed', action: null })
    await expect(service.updateMarketplace(B, 'bronos.jira', SHOWN)).rejects.toThrow(/another marketplace/)
  })

  it('available in both indexes when not installed', async () => {
    const { service } = await rig({ texts: { [A]: indexOf([{}]), [B]: indexOf([{ commit: c('b') }]) } })
    const v = service.marketplace()
    expect(statusOf(v, A)?.action).toBe('install')
    expect(statusOf(v, B)?.action).toBe('install')
  })

  it('leaves out an incompatible api and counts it', async () => {
    const { service } = await rig({ texts: { [A]: indexOf([{}, { id: 'bronos.new', api: 2 }]) } })
    const v = service.marketplace()
    expect(v.entries.map((e) => e.id)).toEqual(['bronos.jira'])
    expect(v.indexes[0]).toMatchObject({ url: A, incompatible: 1, error: null })
  })

  it('a revoked listing is not installable', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}], [{ id: 'bronos.jira', commit: c('a') }]) } })
    expect(statusOf(service.marketplace())).toMatchObject({ status: 'revoked', action: null, revokedReason: 'bad' })
    await expect(service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/revoked/)
    expect(calls).toEqual([])
  })

  it('a revoked plugin moves to an older non-revoked version, a downgrade included', async () => {
    const installed = installedGit({ version: '2.0.0', commit: c('2'), state: { ok: false, reason: 'revoked', revoked: { reason: 'bad', source: A } } })
    const { service, calls } = await rig({ texts: { [A]: indexOf([{ version: '1.5.0', commit: c('5') }], [{ id: 'bronos.jira', commit: c('2') }]) }, installed: [installed] })
    expect(statusOf(service.marketplace())).toMatchObject({ status: 'revoked', action: 'update', revokedReason: 'bad' })
    await service.updateMarketplace(A, 'bronos.jira', { repo: REPO, commit: c('5') })
    expect(calls).toEqual([['update', 'bronos.jira', 'v1.5.0', { commit: c('5'), id: 'bronos.jira', version: '1.5.0', marketplace: A }]])
  })

  it('a revoked plugin with only its own commit listed has no button', async () => {
    const installed = installedGit({ commit: c('a'), state: { ok: false, reason: 'revoked', revoked: { reason: 'bad', source: A } } })
    const { service } = await rig({ texts: { [A]: indexOf([{ commit: c('a') }], [{ id: 'bronos.jira', commit: c('a') }]) }, installed: [installed] })
    expect(statusOf(service.marketplace())).toMatchObject({ status: 'revoked', action: null })
  })

  it('carries per-index errors and skipped counts, and keeps the last good listing', async () => {
    const r = await rig({ texts: { [A]: indexOf([{}]), [B]: '{"schema":1,"plugins":[{"id":"x"}],"revoked":[]}' } })
    r.texts[A] = 'not json'
    const v = await r.service.refreshMarketplace()
    expect(v.indexes.find((i) => i.url === A)?.error).not.toBeNull()
    expect(statusOf(v, A)).toMatchObject({ status: 'available' })
    expect(v.indexes.find((i) => i.url === B)).toMatchObject({ skippedEntries: 1, error: null })
  })

  it('warns about a revocation from an index without authority, without disabling', async () => {
    const { service } = await rig({
      texts: { [A]: indexOf([{}]), [B]: indexOf([], [{ id: 'bronos.jira', commit: c('1') }]) },
      installed: [installedGit()]
    })
    const v = service.marketplace()
    expect(v.warnings).toEqual([{ pluginId: 'bronos.jira', pluginName: 'bronos.jira', reason: 'bad', source: B }])
    expect(statusOf(v, A)?.status).toBe('update')
  })
})

describe('marketplace install and update', () => {
  it('hands the installer main\'s own repo, tag and pin', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}]) } })
    await service.installMarketplace(A, 'bronos.jira', SHOWN)
    expect(calls).toEqual([['install', REPO, 'v1.1.0', { commit: c('a'), id: 'bronos.jira', version: '1.1.0', marketplace: A }]])
  })

  it('refuses when the pin differs from what the confirmation showed', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}]) } })
    await expect(service.installMarketplace(A, 'bronos.jira', { repo: REPO, commit: c('b') })).rejects.toThrow(/changed in the marketplace/)
    await expect(service.installMarketplace(A, 'bronos.jira', { repo: 'https://github.com/evil/jira.git', commit: c('a') })).rejects.toThrow(
      /changed in the marketplace/
    )
    expect(calls).toEqual([])
    await service.installMarketplace(A, 'bronos.jira', { repo: REPO, commit: c('a') })
    expect(calls).toHaveLength(1)
  })

  it('refuses a call that does not say what was shown: there is no unconfirmed path', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}]) }, installed: [] })
    for (const nothing of [undefined, null, {}]) {
      await expect(service.installMarketplace(A, 'bronos.jira', nothing)).rejects.toThrow(/changed in the marketplace/)
    }
    const up = await rig({ texts: { [A]: indexOf([{}]) }, installed: [installedGit()] })
    await expect(up.service.updateMarketplace(A, 'bronos.jira', undefined)).rejects.toThrow(/changed in the marketplace/)
    expect(calls).toEqual([])
    expect(up.calls).toEqual([])
  })

  it('updates an installed plugin from its recorded index', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}]) }, installed: [installedGit()] })
    await service.updateMarketplace(A, 'bronos.jira', SHOWN)
    expect(calls[0]).toEqual(['update', 'bronos.jira', 'v1.1.0', { commit: c('a'), id: 'bronos.jira', version: '1.1.0', marketplace: A }])
  })

  it('refuses an unknown entry, an unknown index and wrong types', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}]) } })
    await expect(service.installMarketplace(A, 'bronos.nope', SHOWN)).rejects.toThrow(/unknown marketplace entry/)
    await expect(service.installMarketplace(B, 'bronos.jira', SHOWN)).rejects.toThrow(/unknown marketplace entry/)
    await expect(service.installMarketplace(5, 'bronos.jira', SHOWN)).rejects.toThrow(/give the index/)
    await expect(service.updateMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/cannot be updated/)
    expect(calls).toEqual([])
  })

  it('refuses an install of a built-in id', async () => {
    const bundled: InstalledPlugin = { ...installedGit(), source: { kind: 'bundled', path: '/b' } }
    const { service, calls } = await rig({ texts: { [A]: indexOf([{}]) }, installed: [bundled] })
    await expect(service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/built in/)
    expect(calls).toEqual([])
  })

  it('refuses an update through a changed repo', async () => {
    const { service, calls } = await rig({ texts: { [A]: indexOf([{ repo: 'https://github.com/evil/jira.git' }]) }, installed: [installedGit()] })
    await expect(service.updateMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/different repository/)
    expect(calls).toEqual([])
  })
})

describe('repo change after an uninstall', () => {
  it('flags the listing and switches the id off in every project on install', async () => {
    const r = await rig({ texts: { [A]: indexOf([{}]) }, repos: { 'bronos.jira': 'https://github.com/old/jira.git' } })
    expect(statusOf(r.service.marketplace())).toMatchObject({ action: 'install', repoChangedFrom: 'https://github.com/old/jira.git' })
    await r.service.installMarketplace(A, 'bronos.jira', SHOWN)
    expect(r.disabled).toEqual(['bronos.jira'])
    expect(r.repos['bronos.jira']).toBe(REPO)
    expect(r.order).toEqual(['disabled', 'hosts reload'])
  })

  it('a repository recorded while the install waits in the queue still switches the id off', async () => {
    // The view said same repository; an install from elsewhere and its uninstall ran ahead of this one.
    const r = await rig({
      texts: { [A]: indexOf([{}]) },
      repos: { 'bronos.jira': REPO },
      whileQueued: (repos) => {
        repos['bronos.jira'] = 'https://github.com/other/jira.git'
      }
    })
    expect(statusOf(r.service.marketplace())?.repoChangedFrom).toBeUndefined()
    await r.service.installMarketplace(A, 'bronos.jira', SHOWN)
    expect(r.disabled).toEqual(['bronos.jira'])
    expect(r.order).toEqual(['disabled', 'hosts reload'])
  })

  it('a failed write of the repository refuses the install, the marketplace one and the git URL one', async () => {
    const r = await rig({ texts: { [A]: indexOf([{}]) }, failRepoWrite: true })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/could not be written/)
    await expect(r.service.installPlugin(REPO, 'v1.1.0')).rejects.toThrow(/could not be written/)
    // Refused before the record: no host ever heard of it.
    expect(r.order).toEqual([])
    expect(r.repos['bronos.jira']).toBeUndefined()
  })

  it('switches go off before the history moves: a failed write of the switches leaves a retry seeing the change', async () => {
    const old = 'https://github.com/old/jira.git'
    const r = await rig({ texts: { [A]: indexOf([{}]) }, repos: { 'bronos.jira': old }, failDisable: true })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow()
    expect(statusOf(r.service.marketplace())?.repoChangedFrom).toBe(old)
  })

  it('a git URL install records where it came from', async () => {
    const r = await rig({ texts: {}, urls: [] })
    await r.service.installPlugin(REPO, 'v1.1.0')
    expect(r.repos['bronos.jira']).toBe(REPO)
  })

  it('an uninstall corrects history that lost a write, while the record still says what ran', async () => {
    const old = 'https://github.com/old/jira.git'
    const r = await rig({ texts: {}, urls: [], installed: [installedGit()], repos: { 'bronos.jira': old } })
    await r.service.uninstallPlugin('bronos.jira')
    expect(r.repos['bronos.jira']).toBe(REPO)
    expect(r.calls).toContainEqual(['uninstall', 'bronos.jira'])
  })

  it('an uninstall whose correction cannot be written still uninstalls and logs; with nothing to correct it needs no write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const old = 'https://github.com/old/jira.git'
      const stale = await rig({ texts: {}, urls: [], installed: [installedGit()], repos: { 'bronos.jira': old }, failRepoWrite: true })
      await stale.service.uninstallPlugin('bronos.jira')
      expect(stale.calls).toContainEqual(['uninstall', 'bronos.jira'])
      expect(stale.repos['bronos.jira']).toBe(old)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/bronos\.jira.*could not be written/)
      // A read-only app.json loads as defaults: no history at all, so every git plugin looks uncorrected.
      const none = await rig({ texts: {}, urls: [], installed: [installedGit()], failRepoWrite: true })
      await none.service.uninstallPlugin('bronos.jira')
      expect(none.calls).toContainEqual(['uninstall', 'bronos.jira'])
    } finally {
      warn.mockRestore()
    }
    const same = await rig({ texts: {}, urls: [], installed: [installedGit()], repos: { 'bronos.jira': REPO }, failRepoWrite: true })
    await same.service.uninstallPlugin('bronos.jira')
    expect(same.calls).toContainEqual(['uninstall', 'bronos.jira'])
  })

  it('a refused install leaves the switches and the record alone', async () => {
    const old = 'https://github.com/old/jira.git'
    const r = await rig({ texts: { [A]: indexOf([{}]) }, repos: { 'bronos.jira': old }, refuseInstall: true })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/another commit/)
    expect(r.disabled).toEqual([])
    expect(r.repos['bronos.jira']).toBe(old)
  })

  it('a failed write of the switches fails the install', async () => {
    const old = 'https://github.com/old/jira.git'
    const r = await rig({ texts: { [A]: indexOf([{}]) }, repos: { 'bronos.jira': old }, failDisable: true })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/cannot turn it off/)
    expect(r.order).toEqual([])
    expect(r.repos['bronos.jira']).toBe(old)
  })

  it('an id still on in a project with no recorded repo counts as a change', async () => {
    const r = await rig({ texts: { [A]: indexOf([{}]) }, enabled: ['bronos.jira'] })
    const e = statusOf(r.service.marketplace())
    expect(e).toMatchObject({ action: 'install', repoChangedFrom: 'an unrecorded repository' })
    await r.service.installMarketplace(A, 'bronos.jira', SHOWN)
    expect(r.disabled).toEqual(['bronos.jira'])
  })

  it('leaves enablement alone when the repository is the same or unknown', async () => {
    const same = await rig({ texts: { [A]: indexOf([{}]) }, repos: { 'bronos.jira': REPO } })
    expect(statusOf(same.service.marketplace())?.repoChangedFrom).toBeUndefined()
    await same.service.installMarketplace(A, 'bronos.jira', SHOWN)
    const fresh = await rig({ texts: { [A]: indexOf([{}]) } })
    await fresh.service.installMarketplace(A, 'bronos.jira', SHOWN)
    expect(same.disabled).toEqual([])
    expect(fresh.disabled).toEqual([])
  })
})

describe('the revocation notification', () => {
  it('is one plain, capped line per plugin, whatever the index wrote', () => {
    const text = revocationNotice([
      { id: 'a.b', revoked: { reason: `<a href="https://evil">click</a>\n\u202espoof ${'x'.repeat(500)}`, source: A } },
      { id: 'c.d', revoked: { reason: 'bad', source: B } }
    ])
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).not.toMatch(/[<>\u202e]/)
    expect(lines[0]!.length).toBeLessThan(300)
    expect(lines[0]).toMatch(/^Plugin a\.b was stopped: a href="https:\/\/evil"click\/a spoof x+… \(revoked by /)
    expect(lines[1]).toBe(`Plugin c.d was stopped: bad (revoked by ${B})`)
  })
})

describe('an update asked again in the installer queue', () => {
  it('refuses a listing that is no longer newer once an earlier operation installed past it', async () => {
    const installed = [installedGit()]
    const r = await rig({
      texts: { [A]: indexOf([{ version: '1.5.0' }]) },
      installed,
      whileQueued: () => {
        installed[0] = installedGit({ version: '2.0.0', commit: c('2') })
      }
    })
    await expect(r.service.updateMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/is at version 2\.0\.0 now; 1\.5\.0 is not an update/)
    expect(r.order).toEqual([])
  })

  it('still goes through when nothing moved', async () => {
    const r = await rig({ texts: { [A]: indexOf([{ version: '1.5.0' }]) }, installed: [installedGit()] })
    await r.service.updateMarketplace(A, 'bronos.jira', SHOWN)
    expect(r.order).toEqual(['hosts reload'])
  })
})

describe('an install asked again in the installer queue', () => {
  it('refuses a commit revoked during the clone by an index removed right after', async () => {
    // Removed, the index's state is pruned (a pending install is no authority): the installer's own
    // revocation check would answer "unknown" and let the known-revoked commit through.
    const r = await rig({
      texts: { [A]: indexOf([{}]) },
      whileQueued: async () => {
        r.texts[A] = indexOf([{}], [{ id: 'bronos.jira', commit: c('a') }])
        await r.service.refreshMarketplace()
        await r.service.setMarketplaceUrls([])
      }
    })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/unknown marketplace entry/)
    expect(r.order).toEqual([])
    expect(r.repos['bronos.jira']).toBeUndefined()
  })

  it('refuses a listing that moved to another commit while it waited', async () => {
    const r = await rig({
      texts: { [A]: indexOf([{}]) },
      whileQueued: async () => {
        r.texts[A] = indexOf([{ commit: c('b') }])
        await r.service.refreshMarketplace()
      }
    })
    await expect(r.service.installMarketplace(A, 'bronos.jira', SHOWN)).rejects.toThrow(/changed in the marketplace/)
    expect(r.order).toEqual([])
  })
})

describe('a marketplace install through the real installer', () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
      { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }
    ).trim()

  /** The view's pin and the installer's check meet here; the rig's fake echoes the pin instead. */
  function wired(listing: (repo: string, commit: string) => Record<string, unknown>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mkt-real-')))
    dirs.push(root)
    const work = join(root, 'work')
    cpSync(join(__dirname, '..', 'fixtures', 'plugins', 'good'), work, { recursive: true })
    git(work, 'init', '-q')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'v1')
    git(work, 'tag', 'v1.0.0')
    const commit = git(work, 'rev-parse', 'HEAD')
    git(root, 'clone', '-q', '--bare', work, 'good.git')
    const repo = pathToFileURL(join(root, 'good.git')).href
    const indexFile = join(root, 'index.json')
    const indexUrl = pathToFileURL(indexFile).href
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: 1,
        revoked: [],
        plugins: [{ id: 'test.good', name: 'Good', description: '', author: 'me', version: '1.0.0', tag: 'v1.0.0', api: 1, ...listing(repo, commit) }]
      })
    )
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    const index = new PluginIndex({ filePath: join(dataDir, 'plugins.json') })
    const urls = [indexUrl]
    const marketplace = new MarketplaceService({ dataDir, urls: () => urls, authorities: () => [], fetcher: createIndexFetcher() })
    const plugins = new PluginInstaller({
      dataDir,
      index,
      themes: new ThemeService({ settings: { data: {}, save: () => {} }, isDark: () => false, onChange: () => {} }),
      env: () => GIT_ENV,
      log: () => {},
      revocation: (p) => marketplace.revocationFor(p),
      // As index.ts wires it (ProjectRegistry.forgetPluginRepo).
      beforeLink: (id) => void delete repos[id]
    })
    const repos: Record<string, string> = {}
    const enabled = new Set<string>()
    const deps: Partial<SettingsDeps> = {
      plugins,
      marketplace,
      pluginRepos: { get: (id) => repos[id], set: (id, r) => void (repos[id] = r) },
      disableEverywhere: (id) => void enabled.delete(id),
      enabledInAProject: (id) => enabled.has(id)
    }
    return { service: new SettingsService(deps as SettingsDeps), marketplace, plugins, dataDir, indexUrl, indexFile, repo, commit, work, root, enabled, repos, urls }
  }

  it('a folder linked under the id ends the repository history: the old repo is a change again', async () => {
    const w = wired((repo, commit) => ({ repo, commit }))
    await w.marketplace.refresh()
    const expected = { repo: w.repo, commit: w.commit }
    await w.service.installMarketplace(w.indexUrl, 'test.good', expected)
    await w.service.uninstallPlugin('test.good')
    expect(w.repos['test.good']).toBe(w.repo)

    await w.plugins.link(join(w.root, 'work'))
    expect(w.repos['test.good']).toBeUndefined()
    w.enabled.add('test.good')
    await w.service.uninstallPlugin('test.good')

    const listed = w.service.marketplace().entries.find((e) => e.id === 'test.good')
    expect(listed).toMatchObject({ action: 'install', repoChangedFrom: 'an unrecorded repository' })
    await w.service.installMarketplace(w.indexUrl, 'test.good', expected)
    expect(w.enabled.has('test.good')).toBe(false)
    expect(w.repos['test.good']).toBe(w.repo)
  })

  it('installs what the index pins and records the commit and the index', async () => {
    const w = wired((repo, commit) => ({ repo, commit }))
    await w.marketplace.refresh()
    const view = await w.service.installMarketplace(w.indexUrl, 'test.good', { repo: w.repo, commit: w.commit })
    expect(view.version).toBe('1.0.0')
    expect(w.plugins.get('test.good')).toMatchObject({ commit: w.commit, marketplace: w.indexUrl })
    expect(existsSync(join(w.dataDir, 'plugins', 'test.good@1.0.0', 'plugin.json'))).toBe(true)
    expect(existsSync(join(w.dataDir, 'plugins', 'test.good@1.0.0', '.git'))).toBe(false)
  })

  it('an update authorized at v1 does not downgrade the v2 an earlier queued update installs', async () => {
    const w = wired((repo, commit) => ({ repo, commit }))
    const tagVersion = (version: string): string => {
      const manifest = join(w.work, 'plugin.json')
      writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, 'utf8')) as object), version }))
      git(w.work, 'commit', '-q', '-am', version)
      git(w.work, 'tag', `v${version}`)
      git(w.work, 'push', '-q', join(w.root, 'good.git'), `v${version}`)
      return git(w.work, 'rev-parse', 'HEAD')
    }
    const safe = tagVersion('1.5.0')
    tagVersion('2.0.0')
    writeFileSync(
      w.indexFile,
      JSON.stringify({
        schema: 1,
        revoked: [],
        plugins: [{ id: 'test.good', name: 'Good', description: '', author: 'me', version: '1.5.0', tag: 'v1.5.0', api: 1, repo: w.repo, commit: safe }]
      })
    )
    await w.marketplace.refresh()
    await w.plugins.install(w.repo, 'v1.0.0', { commit: w.commit, id: 'test.good', version: '1.0.0', marketplace: w.indexUrl })
    // Both asked while v1 is installed; the second is eligible only until the first has run.
    const first = w.plugins.update('test.good', 'v2.0.0')
    const second = w.service.updateMarketplace(w.indexUrl, 'test.good', { repo: w.repo, commit: safe })
    await first
    await expect(second).rejects.toThrow(/is at version 2\.0\.0 now; 1\.5\.0 is not an update/)
    expect(w.plugins.get('test.good')?.version).toBe('2.0.0')
    expect(existsSync(join(w.dataDir, 'plugins', 'test.good@1.5.0'))).toBe(false)
  })

  it('an index that revokes the commit and is removed while the clone moves into place refuses the install', async () => {
    const w = wired((repo, commit) => ({ repo, commit }))
    await w.marketplace.refresh()
    const rename = fsPromises.rename.bind(fsPromises)
    let renamed = false
    const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      renamed = true
      writeFileSync(w.indexFile, JSON.stringify({ schema: 1, plugins: [], revoked: [{ id: 'test.good', commit: w.commit, reason: 'known bad' }] }))
      await w.marketplace.refresh()
      // What setMarketplaceUrls does; not called itself, its applyRevocations waits for this install.
      w.urls.length = 0
      w.marketplace.prune()
      // The revocation is gone with the index: only the listing check is left to refuse.
      expect(w.marketplace.revocationFor({ id: 'test.good', commit: w.commit, marketplace: w.indexUrl })).toBeUndefined()
      await rename(from, to)
    })
    try {
      await expect(w.service.installMarketplace(w.indexUrl, 'test.good', { repo: w.repo, commit: w.commit })).rejects.toThrow(/unknown marketplace entry/)
    } finally {
      spy.mockRestore()
    }
    expect(renamed).toBe(true)
    expect(w.plugins.get('test.good')).toBeUndefined()
    expect(existsSync(join(w.dataDir, 'plugins', 'test.good@1.0.0'))).toBe(false)
    expect(w.repos['test.good']).toBeUndefined()
  })

  it('refuses a moved tag: the commit the view pinned is not where the clone landed', async () => {
    const w = wired((repo) => ({ repo, commit: c('a') }))
    await w.marketplace.refresh()
    await expect(w.service.installMarketplace(w.indexUrl, 'test.good', { repo: w.repo, commit: c('a') })).rejects.toThrow(/the tag is at commit/)
    expect(w.plugins.get('test.good')).toBeUndefined()
    expect(existsSync(join(w.dataDir, 'plugins', 'test.good@1.0.0'))).toBe(false)
  })
})

describe('marketplace urls and refresh', () => {
  it('keeps fetching the default index and a recorded index when the list drops them, and prunes the rest', async () => {
    const r = await rig({
      texts: { [A]: indexOf([{}]), [B]: indexOf([{}]), [DEFAULT_MARKETPLACE_URL]: indexOf([]) },
      installed: [installedGit()],
      urls: [A, B]
    })
    const v = await r.service.setMarketplaceUrls([])
    r.fetched.length = 0
    await r.service.refreshMarketplace()
    expect(r.fetched.sort()).toEqual([A, DEFAULT_MARKETPLACE_URL].sort())
    expect(v.indexes).toEqual([])
    // B had no authority: gone, so re-adding it with a failing fetch shows no stale listing.
    delete r.texts[B]
    const again = await r.service.setMarketplaceUrls([B])
    expect(again.entries.filter((e) => e.indexUrl === B)).toEqual([])
    expect(again.indexes[0]).toMatchObject({ fetchedAt: 0, error: 'offline' })
  })

  it('stores normalized, de-duplicated URLs and fetches them', async () => {
    const r = await rig({ texts: { [A]: indexOf([{}]) }, urls: [] })
    const v = await r.service.setMarketplaceUrls([A.toUpperCase().replace('/INDEX.JSON', '/index.json'), A])
    expect(r.stored).toEqual([[A]])
    expect(v.indexes.map((i) => i.url)).toEqual([A])
    expect(statusOf(v)?.status).toBe('available')
  })

  it('refuses a bad scheme, credentials or a non-list, storing nothing', async () => {
    const r = await rig({ texts: {}, urls: [] })
    await expect(r.service.setMarketplaceUrls(['http://a.example/i.json'])).rejects.toThrow(/https/)
    await expect(r.service.setMarketplaceUrls(['https://u:p@a.example/i.json'])).rejects.toThrow(/credentials/)
    await expect(r.service.setMarketplaceUrls([A, 'ftp://x'])).rejects.toThrow()
    await expect(r.service.setMarketplaceUrls('https://a.example/i.json')).rejects.toThrow(/list/)
    await expect(r.service.setMarketplaceUrls([5])).rejects.toThrow()
    expect(r.stored).toEqual([])
  })
})
