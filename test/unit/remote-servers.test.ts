import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_REMOTE_RECENT,
  MAX_REMOTE_SERVERS,
  REMOTE_CCC_MISSING,
  REMOTE_SCRIPT,
  checkCccOverride,
  checkSshHost,
  parseRemoteLink,
  remoteCommand,
  validateRemoteServers
} from '../../src/shared/remote-servers'
import { RemoteServerStore, type RemoteServersApp } from '../../src/main/remote/remote-servers'
import { JsonFile } from '../../src/main/store/json-file'
import { FAKE_PREFIX, SecretStoreError, fakeSecretStore, storedSecretValues, unreadableCounts, type SecretStore } from '../../src/main/secrets/secret-store'
import type { AppSettings } from '../../src/shared/types'

const ssh = (id: string, host = 'devbox') => ({ id, name: host, via: { kind: 'ssh', host }, recent: [] })

describe('validateRemoteServers', () => {
  it('keeps a good record and fills the name from the host or the origin', () => {
    const list = validateRemoteServers([
      { id: 'a1', via: { kind: 'ssh', host: 'devbox', ccc: '/opt/ccc' }, recent: [{ projectId: 'p', name: 'Proj', at: 5 }], cookie: 'enc', localPort: 4321 },
      { id: 'b2', name: ' Home ', via: { kind: 'direct', origin: 'http://192.168.1.5:8765' } }
    ])
    expect(list).toEqual([
      { id: 'a1', name: 'devbox', via: { kind: 'ssh', host: 'devbox', ccc: '/opt/ccc' }, recent: [{ projectId: 'p', name: 'Proj', at: 5 }], cookie: 'enc', localPort: 4321 },
      { id: 'b2', name: 'Home', via: { kind: 'direct', origin: 'http://192.168.1.5:8765' }, recent: [] }
    ])
    expect(validateRemoteServers([{ id: 'c', via: { kind: 'direct', origin: 'https://box.example' } }])[0]?.name).toBe('box.example')
  })

  it('drops what is not an array, not an object, a duplicate id, a bad id and an unknown via kind', () => {
    expect(validateRemoteServers(undefined)).toEqual([])
    expect(validateRemoteServers({ id: 'a' })).toEqual([])
    const list = validateRemoteServers([
      7,
      null,
      ssh('ok'),
      ssh('ok', 'other'),
      ssh('bad id'),
      ssh(''),
      ssh('x'.repeat(65)),
      { id: 'k', name: 'n', via: { kind: 'telnet', host: 'h' } },
      { id: 'n', name: 'n' },
      { id: 'h', name: 'n', via: { kind: 'ssh', host: '-oProxyCommand=x' } },
      { id: 'h2', name: 'n', via: { kind: 'ssh', host: 'a b' } },
      { id: 'o', name: 'n', via: { kind: 'direct', origin: 'http://h/path' } },
      { id: 'o2', name: 'n', via: { kind: 'direct', origin: 'ftp://h' } },
      { id: 'o3', name: 'n', via: { kind: 'direct', origin: 'http://h/#t=x' } }
    ])
    expect(list.map((s) => s.id)).toEqual(['ok'])
  })

  it('caps the servers at 32 and the recents at 8, deduplicated by project', () => {
    const many = Array.from({ length: 40 }, (_, i) => ssh(`s${i}`))
    expect(validateRemoteServers(many)).toHaveLength(MAX_REMOTE_SERVERS)
    const recent = Array.from({ length: 12 }, (_, i) => ({ projectId: `p${i % 10}`, name: `n${i}`, at: i }))
    const [server] = validateRemoteServers([{ ...ssh('a'), recent }])
    expect(server?.recent).toHaveLength(MAX_REMOTE_RECENT)
    expect(new Set(server?.recent.map((r) => r.projectId)).size).toBe(MAX_REMOTE_RECENT)
    expect(server?.recent[0]).toEqual({ projectId: 'p0', name: 'n0', at: 0 })
  })

  it('repairs damaged optional fields on their own', () => {
    const [server] = validateRemoteServers([
      {
        id: 'a',
        name: 'x'.repeat(101),
        via: { kind: 'ssh', host: 'devbox', ccc: "/it's" },
        recent: [{ projectId: 'p', name: 'bad\u0007', at: 1 }, { projectId: 3, name: 'n', at: 1 }, { projectId: 'q', name: 'n', at: -1 }, { projectId: 'r', name: 'ok', at: 2 }],
        cookie: 12,
        localPort: 70000
      }
    ])
    expect(server).toEqual({ id: 'a', name: 'devbox', via: { kind: 'ssh', host: 'devbox' }, recent: [{ projectId: 'r', name: 'ok', at: 2 }] })
    expect(validateRemoteServers([{ ...ssh('a'), cookie: 'c'.repeat(5000), localPort: 1.5 }])[0]).toEqual({ ...ssh('a'), recent: [] })
  })
})

