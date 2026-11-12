import { describe, expect, it } from 'vitest'
import {
  connectRequest,
  filterProjects,
  firstOpenable,
  groupServers,
  isLoopbackOrigin,
  moveHighlight,
  openedAgo,
  remoteRecentRows,
  serverNotes,
  serverStateLabel,
  sortServers,
  tildePath,
  viaLabel
} from '../../src/renderer/picker/picker-model'
import type { ProjectSummary, RemoteServerInfo } from '../../src/shared/ipc'

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

const server = (over: Partial<RemoteServerInfo> & Pick<RemoteServerInfo, 'id'>): RemoteServerInfo => ({
  name: over.id,
  via: { kind: 'ssh', host: over.id },
  recent: [],
  cookieSaved: false,
  cookieKept: true,
  windows: 0,
  ...over
})

describe('viaLabel', () => {
  it('names the ssh host, or the Direct origin', () => {
    expect(viaLabel({ kind: 'ssh', host: 'devbox' })).toBe('ssh devbox')
    expect(viaLabel({ kind: 'ssh', host: 'me@box', ccc: '/opt/ccc' })).toBe('ssh me@box')
    expect(viaLabel({ kind: 'direct', origin: 'https://box.ts.net' })).toBe('https://box.ts.net')
  })
})

describe('isLoopbackOrigin', () => {
  it('knows this machine', () => {
    for (const o of ['http://127.0.0.1:3000', 'http://127.1.2.3', 'http://localhost:8', 'http://app.localhost', 'http://[::1]:9']) {
      expect(isLoopbackOrigin(o), o).toBe(true)
    }
  })
  it('refuses lookalikes and other hosts', () => {
    for (const o of ['http://127.0.0.1.evil.com', 'http://10.0.0.1', 'http://box.lan', 'not a url', 'http://128.0.0.1']) {
      expect(isLoopbackOrigin(o), o).toBe(false)
    }
  })
})

describe('serverNotes', () => {
  it('says when the cookie cannot be kept', () => {
    expect(serverNotes(server({ id: 'a', cookieKept: false }))).toEqual(['not remembered: no keyring'])
    expect(serverNotes(server({ id: 'a' }))).toEqual([])
  })
  it('marks plain http to another machine only', () => {
    expect(serverNotes(server({ id: 'a', via: { kind: 'direct', origin: 'http://box.lan:7777' } }))).toEqual(['not encrypted'])
    expect(serverNotes(server({ id: 'a', via: { kind: 'direct', origin: 'http://127.0.0.1:7777' } }))).toEqual([])
    expect(serverNotes(server({ id: 'a', via: { kind: 'direct', origin: 'https://box.ts.net' } }))).toEqual([])
    expect(serverNotes(server({ id: 'a', cookieKept: false, via: { kind: 'direct', origin: 'http://box.lan' } }))).toEqual([
      'not remembered: no keyring',
      'not encrypted'
    ])
  })
})

describe('serverStateLabel', () => {
  it('has nothing to say about a closed server', () => {
    expect(serverStateLabel({ windows: 0 })).toBeUndefined()
    expect(serverStateLabel({ windows: 0, connection: { state: 'stopped' } })).toBeUndefined()
  })
  it('counts the open windows', () => {
    expect(serverStateLabel({ windows: 1 })).toEqual({ text: '1 window open', tone: 'ok' })
    expect(serverStateLabel({ windows: 2, connection: { state: 'stopped' } })).toEqual({ text: '2 windows open', tone: 'ok' })
    expect(serverStateLabel({ windows: 2, connection: { state: 'up' } })).toEqual({ text: 'connected · 2 windows open', tone: 'ok' })
    expect(serverStateLabel({ windows: 0, connection: { state: 'up' } })).toEqual({ text: 'connected', tone: 'ok' })
  })
  it('shows connecting, and a dropped tunnel with or without its retry', () => {
    expect(serverStateLabel({ windows: 0, connection: { state: 'connecting' } })).toEqual({ text: 'connecting…', tone: 'busy' })
    expect(serverStateLabel({ windows: 1, connection: { state: 'down', error: 'host unreachable', retrying: true } })).toEqual({
      text: 'connection lost: host unreachable · retrying',
      tone: 'error'
    })
    expect(serverStateLabel({ windows: 0, connection: { state: 'down', error: 'permission denied', retrying: false } })).toEqual({
      text: 'cannot connect: permission denied',
      tone: 'error'
    })
  })
})

describe('sortServers', () => {
  it('puts the most recently used first, then the never-used ones by name', () => {
    const list = [
      server({ id: 'zeta' }),
      server({ id: 'old', recent: [{ projectId: 'p', name: 'p', at: 10 }] }),
      server({ id: 'Alpha' }),
      server({ id: 'new', recent: [{ projectId: 'q', name: 'q', at: 5 }, { projectId: 'r', name: 'r', at: 50 }] })
    ]
    expect(sortServers(list).map((s) => s.id)).toEqual(['new', 'old', 'Alpha', 'zeta'])
    // The input is left as it was.
    expect(list.map((s) => s.id)).toEqual(['zeta', 'old', 'Alpha', 'new'])
  })
})

describe('remoteRecentRows', () => {
  it('lists newest first', () => {
    const rows = remoteRecentRows([
      { projectId: 'a', name: 'a', at: 1 },
      { projectId: 'b', name: 'b', at: 3 },
      { projectId: 'c', name: 'c', at: 2 }
    ])
    expect(rows.map((r) => r.projectId)).toEqual(['b', 'c', 'a'])
  })
})

describe('groupServers', () => {
  it('is empty with no server (the section shows its empty text)', () => {
    expect(groupServers([])).toEqual([])
  })
  it('groups each server with its labels and its projects, in order', () => {
    const groups = groupServers([
      server({ id: 'b', name: 'Build box', via: { kind: 'direct', origin: 'http://box.lan' } }),
      server({
        id: 'a',
        name: 'Dev',
        windows: 1,
        connection: { state: 'up' },
        recent: [
          { projectId: 'x', name: 'api', at: 1 },
          { projectId: 'y', name: 'web', at: 2 }
        ]
      })
    ])
    expect(groups.map((g) => g.server.id)).toEqual(['a', 'b'])
    expect(groups[0]).toMatchObject({ via: 'ssh a', state: { text: 'connected · 1 window open', tone: 'ok' }, notes: [] })
    expect(groups[0]!.projects.map((p) => p.name)).toEqual(['web', 'api'])
    expect(groups[1]).toMatchObject({ via: 'http://box.lan', state: undefined, notes: ['not encrypted'], projects: [] })
  })
})

describe('connectRequest', () => {
  const fields = { host: '  devbox ', link: ' http://127.0.0.1:1/#t=abc ', name: '  ', ccc: '' }
  it('trims and leaves out empty optional fields', () => {
    expect(connectRequest('ssh', fields)).toEqual({ kind: 'ssh', host: 'devbox' })
    expect(connectRequest('link', fields)).toEqual({ kind: 'direct', link: 'http://127.0.0.1:1/#t=abc' })
  })
  it('passes a name and, for ssh only, the ccc path', () => {
    const full = { ...fields, name: ' Box ', ccc: ' /opt/ccc ' }
    expect(connectRequest('ssh', full)).toEqual({ kind: 'ssh', host: 'devbox', ccc: '/opt/ccc', name: 'Box' })
    expect(connectRequest('link', full)).toEqual({ kind: 'direct', link: 'http://127.0.0.1:1/#t=abc', name: 'Box' })
  })
})
