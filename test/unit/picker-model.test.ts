import { describe, expect, it } from 'vitest'
import { filterProjects, firstOpenable, moveHighlight, openedAgo, tildePath } from '../../src/renderer/picker/picker-model'
import type { ProjectSummary } from '../../src/shared/ipc'

const p = (name: string, path: string, missing = false): ProjectSummary => ({ id: name, name, path, missing })

describe('tildePath', () => {
  it('writes the home folder as ~', () => {
    expect(tildePath('/Users/me/src/app', '/Users/me')).toBe('~/src/app')
    expect(tildePath('/Users/me', '/Users/me')).toBe('~')
    expect(tildePath('/Users/me/src', '/Users/me/')).toBe('~/src')
  })
  it('leaves paths outside home, and lookalike prefixes, alone', () => {
    expect(tildePath('/Users/meg/src', '/Users/me')).toBe('/Users/meg/src')
    expect(tildePath('/opt/x', '/Users/me')).toBe('/opt/x')
  })
  it('shortens nothing without a usable home', () => {
    expect(tildePath('/a/b', undefined)).toBe('/a/b')
    expect(tildePath('/a/b', '')).toBe('/a/b')
    expect(tildePath('/a/b', '/')).toBe('/a/b')
  })
})

describe('filterProjects', () => {
  const list = [p('api', '/Users/me/work/api'), p('Cockpit', '/Users/me/src/cc-cockpit'), p('notes', '/opt/notes')]

  it('keeps everything for an empty or blank query, in order', () => {
    expect(filterProjects(list, '', '/Users/me')).toEqual(list)
    expect(filterProjects(list, '   ', '/Users/me')).toEqual(list)
  })
  it('matches name or path, ignoring case', () => {
    expect(filterProjects(list, 'COCK', '/Users/me').map((x) => x.name)).toEqual(['Cockpit'])
    expect(filterProjects(list, 'work', '/Users/me').map((x) => x.name)).toEqual(['api'])
    expect(filterProjects(list, '/opt', '/Users/me').map((x) => x.name)).toEqual(['notes'])
  })
  it('matches the ~ form the row shows', () => {
    expect(filterProjects(list, '~/src', '/Users/me').map((x) => x.name)).toEqual(['Cockpit'])
  })
  it('returns nothing when nothing matches', () => {
    expect(filterProjects(list, 'zzz', '/Users/me')).toEqual([])
  })
})

describe('highlight', () => {
  const rows = [p('a', '/a', true), p('b', '/b'), p('c', '/c', true), p('d', '/d')]

  it('starts on the first openable row', () => {
    expect(firstOpenable(rows)).toBe(1)
    expect(firstOpenable([p('x', '/x', true)])).toBe(-1)
    expect(firstOpenable([])).toBe(-1)
  })
  it('moves over missing rows and stops at the ends', () => {
    expect(moveHighlight(rows, 1, 1)).toBe(3)
    expect(moveHighlight(rows, 3, 1)).toBe(3)
    expect(moveHighlight(rows, 3, -1)).toBe(1)
    expect(moveHighlight(rows, 1, -1)).toBe(1)
  })
  it('lands on the first openable row from no highlight', () => {
    expect(moveHighlight(rows, -1, 1)).toBe(1)
    expect(moveHighlight(rows, -1, -1)).toBe(1)
    expect(moveHighlight([], -1, 1)).toBe(-1)
  })
})

describe('openedAgo', () => {
  const now = Date.UTC(2026, 10, 11, 12, 0, 0)
  it('says how long ago in short words, then the date', () => {
    expect(openedAgo(now - 30_000, now)).toBe('just now')
    expect(openedAgo(now + 3_600_000, now)).toBe('just now') // another clock ahead
    expect(openedAgo(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(openedAgo(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(openedAgo(now - 30 * 3_600_000, now)).toBe('yesterday')
    expect(openedAgo(now - 4 * 86_400_000, now)).toBe('4 days ago')
    expect(openedAgo(now - 21 * 86_400_000, now)).toBe('3 weeks ago')
    const old = now - 90 * 86_400_000
    const d = new Date(old)
    expect(openedAgo(old, now)).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  })
})