describe('parseRemoteLink', () => {
  it('takes an origin, with or without the token', () => {
    expect(parseRemoteLink('http://192.168.1.5:8765/')).toEqual({ origin: 'http://192.168.1.5:8765' })
    expect(parseRemoteLink('  https://box.example  ')).toEqual({ origin: 'https://box.example' })
    expect(parseRemoteLink('https://box.example/#t=abc123')).toEqual({ origin: 'https://box.example', token: 'abc123' })
    expect(parseRemoteLink('http://[::1]:9000/#t=a%2Fb')).toEqual({ origin: 'http://[::1]:9000', token: 'a/b' })
  })

  it.each([
    ['', 'paste'],
    ['not a link', 'not a link'],
    ['ftp://box.example/', 'only http'],
    ['file:///etc/passwd', 'only http'],
    ['javascript:alert(1)', 'only http'],
    ['http://user@box.example/', 'user name'],
    ['http://user:pw@box.example/', 'user name'],
    ['https://box.example/app', 'no path'],
    ['https://box.example/?x=1', 'query'],
    ['https://box.example/?x=1#t=a', 'query'],
    ['https://box.example/#t=', 'empty token'],
    ['https://box.example/#other=1', 't=<token>'],
    ['https://box.example/#frag', 't=<token>'],
    [`https://box.example/#t=${'a'.repeat(513)}`, 'too long']
  ])('refuses %s', (text, part) => {
    const link = parseRemoteLink(text)
    expect(link).toHaveProperty('error')
    expect((link as { error: string }).error).toContain(part)
  })
})

describe('checkSshHost', () => {
  it('accepts hosts, aliases, users and IPv6 literals', () => {
    for (const h of ['devbox', 'dev-box_1.example.com', 'me@devbox', 'me@10.0.0.5', '[::1]', 'fe80::1', 'a'.repeat(255)]) {
      expect(checkSshHost(h)).toBeUndefined()
    }
  })

  it('refuses empty, long, leading dash and any character outside the allowlist', () => {
    for (const h of ['', 'a'.repeat(256), '-oProxyCommand=x', '--', 'a b', 'a;b', 'a|b', '$(x)', 'a`b`', "a'b", 'a"b', 'a\\b', 'a\nb', 'a%h', 'a/b', 'a*', 'é']) {
      expect(checkSshHost(h)).toBeDefined()
    }
  })
})

describe('remoteCommand', () => {
  it('is the exact one-line string for the default case', () => {
    expect(remoteCommand(['web', 'status', '--json'])).toBe(`'sh' '-c' '${REMOTE_SCRIPT}' 'sh' '' 'web' 'status' '--json'`)
    expect(remoteCommand(['web', 'add-device'])).toBe(`'sh' '-c' '${REMOTE_SCRIPT}' 'sh' '' 'web' 'add-device'`)
  })

  it('passes the override as the first argument, quoted', () => {
    expect(remoteCommand(['web', 'status', '--json'], '/opt/my tools/ccc')).toBe(`'sh' '-c' '${REMOTE_SCRIPT}' 'sh' '/opt/my tools/ccc' 'web' 'status' '--json'`)
  })

  it('has a script every login shell reads the same: one line, no quote, backslash or !', () => {
    expect(REMOTE_SCRIPT).not.toMatch(/['\\!\n]/)
    expect(remoteCommand(['x']).split('\n')).toHaveLength(1)
  })

  it('refuses a quote, a backslash, !, a newline and control characters in the override or an argument', () => {
    for (const bad of ["/a'b", '/a\\b', '/a!b', '/a\nb', '/a\rb', '/a\u0000b', '/a\u001bb']) {
      expect(() => remoteCommand(['web'], bad)).toThrow(RangeError)
      expect(checkCccOverride(bad)).toBeDefined()
      expect(() => remoteCommand([bad])).toThrow(RangeError)
    }
    expect(() => remoteCommand(['web'], 'ccc')).toThrow(/absolute/)
    expect(checkCccOverride('/home/me/.local/bin/ccc')).toBeUndefined()
  })

  // The script itself, run by a real sh the way the remote login shell hands it over.
  describe('script under sh', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ccc-remote-cmd-'))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    const run = (command: string, home: string, path: string): { out: string; code: number } => {
      try {
        const out = execFileSync('sh', ['-c', command], { env: { HOME: home, PATH: path }, encoding: 'utf8' })
        return { out, code: 0 }
      } catch (err) {
        const e = err as { stdout: string; status: number }
        return { out: e.stdout, code: e.status }
      }
    }

    it('runs the override, then the wrapper in the config dir, then ccc on PATH, else prints the marker and exits 127', () => {
      const tool = (path: string, label: string): void => {
        execFileSync('sh', ['-c', `mkdir -p "$(dirname "$1")" && printf '#!/bin/sh\\necho %s "$@"\\n' "$2" > "$1" && chmod +x "$1"`, 'sh', path, label])
      }
      const home = join(dir, 'home')
      const bin = join(dir, 'bin')
      const sysPath = '/usr/bin:/bin'
      const cmd = (override?: string): string => remoteCommand(['web', 'status', '--json'], override)

      let r = run(cmd(), home, `${bin}:${sysPath}`)
      expect(r).toEqual({ out: `${REMOTE_CCC_MISSING}\n`, code: 127 })

      tool(join(bin, 'ccc'), 'path')
      r = run(cmd(), home, `${bin}:${sysPath}`)
      expect(r).toEqual({ out: 'path web status --json\n', code: 0 })

      tool(join(home, '.config/cc-cockpit/bin/ccc'), 'wrapper')
      r = run(cmd(), home, `${bin}:${sysPath}`)
      expect(r.out).toBe('wrapper web status --json\n')

      const custom = join(dir, 'my tools/ccc')
      tool(custom, 'override')
      r = run(cmd(custom), home, `${bin}:${sysPath}`)
      expect(r.out).toBe('override web status --json\n')
    })
  })
})

