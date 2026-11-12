import { describe, expect, it } from 'vitest'
import {
  canConnect,
  connectSettings,
  editFields,
  emptyConnectFields,
  filterProjects,
  firstOpenable,
  groupServers,
  isLoopbackOrigin,
  moveHighlight,
  newPromptFlow,
  openedAgo,
  parsePort,
  plainHttpToConfirm,
  promptStep,
  remoteRecentRows,
  serverNotes,
  serverStateLabel,
  sortServers,
  tabOf,
  tildePath,
  tunnelCommands,
  viaLabel,
  withAnswer,
  type PromptFlow
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
  remembered: {},
  windows: 0,
  ...over
})

describe('viaLabel', () => {
  it('names the ssh host with its user, the tunnel\'s local port, or the Direct origin', () => {
    expect(viaLabel({ kind: 'ssh', host: 'devbox' })).toBe('ssh devbox')
    expect(viaLabel({ kind: 'ssh', host: 'box', user: 'me', ccc: '/opt/ccc' })).toBe('ssh me@box')
    expect(viaLabel({ kind: 'ssh', host: 'box', user: 'me', port: 2222 })).toBe('ssh me@box:2222')
    expect(viaLabel({ kind: 'ssh', host: 'box', port: 22 })).toBe('ssh box:22')
    // An IPv6 literal with a port reads as in a URL; one already in brackets stays as is.
    expect(viaLabel({ kind: 'ssh', host: 'fd00::1', port: 2222 })).toBe('ssh [fd00::1]:2222')
    expect(viaLabel({ kind: 'ssh', host: '[fd00::1]', user: 'me', port: 2222 })).toBe('ssh me@[fd00::1]:2222')
    expect(viaLabel({ kind: 'ssh', host: 'fd00::1' })).toBe('ssh fd00::1')
    expect(viaLabel({ kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox' })).toBe('tunnel :7331')
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

describe('plainHttpToConfirm', () => {
  const link = (text: string) => ({ link: text })
  it('asks for a plain-http link to another machine, once per origin', () => {
    expect(plainHttpToConfirm('link', link('http://box.lan:7330/#t=abc'))).toBe('http://box.lan:7330')
    expect(plainHttpToConfirm('link', link('  http://10.0.0.5:7330  '))).toBe('http://10.0.0.5:7330')
  })
  it('not for https, this machine, a link that does not parse, another tab', () => {
    expect(plainHttpToConfirm('link', link('https://box.lan/#t=abc'))).toBeUndefined()
    expect(plainHttpToConfirm('link', link('http://127.0.0.1:7330/#t=abc'))).toBeUndefined()
    expect(plainHttpToConfirm('link', link('http://localhost:7330'))).toBeUndefined()
    expect(plainHttpToConfirm('link', link('box.lan'))).toBeUndefined()
    expect(plainHttpToConfirm('link', link(''))).toBeUndefined()
    expect(plainHttpToConfirm('tunnel', link('http://box.lan:7330'))).toBeUndefined()
  })
  it('an Edit keeping the saved origin was confirmed already; a new origin asks', () => {
    const saved = { kind: 'direct' as const, origin: 'http://box.lan:7330' }
    expect(plainHttpToConfirm('link', link('http://box.lan:7330/#t=new'), saved)).toBeUndefined()
    expect(plainHttpToConfirm('link', link('http://other.lan:7330'), saved)).toBe('http://other.lan:7330')
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

describe('connectSettings', () => {
  const fields = { ...emptyConnectFields(), host: '  devbox ', link: ' http://127.0.0.1:1/#t=abc ', name: '  ' }
  it('trims and leaves out empty optional fields', () => {
    expect(connectSettings('ssh', fields)).toEqual({ kind: 'ssh', host: 'devbox' })
    expect(connectSettings('link', fields)).toEqual({ kind: 'direct', link: 'http://127.0.0.1:1/#t=abc' })
    expect(connectSettings('tunnel', fields)).toEqual({ kind: 'tunnel', localPort: 7331, remotePort: 7330 })
  })
  it('passes every SSH field and the sign-in', () => {
    const full = { ...fields, user: ' me ', port: ' 2222 ', ccc: ' /opt/ccc ', name: ' Box ' }
    expect(connectSettings('ssh', full)).toEqual({ kind: 'ssh', host: 'devbox', user: 'me', port: 2222, ccc: '/opt/ccc', name: 'Box' })
    expect(connectSettings('ssh', { ...full, auth: 'password' })).toMatchObject({ auth: { kind: 'password' } })
    expect(connectSettings('ssh', { ...full, auth: 'key', keyPath: ' ~/.ssh/work ' })).toMatchObject({ auth: { kind: 'key', path: '~/.ssh/work' } })
    // Agent and my keys is no `auth` at all (main reads that as auto).
    expect(connectSettings('ssh', { ...full, auth: 'auto', keyPath: '/k' })).not.toHaveProperty('auth')
    expect(connectSettings('link', full)).toEqual({ kind: 'direct', link: 'http://127.0.0.1:1/#t=abc', name: 'Box' })
  })
  it('passes the tunnel fields, the link only when given', () => {
    const tunnel = { ...fields, sshHost: ' devbox ', localPort: '7400', remotePort: ' 7330', tunnelLink: ' http://127.0.0.1:7330/#t=x ' }
    expect(connectSettings('tunnel', tunnel)).toEqual({ kind: 'tunnel', localPort: 7400, remotePort: 7330, sshHost: 'devbox', link: 'http://127.0.0.1:7330/#t=x' })
  })
  it('refuses a port that is not a number and a key file with no path', () => {
    expect(connectSettings('ssh', { ...fields, port: '22a' })).toEqual({ error: 'a port is a number from 1 to 65535' })
    expect(connectSettings('tunnel', { ...fields, localPort: '0' })).toEqual({ error: 'a port is a number from 1 to 65535' })
    expect(connectSettings('tunnel', { ...fields, remotePort: '' })).toEqual({ error: 'a port is a number from 1 to 65535' })
    expect(connectSettings('ssh', { ...fields, auth: 'key', keyPath: ' ' })).toEqual({ error: 'choose the key file' })
  })
})

describe('parsePort', () => {
  it('reads a whole number from 1 to 65535 and nothing else', () => {
    expect(parsePort('22')).toBe(22)
    expect(parsePort(' 65535 ')).toBe(65535)
    for (const bad of ['', '0', '65536', '-1', '+22', '2e3', '22.0', '0x16', '١٢', '123456']) expect(parsePort(bad)).toBeUndefined()
  })
})

describe('canConnect', () => {
  const f = emptyConnectFields()
  it('needs the host, a key path for Key file, both ports, or the link', () => {
    expect(canConnect('ssh', f)).toBe(false)
    expect(canConnect('ssh', { ...f, host: 'devbox' })).toBe(true)
    expect(canConnect('ssh', { ...f, host: 'devbox', auth: 'key' })).toBe(false)
    expect(canConnect('ssh', { ...f, host: 'devbox', auth: 'key', keyPath: '/k' })).toBe(true)
    expect(canConnect('tunnel', f)).toBe(true)
    expect(canConnect('tunnel', { ...f, localPort: ' ' })).toBe(false)
    expect(canConnect('link', f)).toBe(false)
    expect(canConnect('link', { ...f, link: 'https://box' })).toBe(true)
  })
})

describe('editFields and tabOf', () => {
  it('prefills each kind and locks its tab', () => {
    expect(editFields({ name: 'Dev', via: { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'key', path: '~/.ssh/k' }, ccc: '/opt/ccc' } })).toMatchObject({
      name: 'Dev',
      host: 'devbox',
      user: 'me',
      port: '2222',
      auth: 'key',
      keyPath: '~/.ssh/k',
      ccc: '/opt/ccc'
    })
    expect(editFields({ name: 'Old', via: { kind: 'ssh', host: 'devbox' } })).toMatchObject({ auth: 'auto', user: '', port: '', keyPath: '' })
    expect(editFields({ name: 'T', via: { kind: 'tunnel', localPort: 7400, remotePort: 7330, sshHost: 'devbox' } })).toMatchObject({
      sshHost: 'devbox',
      localPort: '7400',
      remotePort: '7330',
      tunnelLink: ''
    })
    expect(editFields({ name: 'D', via: { kind: 'direct', origin: 'https://box.ts.net' } })).toMatchObject({ link: 'https://box.ts.net' })
    expect(tabOf({ kind: 'ssh', host: 'x' })).toBe('ssh')
    expect(tabOf({ kind: 'tunnel', localPort: 1, remotePort: 2 })).toBe('tunnel')
    expect(tabOf({ kind: 'direct', origin: 'https://x' })).toBe('link')
  })
  it('round-trips: the prefilled form sends the saved settings back', () => {
    const via = { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'password' }, ccc: '/opt/ccc' } as const
    expect(connectSettings('ssh', editFields({ name: 'Dev', via }))).toEqual({ ...via, name: 'Dev' })
  })
})

describe('tunnelCommands', () => {
  it('builds both commands from the fields, live', () => {
    expect(tunnelCommands({ sshHost: ' devbox ', localPort: '7331', remotePort: '7330' })).toEqual({
      tunnel: 'ssh -N -L 127.0.0.1:7331:127.0.0.1:7330 devbox',
      addDevice: 'ssh devbox ccc web add-device'
    })
    expect(tunnelCommands({ sshHost: 'me@box', localPort: '9000', remotePort: '7777' })?.tunnel).toBe('ssh -N -L 127.0.0.1:9000:127.0.0.1:7777 me@box')
  })
  it('stands <host> in for an empty host or one main would refuse (never a shell metacharacter)', () => {
    expect(tunnelCommands({ sshHost: '', localPort: '7331', remotePort: '7330' })).toEqual({
      tunnel: 'ssh -N -L 127.0.0.1:7331:127.0.0.1:7330 <host>',
      addDevice: 'ssh <host> ccc web add-device'
    })
    expect(tunnelCommands({ sshHost: 'box; rm -rf ~', localPort: '7331', remotePort: '7330' })?.addDevice).toBe('ssh <host> ccc web add-device')
    expect(tunnelCommands({ sshHost: '-oProxyCommand=x', localPort: '7331', remotePort: '7330' })?.tunnel).toMatch(/ <host>$/)
  })
  it('shows nothing while a port is not a number', () => {
    expect(tunnelCommands({ sshHost: 'devbox', localPort: '73x', remotePort: '7330' })).toBeUndefined()
    expect(tunnelCommands({ sshHost: 'devbox', localPort: '7331', remotePort: '' })).toBeUndefined()
  })
})

describe('prompt flow (answers of one connect)', () => {
  const HOST = { need: 'hostKey', type: 'ssh-ed25519', sha256: `SHA256:${'A'.repeat(43)}`, address: 'devbox:22' } as const
  const step = (flow: PromptFlow, need: Parameters<typeof promptStep>[1]): ReturnType<typeof promptStep> => promptStep(flow, need)

  it('accumulates every answer and resends them all: host key, then password', () => {
    let flow = newPromptFlow()
    expect(step(flow, HOST).step).toEqual({ ask: HOST, retry: false })
    flow = withAnswer(flow, { need: 'hostKey', sha256: HOST.sha256 })
    expect(flow.answers).toEqual({ hostKey: HOST.sha256 })
    expect(step(flow, { need: 'password' }).step).toEqual({ ask: { need: 'password' }, retry: false })
    flow = withAnswer(flow, { need: 'password', secret: 'pw', remember: false })
    // The retry carries both.
    expect(flow.answers).toEqual({ hostKey: HOST.sha256, password: 'pw', remember: false })
  })

  it('a wrong password asks once more, saying so; a second wrong one is the error', () => {
    let flow = withAnswer(newPromptFlow(), { need: 'password', secret: 'bad', remember: true })
    let next = step(flow, { need: 'password', again: true })
    expect(next.step).toEqual({ ask: { need: 'password', again: true }, retry: true })
    flow = withAnswer(next.flow, { need: 'password', secret: 'bad2', remember: true })
    // The new answer replaces the old one.
    expect(flow.answers).toEqual({ password: 'bad2', remember: true })
    next = step(flow, { need: 'password', again: true })
    expect(next.step).toEqual({ error: 'Wrong password' })
  })

  it('counts a remembered secret that turned out wrong as the first wrong one', () => {
    const first = step(newPromptFlow(), { need: 'passphrase', path: '~/.ssh/k', again: true })
    expect(first.step).toEqual({ ask: { need: 'passphrase', path: '~/.ssh/k', again: true }, retry: true })
    const flow = withAnswer(first.flow, { need: 'passphrase', secret: 'x', remember: false })
    expect(step(flow, { need: 'passphrase', path: '~/.ssh/k', again: true }).step).toEqual({ error: 'Wrong passphrase' })
  })

  it('counts each secret on its own', () => {
    let flow = step(newPromptFlow(), { need: 'password', again: true }).flow
    expect(flow.wrong).toEqual({ password: 1, passphrase: 0 })
    flow = step(flow, { need: 'passphrase', path: '/k', again: true }).flow
    expect(flow.wrong).toEqual({ password: 1, passphrase: 1 })
  })

  it('a host key different from the one trusted asks again; the same one again is an error, not a loop', () => {
    const flow = withAnswer(newPromptFlow(), { need: 'hostKey', sha256: HOST.sha256 })
    const other = { ...HOST, sha256: `SHA256:${'B'.repeat(43)}` }
    expect(step(flow, other).step).toEqual({ ask: other, retry: false })
    expect(step(flow, HOST).step).toEqual({ error: 'the host key of devbox:22 could not be confirmed' })
  })

  it('a secret asked for again without `again` (main did not use it) is an error, not a loop', () => {
    const flow = withAnswer(newPromptFlow(), { need: 'password', secret: 'pw', remember: true })
    expect(step(flow, { need: 'password' }).step).toEqual({ error: 'the server did not take the password' })
    const key = withAnswer(newPromptFlow(), { need: 'passphrase', secret: 'pp', remember: true })
    expect(step(key, { need: 'passphrase', path: '/k' }).step).toEqual({ error: 'the passphrase did not open /k' })
  })
})
