// The one Plugins page's list (design-next §6.2, §6.3): installed plugins and listings merged into
// cards, then searched (case-insensitive substring, no regex), filtered and paged 20 at a time.
import { describe, expect, it } from 'vitest'
import type { MarketplaceEntryView, MarketplaceView, PluginView } from '../../src/shared/ipc'
import {
  buildCards,
  clampPage,
  filterCards,
  hasUpdate,
  matchesSearch,
  PAGE_SIZE,
  pageCount,
  pageOf,
  pageSlice,
  updateAllEntries,
  updateAllStillShown,
  type ListQuery
} from '../../src/renderer/settings/plugin-list-model'

const A = 'https://a.example/index.json'
const B = 'https://b.example/index.json'

function plugin(id: string, over: Partial<PluginView> = {}): PluginView {
  return { id, name: id, version: '1.0.0', source: { kind: 'git', url: `https://git.example/${id}.git`, tag: 'v1.0.0' }, state: { ok: true }, ...over }
}

function listing(id: string, over: Partial<MarketplaceEntryView> = {}): MarketplaceEntryView {
  return {
    indexUrl: A,
    id,
    name: id,
    description: '',
    author: 'Someone',
    repo: `https://git.example/${id}.git`,
    tag: 'v1.0.0',
    commit: 'a'.repeat(40),
    version: '1.0.0',
    preview: false,
    category: 'other',
    status: 'available',
    action: 'install',
    ...over
  }
}

const viewOf = (entries: MarketplaceEntryView[]): MarketplaceView => ({ indexes: [], entries, warnings: [] })
const all: ListQuery = { search: '', filter: 'all', category: null }

describe('buildCards', () => {
  it('lists installed plugins first, then listings of ids not installed, one per index', () => {
    const cards = buildCards(
      [plugin('x.one')],
      viewOf([listing('x.two'), listing('x.one', { status: 'installed', action: null, installedVersion: '1.0.0' }), listing('x.two', { indexUrl: B })])
    )
    expect(cards.map((c) => c.key)).toEqual(['x.one', `${A}|x.two`, `${B}|x.two`])
    expect(cards[0]?.plugin?.id).toBe('x.one')
    expect(cards[0]?.listing?.indexUrl).toBe(A)
  })

  it('merges the listing from the recorded index into an installed card, the first listing otherwise', () => {
    const fromA = listing('x.one', { status: 'installed', action: null, note: 'installed from another marketplace index', category: 'tools' })
    const fromB = listing('x.one', { indexUrl: B, status: 'update', action: 'update', version: '2.0.0', category: 'sources' })
    const recorded = buildCards([plugin('x.one', { marketplace: B })], viewOf([fromA, fromB]))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.listing).toBe(fromB)
    expect(recorded[0]?.category).toBe('sources')
    const gitUrl = buildCards([plugin('x.one')], viewOf([fromA, fromB]))
    expect(gitUrl[0]?.listing).toBe(fromA)
  })

  it('an installed plugin with no listing has no listing and reads as category other', () => {
    const [card] = buildCards([plugin('cockpit.browser', { source: { kind: 'bundled' } })], null)
    expect(card).not.toHaveProperty('listing')
    expect(card?.category).toBe('other')
  })

  it('nothing loaded yet: no cards', () => {
    expect(buildCards(null, null)).toEqual([])
  })
})

describe('search', () => {
  const card = buildCards(null, viewOf([listing('acme.jira', { name: 'Jira Board', author: 'Lead Dev', description: 'Issues (sprint) view' })]))[0]!

  it('matches name, id, author and description, ignoring case and outer spaces', () => {
    for (const q of ['jira board', 'ACME.', 'lead dev', 'SPRINT', '  board  ', '']) expect(matchesSearch(card, q)).toBe(true)
    expect(matchesSearch(card, 'gmail')).toBe(false)
  })

  it('is a plain substring, never a regex', () => {
    expect(matchesSearch(card, '(sprint)')).toBe(true)
    expect(matchesSearch(card, '.*')).toBe(false)
    expect(matchesSearch(card, 'issues|gmail')).toBe(false)
  })

  it('an installed plugin without a listing is found by name and id only', () => {
    const [p] = buildCards([plugin('x.files', { name: 'Files' })], null)
    expect(matchesSearch(p!, 'files')).toBe(true)
    expect(matchesSearch(p!, 'someone')).toBe(false)
  })
})