describe('RemoteServerStore', () => {
  let dir: string
  let app: JsonFile<AppSettings>
  let ids: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-remote-store-'))
    app = new JsonFile<AppSettings>({
      filePath: join(dir, 'app.json'),
      defaults: () => ({ schemaVersion: 1, openProjects: [], recentProjects: [], keyOverrides: {}, pluginSettings: {} }),
      debounceMs: 1
    })
    ids = 0
  })
  afterEach(() => {
    app.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  const make = (secrets: SecretStore = fakeSecretStore(), source: RemoteServersApp = app): RemoteServerStore =>
    new RemoteServerStore({ app: source, secrets, newId: () => `id${++ids}` })

  const noKeyring: SecretStore = {
    kind: 'os',
    unavailableReason: async () => 'no OS keyring is available',
    encrypt: async () => {
      throw new SecretStoreError('no OS keyring is available')
    },
    decrypt: async () => {
      throw new SecretStoreError('no OS keyring is available')
    }
  }

  it('adds, defaults the name, lists, renames and forgets', async () => {
    const store = make()
    const a = store.add({ via: { kind: 'ssh', host: ' devbox ', ccc: '/opt/ccc' } })
    const b = store.add({ name: 'Home', via: { kind: 'direct', origin: 'http://192.168.1.5:8765/#t=secret' } })
    expect(a).toEqual({ id: 'id1', name: 'devbox', via: { kind: 'ssh', host: 'devbox', ccc: '/opt/ccc' }, recent: [] })
    // Only the origin is kept: the token of a pasted link never reaches the record.
    expect(b.via).toEqual({ kind: 'direct', origin: 'http://192.168.1.5:8765' })
    expect(JSON.stringify(app.data.remoteServers)).not.toContain('secret')
    expect((await store.list()).map((s) => [s.id, s.name, s.cookieSaved, s.cookieKept])).toEqual([
      ['id1', 'devbox', false, true],
      ['id2', 'Home', false, true]
    ])
    store.rename('id1', 'Dev box')
    expect(store.get('id1')?.name).toBe('Dev box')
    expect(() => store.rename('id1', '')).toThrow(/name/)
    expect(() => store.rename('nope', 'x')).toThrow(/unknown/)
    expect(store.forget('id1')).toBe(true)
    expect(store.forget('id1')).toBe(false)
    expect(store.forget('id2')).toBe(true)
    expect(app.data.remoteServers).toBeUndefined()
  })

  it('answers the saved record for the same host or origin; refuses bad input and the 33rd server', () => {
    const store = make()
    const a = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    expect(store.add({ name: 'again', via: { kind: 'ssh', host: 'devbox' } }).id).toBe(a.id)
    expect(store.add({ via: { kind: 'ssh', host: 'devbox', ccc: '/x/ccc' } }).id).not.toBe(a.id)
    expect(() => store.add({ via: { kind: 'ssh', host: '-oProxyCommand=x' } })).toThrow()
    expect(() => store.add({ via: { kind: 'ssh', host: 'ok', ccc: "/it's" } })).toThrow()
    expect(() => store.add({ via: { kind: 'direct', origin: 'ftp://x' } })).toThrow(/http/)
    expect(() => store.add({ name: 'a\nb', via: { kind: 'ssh', host: 'h2' } })).toThrow(/name/)
    for (let i = 0; i < 30; i++) store.add({ via: { kind: 'ssh', host: `h${i}` } })
    expect(app.data.remoteServers).toHaveLength(MAX_REMOTE_SERVERS)
    expect(() => store.add({ via: { kind: 'ssh', host: 'one-more' } })).toThrow(/at most 32/)
  })

  it('keeps the cookie encrypted, never plain, and forget drops it', async () => {
    const store = make()
    const { id } = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    expect(await store.setCookie(id, 'ccc_device-secret')).toEqual({ kept: true })
    const stored = app.data.remoteServers?.[0]?.cookie
    expect(stored?.startsWith(FAKE_PREFIX)).toBe(true)
    expect(JSON.stringify(app.data)).not.toContain('ccc_device-secret')
    expect(await store.getCookie(id)).toBe('ccc_device-secret')
    expect((await store.list())[0]).toMatchObject({ cookieSaved: true })
    expect('cookie' in (await store.list())[0]!).toBe(false)
    expect('cookie' in store.get(id)!).toBe(false)
    store.clearCookie(id)
    expect(await store.getCookie(id)).toBeUndefined()
    await store.setCookie(id, 'again')
    store.forget(id)
    expect(app.data.remoteServers).toBeUndefined()
    await expect(store.setCookie(id, 'x')).rejects.toThrow(/unknown/)
  })

  it('keeps no cookie when the secret store refuses, drops the old one and says why', async () => {
    const good = make()
    const { id } = good.add({ via: { kind: 'ssh', host: 'devbox' } })
    await good.setCookie(id, 'old')
    const store = make(noKeyring)
    expect(await store.setCookie(id, 'new')).toEqual({ kept: false, reason: 'no OS keyring is available' })
    expect(app.data.remoteServers?.[0]?.cookie).toBeUndefined()
    expect(JSON.stringify(app.data)).not.toContain('new')
    expect(await store.list()).toEqual([expect.objectContaining({ id, cookieSaved: false, cookieKept: false })])
    expect(await store.getCookie(id)).toBeUndefined()
  })

  it('a cookie the store cannot decrypt reads as none', async () => {
    const store = make()
    const { id } = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    await store.setCookie(id, 'c')
    app.update((a) => {
      a.remoteServers![0]!.cookie = 'KEYFILE-V1:other'
    })
    expect(await store.getCookie(id)).toBeUndefined()
  })

  it('records recents newest first, deduplicated, capped at 8; saves the local port', () => {
    const store = make()
    const { id } = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    for (let i = 0; i < 10; i++) store.recordRecent(id, `p${i}`, `Project ${i}`, i)
    store.recordRecent(id, 'p5', 'Renamed', 99)
    store.recordRecent(id, 'p6', 'bad\u0007name', 100)
    store.recordRecent(id, '', 'empty id', 100)
    const recent = store.get(id)!.recent
    expect(recent).toHaveLength(8)
    expect(recent[0]).toEqual({ projectId: 'p5', name: 'Renamed', at: 99 })
    expect(recent.filter((r) => r.projectId === 'p5')).toHaveLength(1)
    expect(recent.map((r) => r.projectId)).toEqual(['p5', 'p9', 'p8', 'p7', 'p6', 'p4', 'p3', 'p2'])
    store.setLocalPort(id, 4321)
    expect(store.get(id)!.localPort).toBe(4321)
    expect(() => store.setLocalPort(id, 0)).toThrow(/port/)
    expect(() => store.setLocalPort(id, 70000)).toThrow(/port/)
    expect(() => store.recordRecent('nope', 'p', 'n', 1)).toThrow(/unknown/)
  })

  it('repairs a damaged app.json list on every operation', async () => {
    app.data.remoteServers = [{ id: 'good', name: 'g', via: { kind: 'ssh', host: 'g' }, recent: [] }, { id: 'bad', via: { kind: 'x' } }, 5] as never
    const store = make()
    expect((await store.list()).map((s) => s.id)).toEqual(['good'])
    store.rename('good', 'G')
    expect(app.data.remoteServers).toEqual([{ id: 'good', name: 'G', via: { kind: 'ssh', host: 'g' }, recent: [] }])
  })
})

describe('storedSecretValues with remote servers', () => {
  it('counts each saved server cookie as a stored value of the secret store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-remote-stored-'))
    try {
      writeFileSync(
        join(dir, 'app.json'),
        JSON.stringify({ schemaVersion: 1, remoteServers: [{ id: 'a', cookie: 'KEYFILE-V1:x' }, { id: 'b', cookie: '' }, { id: 'c' }, { id: 'd', cookie: 'dG9r' }, 'junk'] })
      )
      const values = storedSecretValues(dir)
      expect(values.sort()).toEqual(['KEYFILE-V1:x', 'dG9r'])
      const os: SecretStore = { ...fakeSecretStore(), kind: 'os' }
      expect(unreadableCounts(os, values).otherMode).toBe(1)
      writeFileSync(join(dir, 'app.json'), '{not json')
      expect(storedSecretValues(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