describe('filters', () => {
  const cards = buildCards(
    [plugin('x.current', { marketplace: A }), plugin('x.old', { marketplace: A }), plugin('x.revoked', { marketplace: A, state: { ok: false, reason: 'revoked' } })],
    viewOf([
      listing('x.current', { status: 'installed', action: null, category: 'tools' }),
      listing('x.old', { status: 'update', action: 'update', version: '1.1.0', category: 'sources' }),
      listing('x.revoked', { status: 'revoked', action: 'update', category: 'sources' }),
      listing('x.new', { category: 'sources' }),
      listing('x.gone', { status: 'revoked', action: null, category: 'themes' })
    ])
  )
  const ids = (q: Partial<ListQuery>): string[] => filterCards(cards, { ...all, ...q }).map((c) => c.id)

  it('Installed, Available and Updates', () => {
    expect(ids({ filter: 'installed' })).toEqual(['x.current', 'x.old', 'x.revoked'])
    expect(ids({ filter: 'available' })).toEqual(['x.new', 'x.gone'])
    // A revoked plugin's safe version is an update too: it is what the button offers.
    expect(ids({ filter: 'updates' })).toEqual(['x.old', 'x.revoked'])
    expect(cards.filter(hasUpdate).map((c) => c.id)).toEqual(['x.old', 'x.revoked'])
  })

  it('category, combined with a filter and a search', () => {
    expect(ids({ category: 'sources' })).toEqual(['x.old', 'x.revoked', 'x.new'])
    expect(ids({ category: 'sources', filter: 'available' })).toEqual(['x.new'])
    expect(ids({ category: 'sources', search: 'old' })).toEqual(['x.old'])
    expect(ids({ category: 'claude' })).toEqual([])
  })
})

describe('paging', () => {
  const many = buildCards(null, viewOf(Array.from({ length: 45 }, (_, i) => listing(`x.p${String(i).padStart(2, '0')}`))))

  it('20 per page, at least one page', () => {
    expect(PAGE_SIZE).toBe(20)
    expect(pageCount(0)).toBe(1)
    expect(pageCount(20)).toBe(1)
    expect(pageCount(21)).toBe(2)
    expect(pageCount(45)).toBe(3)
    expect(pageSlice(many, 0)).toHaveLength(20)
    expect(pageSlice(many, 2).map((c) => c.id)).toEqual(['x.p40', 'x.p41', 'x.p42', 'x.p43', 'x.p44'])
  })

  it('a page past the end (the list shrank under a search) lands on the last page', () => {
    expect(clampPage(5, 45)).toBe(2)
    expect(clampPage(-1, 45)).toBe(0)
    expect(clampPage(Number.NaN, 45)).toBe(0)
    expect(clampPage(3, 0)).toBe(0)
    expect(pageSlice(many, 9).map((c) => c.id)[0]).toBe('x.p40')
  })

  it('the page holding a plugin, for the panel gear', () => {
    expect(pageOf(many, 'x.p00')).toBe(0)
    expect(pageOf(many, 'x.p20')).toBe(1)
    expect(pageOf(many, 'x.p44')).toBe(2)
    expect(pageOf(many, 'x.none')).toBe(0)
  })
})

describe('update all (design-next §6.4)', () => {
  const up = listing('a.up', { status: 'update', action: 'update', installedVersion: '0.9.0' })
  const revokedMove = listing('a.rev', { status: 'revoked', action: 'update', installedVersion: '2.0.0' })
  const linked = listing('a.lnk', { status: 'linked', action: null })
  const fromGitUrl = listing('a.git', { status: 'installed', action: null, note: 'installed from a git URL; it updates from there' })

  it('offers plain newer versions only, never a revoked plugin\'s move, a linked or a git-URL plugin', () => {
    expect(updateAllEntries(viewOf([up, revokedMove, linked, fromGitUrl, listing('a.new')])).map((e) => e.id)).toEqual(['a.up'])
    expect(updateAllEntries(null)).toEqual([])
  })

  it('keeps the prompt open only while every listed plugin is offered at the same repo and commit', () => {
    const other = listing('a.two', { status: 'update', action: 'update' })
    expect(updateAllStillShown([up], viewOf([up, other]))).toBe(true)
    expect(updateAllStillShown([up, other], viewOf([up, { ...other, commit: 'b'.repeat(40) }]))).toBe(false)
    expect(updateAllStillShown([up], viewOf([{ ...up, status: 'installed', action: null }]))).toBe(false)
    expect(updateAllStillShown([up], viewOf([]))).toBe(false)
  })
})
