import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_REMOTE_RECENT,
  MAX_REMOTE_SECRET,
  MAX_REMOTE_SERVERS,
  REMOTE_CCC_MISSING,
  REMOTE_SCRIPT,
  checkCccOverride,
  checkKeyPath,
  checkSshHost,
  checkSshUser,
  chosenServerName,
  hostKeyOf,
  parseRemoteLink,
  remoteCommand,
  splitSshTarget,
  sshAuthOf,
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

describe('validateRemoteServers: built-in SSH, My own tunnel, secrets, host key', () => {
  const FP = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ'

  it('reads an SSH record with user, port, each sign-in and ccc; a record with no auth stays without one (reads as auto)', () => {
    const list = validateRemoteServers([
      { id: 'a', name: 'a', via: { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'key', path: '~/.ssh/id_ed25519' }, ccc: '/opt/ccc' } },
      { id: 'b', name: 'b', via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } } },
      { id: 'c', name: 'c', via: { kind: 'ssh', host: '10.0.0.5', auth: { kind: 'auto' } } },
      { id: 'd', name: 'd', via: { kind: 'ssh', host: 'devbox' } }
    ])
    expect(list.map((s) => s.via)).toEqual([
      { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'key', path: '~/.ssh/id_ed25519' }, ccc: '/opt/ccc' },
      { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } },
      { kind: 'ssh', host: '10.0.0.5', auth: { kind: 'auto' } },
      { kind: 'ssh', host: 'devbox' }
    ])
    const old = list[3]!.via
    expect(old.kind === 'ssh' && sshAuthOf(old)).toEqual({ kind: 'auto' })
  })

  it('splits a first-version user@host at the last @; refuses one beside its own user', () => {
    const list = validateRemoteServers([
      { id: 'a', name: 'a', via: { kind: 'ssh', host: 'me@devbox' } },
      { id: 'b', name: 'b', via: { kind: 'ssh', host: 'me@corp@devbox' } },
      { id: 'c', name: 'c', via: { kind: 'ssh', host: 'me@devbox', user: 'me' } },
      { id: 'd', name: 'd', via: { kind: 'ssh', host: '@devbox' } },
      { id: 'e', name: 'e', via: { kind: 'ssh', host: 'me@' } }
    ])
    expect(list.map((s) => [s.id, s.via])).toEqual([
      ['a', { kind: 'ssh', host: 'devbox', user: 'me' }],
      ['b', { kind: 'ssh', host: 'devbox', user: 'me@corp' }]
    ])
  })

  it('drops a record with a bad user; drops a bad port, auth or key path alone', () => {
    const bad = ['-oX', 'a b', 'me;rm', "it's", 'a\\b', 'x'.repeat(101), 7]
    for (const user of bad) expect(validateRemoteServers([{ id: 'a', via: { kind: 'ssh', host: 'h', user } }])).toEqual([])
    const [server] = validateRemoteServers([{ id: 'a', name: 'a', via: { kind: 'ssh', host: 'h', port: 0, auth: { kind: 'key', path: 'id_rsa' } } }])
    expect(server!.via).toEqual({ kind: 'ssh', host: 'h' })
    for (const port of [70000, 1.5, '22', -1]) expect(validateRemoteServers([{ id: 'a', via: { kind: 'ssh', host: 'h', port } }])[0]!.via).toEqual({ kind: 'ssh', host: 'h' })
    for (const auth of [{ kind: 'agent' }, 'auto', { kind: 'key' }, { kind: 'key', path: '/a\nb' }, { kind: 'key', path: 'x/'.repeat(600) }]) {
      expect(validateRemoteServers([{ id: 'a', via: { kind: 'ssh', host: 'h', auth } }])[0]!.via).toEqual({ kind: 'ssh', host: 'h' })
    }
  })

  it('reads a tunnel; drops one with a bad port and a bad sshHost alone; names it by its host or port', () => {
    const list = validateRemoteServers([
      { id: 'a', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'me@devbox' } },
      { id: 'b', via: { kind: 'tunnel', localPort: 7332, remotePort: 7330, sshHost: 'devbox;rm -rf' } },
      { id: 'c', via: { kind: 'tunnel', localPort: 0, remotePort: 7330 } },
      { id: 'd', via: { kind: 'tunnel', localPort: 7333 } },
      { id: 'e', via: { kind: 'tunnel', localPort: 7334, remotePort: 65536 } }
    ])
    expect(list).toEqual([
      { id: 'a', name: 'me@devbox', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'me@devbox' }, recent: [] },
      { id: 'b', name: 'tunnel :7332', via: { kind: 'tunnel', localPort: 7332, remotePort: 7330 }, recent: [] }
    ])
  })

  it('keeps only the secret the sign-in uses, the host key and listener port only on SSH', () => {
    const list = validateRemoteServers([
      { id: 'p', via: { kind: 'ssh', host: 'h', auth: { kind: 'password' } }, secrets: { password: 'encP', passphrase: 'encK' }, hostKey: { type: 'ssh-ed25519', sha256: FP } },
      { id: 'k', via: { kind: 'ssh', host: 'h2', auth: { kind: 'key', path: '/k' } }, secrets: { password: 'encP', passphrase: 'encK' } },
      { id: 'a', via: { kind: 'ssh', host: 'h3' }, secrets: { password: 'encP' } },
      { id: 'e', via: { kind: 'ssh', host: 'h4', auth: { kind: 'password' } }, secrets: { password: '' } },
      { id: 'l', via: { kind: 'ssh', host: 'h5', auth: { kind: 'password' } }, secrets: { password: 'x'.repeat(4097) } },
      { id: 't', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 }, secrets: { password: 'encP' }, hostKey: { type: 'ssh-ed25519', sha256: FP }, localPort: 9 },
      { id: 'd', via: { kind: 'direct', origin: 'https://box.example' }, localPort: 9, hostKey: { type: 'ssh-ed25519', sha256: FP } }
    ])
    expect(list.map((s) => [s.id, s.secrets, s.hostKey, s.localPort])).toEqual([
      ['p', { password: 'encP' }, { type: 'ssh-ed25519', sha256: FP }, undefined],
      ['k', { passphrase: 'encK' }, undefined, undefined],
      ['a', undefined, undefined, undefined],
      ['e', undefined, undefined, undefined],
      ['l', undefined, undefined, undefined],
      ['t', undefined, undefined, undefined],
      ['d', undefined, undefined, undefined]
    ])
  })

  it('hostKeyOf: an allowlisted type and exactly SHA256: plus 43 base64 characters', () => {
    expect(hostKeyOf({ type: 'ecdsa-sha2-nistp256', sha256: FP })).toEqual({ type: 'ecdsa-sha2-nistp256', sha256: FP })
    expect(hostKeyOf({ type: 'sk-ssh-ed25519@openssh.com', sha256: 'SHA256:ab+/' + 'c'.repeat(39) })).toBeDefined()
    for (const bad of [
      { type: 'ssh-ed25519', sha256: FP.slice(0, -1) },
      { type: 'ssh-ed25519', sha256: FP + 'A' },
      { type: 'ssh-ed25519', sha256: 'MD5:' + 'A'.repeat(43) },
      { type: 'ssh-ed25519', sha256: FP.slice(0, -1) + '=' },
      { type: 'ssh ed25519', sha256: FP },
      { type: '', sha256: FP },
      { type: '-x', sha256: FP },
      { type: 'x'.repeat(65), sha256: FP },
      { type: 'ssh-ed25519' },
      'ssh-ed25519'
    ]) {
      expect(hostKeyOf(bad)).toBeUndefined()
    }
  })

  it('checkSshUser, checkKeyPath and splitSshTarget', () => {
    for (const u of ['me', 'first.last', 'svc_ci-1', 'me@corp.example']) expect(checkSshUser(u)).toBeUndefined()
    for (const u of ['', '-me', 'a b', 'a:b', 'a/b', 'a\nb', 'é', 'x'.repeat(101)]) expect(checkSshUser(u)).toBeDefined()
    for (const p of ['/home/me/.ssh/id_ed25519', '~/.ssh/id_rsa', '/keys/my key']) expect(checkKeyPath(p)).toBeUndefined()
    for (const p of ['', 'id_rsa', '~me/.ssh/id', './id', '/a\u0000b', '/' + 'a'.repeat(1024)]) expect(checkKeyPath(p)).toBeDefined()
    expect(splitSshTarget('devbox')).toEqual({ host: 'devbox' })
    expect(splitSshTarget('a@b@devbox')).toEqual({ user: 'a@b', host: 'devbox' })
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
    // The `ccc` path and the sign-in are settings of the same server, not another one.
    expect(store.add({ via: { kind: 'ssh', host: 'devbox', ccc: '/x/ccc', auth: { kind: 'password' } } }).id).toBe(a.id)
    expect(() => store.add({ via: { kind: 'ssh', host: '-oProxyCommand=x' } })).toThrow()
    expect(() => store.add({ via: { kind: 'ssh', host: 'ok', ccc: "/it's" } })).toThrow()
    expect(() => store.add({ via: { kind: 'direct', origin: 'ftp://x' } })).toThrow(/http/)
    expect(() => store.add({ name: 'a\nb', via: { kind: 'ssh', host: 'h2' } })).toThrow(/name/)
    for (let i = 0; i < 31; i++) store.add({ via: { kind: 'ssh', host: `h${i}` } })
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

  const FP = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ'
  const pw = { kind: 'ssh' as const, host: 'devbox', user: 'me', auth: { kind: 'password' as const } }

  it('adds SSH with user, port, sign-in; splits user@host; refuses bad fields', () => {
    const store = make()
    const a = store.add({ via: { kind: 'ssh', host: ' devbox ', user: ' me ', port: 2222, auth: { kind: 'key', path: ' ~/.ssh/id_ed25519 ' } } })
    expect(a.via).toEqual({ kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'key', path: '~/.ssh/id_ed25519' } })
    expect(store.add({ via: { kind: 'ssh', host: 'ops@box2' } }).via).toEqual({ kind: 'ssh', host: 'box2', user: 'ops' })
    expect(store.add({ via: { kind: 'ssh', host: 'box3', user: '', auth: { kind: 'auto' } } }).via).toEqual({ kind: 'ssh', host: 'box3', auth: { kind: 'auto' } })
    expect(() => store.add({ via: { kind: 'ssh', host: 'me@box4', user: 'me' } })).toThrow(/not both/)
    expect(() => store.add({ via: { kind: 'ssh', host: 'box4', user: 'a b' } })).toThrow(/user name/)
    expect(() => store.add({ via: { kind: 'ssh', host: 'box4', port: 0 } })).toThrow(/port/)
    expect(() => store.add({ via: { kind: 'ssh', host: 'box4', port: 22.5 } })).toThrow(/port/)
    expect(() => store.add({ via: { kind: 'ssh', host: 'box4', auth: { kind: 'key', path: 'id_rsa' } } })).toThrow(/absolute/)
    expect(() => store.add({ via: { kind: 'ssh', host: 'box4', auth: { kind: 'agent' } as never } })).toThrow(/sign in/)
    expect(() => store.add({ via: { kind: 'ssh', host: 'a;b' } })).toThrow()
  })

  it('dedupes SSH by host, user and port: another user or port is another server', () => {
    const store = make()
    const a = store.add({ via: { kind: 'ssh', host: 'devbox', user: 'me', port: 2222 } })
    expect(store.add({ via: { kind: 'ssh', host: 'me@devbox', port: 2222, auth: { kind: 'password' } } }).id).toBe(a.id)
    expect(store.add({ via: { kind: 'ssh', host: 'devbox', user: 'me' } }).id).not.toBe(a.id)
    expect(store.add({ via: { kind: 'ssh', host: 'devbox', user: 'you', port: 2222 } }).id).not.toBe(a.id)
    expect(store.add({ via: { kind: 'ssh', host: 'devbox', port: 2222 } }).id).not.toBe(a.id)
  })

  it('adds a tunnel; the same one again answers it; another on its local port is refused', () => {
    const store = make()
    const t = store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: ' devbox ' } })
    expect(t).toEqual({ id: 'id1', name: 'devbox', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox' }, recent: [] })
    expect(store.add({ name: 'again', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox' } }).id).toBe(t.id)
    expect(() => store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'other' } })).toThrow(/local port 7331 is already used/)
    expect(() => store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 9000, sshHost: 'devbox' } })).toThrow(/already used/)
    expect(() => store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 } })).toThrow(/already used/)
    expect(store.add({ via: { kind: 'tunnel', localPort: 7332, remotePort: 7330 } }).name).toBe('tunnel :7332')
    expect(() => store.add({ via: { kind: 'tunnel', localPort: 0, remotePort: 7330 } })).toThrow(/local port/)
    expect(() => store.add({ via: { kind: 'tunnel', localPort: 7333, remotePort: 65536 } })).toThrow(/server port/)
    expect(() => store.add({ via: { kind: 'tunnel', localPort: 7333, remotePort: 7330, sshHost: 'devbox && rm' } })).toThrow()
    expect(app.data.remoteServers).toHaveLength(2)
  })

  it('remembers a password encrypted beside the cookie, never in a record, list or via', async () => {
    const store = make()
    const { id } = store.add({ via: pw })
    expect(await store.setSecret(id, 'password', 'hunter2', { remember: true })).toEqual({ remembered: true })
    expect(app.data.remoteServers?.[0]?.secrets?.password?.startsWith(FAKE_PREFIX)).toBe(true)
    expect(JSON.stringify(app.data)).not.toContain('hunter2')
    expect(await store.getSecret(id, 'password')).toBe('hunter2')
    // A fresh store (a relaunch) reads it back from the record.
    expect(await make().getSecret(id, 'password')).toBe('hunter2')
    await store.setCookie(id, 'ccc_device-x')
    const listed = (await store.list())[0]!
    expect(listed.remembered).toEqual({ password: true })
    expect('secrets' in listed || 'cookie' in listed).toBe(false)
    expect('secrets' in store.get(id)!).toBe(false)
    expect('secrets' in store.add({ via: pw })).toBe(false)
    expect(JSON.stringify(await store.list())).not.toContain(FAKE_PREFIX)
  })

  it('not remembered: held in memory only, and a stored one is dropped', async () => {
    const store = make()
    const { id } = store.add({ via: pw })
    await store.setSecret(id, 'password', 'old', { remember: true })
    expect(await store.setSecret(id, 'password', 'new', { remember: false })).toEqual({ remembered: false })
    expect(app.data.remoteServers?.[0]?.secrets).toBeUndefined()
    expect(await store.getSecret(id, 'password')).toBe('new')
    expect((await store.list())[0]!.remembered).toEqual({})
    // Memory is this run's only: a relaunch asks again.
    expect(await make().getSecret(id, 'password')).toBeUndefined()
    // Remembering it later drops the memory copy (one place at a time).
    await store.setSecret(id, 'password', 'newer', { remember: true })
    expect(await store.getSecret(id, 'password')).toBe('newer')
    store.clearSecret(id, 'password')
    expect(await store.getSecret(id, 'password')).toBeUndefined()
    expect(app.data.remoteServers?.[0]?.secrets).toBeUndefined()
  })

  it('no keyring: Remember falls back to memory and says why', async () => {
    const store = make(noKeyring)
    const { id } = store.add({ via: { kind: 'ssh', host: 'devbox', auth: { kind: 'key', path: '/k/id' } } })
    expect(await store.setSecret(id, 'passphrase', 'pp', { remember: true })).toEqual({ remembered: false, reason: 'no OS keyring is available' })
    expect(app.data.remoteServers?.[0]?.secrets).toBeUndefined()
    expect(JSON.stringify(app.data)).not.toContain('pp')
    expect(await store.getSecret(id, 'passphrase')).toBe('pp')
  })

  it('refuses a secret the sign-in does not use, an empty or too long one, and an unknown server', async () => {
    const store = make()
    const auto = store.add({ via: { kind: 'ssh', host: 'a' } })
    const pass = store.add({ via: pw })
    const tunnel = store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 } })
    await expect(store.setSecret(auto.id, 'password', 'x', { remember: true })).rejects.toThrow(/does not sign in/)
    await expect(store.setSecret(pass.id, 'passphrase', 'x', { remember: true })).rejects.toThrow(/does not sign in/)
    await expect(store.setSecret(tunnel.id, 'password', 'x', { remember: false })).rejects.toThrow(/does not sign in/)
    await expect(store.setSecret(pass.id, 'password', '', { remember: false })).rejects.toThrow(/enter/)
    await expect(store.setSecret(pass.id, 'password', 'x'.repeat(MAX_REMOTE_SECRET + 1), { remember: false })).rejects.toThrow(/too long/)
    await expect(store.setSecret('nope', 'password', 'x', { remember: false })).rejects.toThrow(/unknown/)
    expect(await store.getSecret(auto.id, 'password')).toBeUndefined()
    expect(await store.getSecret('nope', 'password')).toBeUndefined()
  })

  it('a stored secret the store cannot decrypt reads as none; one of a changed sign-in is not given out', async () => {
    const store = make()
    const { id } = store.add({ via: pw })
    await store.setSecret(id, 'password', 'p', { remember: true })
    app.update((a) => {
      a.remoteServers![0]!.secrets = { password: 'KEYFILE-V1:other' }
    })
    expect(await store.getSecret(id, 'password')).toBeUndefined()
    await store.setSecret(id, 'password', 'mem', { remember: false })
    // The sign-in switches to auto (an Edit): the memory copy stays unread.
    app.update((a) => {
      a.remoteServers![0]!.via = { kind: 'ssh', host: 'devbox', user: 'me' }
    })
    expect(await store.getSecret(id, 'password')).toBeUndefined()
  })

  it('trusts and clears a host key; refuses a bad one and one for a non-SSH server', () => {
    const store = make()
    const { id } = store.add({ via: pw })
    const tunnel = store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 } })
    store.setHostKey(id, { type: 'ssh-ed25519', sha256: FP })
    expect(store.get(id)!.hostKey).toEqual({ type: 'ssh-ed25519', sha256: FP })
    expect(() => store.setHostKey(id, { type: 'ssh-ed25519', sha256: 'SHA256:short' })).toThrow(/fingerprint/)
    expect(() => store.setHostKey(tunnel.id, { type: 'ssh-ed25519', sha256: FP })).toThrow(/only an SSH/)
    expect(() => store.setHostKey('nope', { type: 'ssh-ed25519', sha256: FP })).toThrow(/unknown/)
    expect(() => store.setLocalPort(tunnel.id, 4000)).toThrow(/only an SSH/)
    store.clearHostKey(id)
    expect(store.get(id)!.hostKey).toBeUndefined()
  })

  it('forget drops the cookie, the secrets, the host key and the memory copies', async () => {
    const store = make()
    const a = store.add({ via: pw })
    const b = store.add({ via: { kind: 'ssh', host: 'box2', auth: { kind: 'password' } } })
    await store.setCookie(a.id, 'cookie')
    await store.setSecret(a.id, 'password', 'stored', { remember: true })
    store.setHostKey(a.id, { type: 'ssh-ed25519', sha256: FP })
    await store.setSecret(b.id, 'password', 'held', { remember: false })
    expect(store.forget(a.id)).toBe(true)
    expect(store.forget(b.id)).toBe(true)
    expect(app.data.remoteServers).toBeUndefined()
    // The same ids again (a test seam) find nothing left behind, in the file or in memory.
    ids = 0
    const again = store.add({ via: pw })
    const again2 = store.add({ via: { kind: 'ssh', host: 'box2', auth: { kind: 'password' } } })
    expect([again.id, again2.id]).toEqual([a.id, b.id])
    expect(again.hostKey).toBeUndefined()
    expect(await store.getCookie(a.id)).toBeUndefined()
    expect(await store.getSecret(a.id, 'password')).toBeUndefined()
    expect(await store.getSecret(b.id, 'password')).toBeUndefined()
  })

  it('a secret answered after the server was forgotten is kept nowhere', async () => {
    let release: () => void = () => {}
    const slow: SecretStore = { ...fakeSecretStore(), encrypt: (text) => new Promise((resolve) => (release = () => resolve(`${FAKE_PREFIX}${text}`))) }
    const store = make(slow)
    const { id } = store.add({ via: pw })
    const pending = store.setSecret(id, 'password', 'late', { remember: true })
    await Promise.resolve()
    await Promise.resolve()
    store.forget(id)
    release()
    expect(await pending).toEqual({ remembered: false, reason: expect.stringContaining('forgotten') })
    expect(await store.getSecret(id, 'password')).toBeUndefined()
    expect(app.data.remoteServers).toBeUndefined()
  })

  it('prepare writes nothing; insert saves the prepared record once; a same server answers the saved one', () => {
    const store = make()
    const writes: number[] = []
    const counting: RemoteServersApp = { data: app.data, update: (m) => (writes.push(1), app.update(m)) }
    const s = make(fakeSecretStore(), counting)
    const draft = s.prepare({ name: 'Dev', via: { kind: 'ssh', host: 'me@devbox', port: 2222, auth: { kind: 'password' } } })
    expect(draft).toEqual({
      saved: false,
      record: { id: 'id1', name: 'Dev', via: { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'password' } }, recent: [] },
      via: { kind: 'ssh', host: 'devbox', user: 'me', port: 2222, auth: { kind: 'password' } }
    })
    expect(writes).toEqual([])
    expect(store.get('id1')).toBeUndefined()
    expect(s.insert(draft.record)).toEqual(draft.record)
    expect(writes).toEqual([1])
    // Once saved, the same server (other sign-in: not part of its identity) answers the saved record.
    const again = s.prepare({ via: { kind: 'ssh', host: 'devbox', user: 'me', port: 2222 } })
    expect(again.saved).toBe(true)
    expect(again.record.id).toBe('id1')
    expect(again.via).toEqual({ kind: 'ssh', host: 'devbox', user: 'me', port: 2222 })
    // A record inserted twice, or the same server inserted under another id, is refused.
    expect(() => s.insert(draft.record)).toThrow(/saved already/)
    expect(() => s.insert({ ...draft.record, id: 'other' })).toThrow(/saved meanwhile/)
    expect(() => s.prepare({ via: { kind: 'ssh', host: '-x' } })).toThrow(/cannot start/)
  })

  it('edit keeps the cookie and the host key; a host or port change drops the host key; a sign-in change drops the secret', async () => {
    const store = make()
    const { id } = store.add({ via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } } })
    await store.setCookie(id, 'dev-cookie')
    store.setHostKey(id, { type: 'ssh-ed25519', sha256: `SHA256:${'A'.repeat(43)}` })
    store.setLocalPort(id, 41000)
    await store.setSecret(id, 'password', 'pw', { remember: true })
    // Only the name: everything kept.
    expect(store.edit(id, { name: 'Dev', via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } } })).toEqual({
      viaChanged: false,
      renamed: true,
      identityChanged: false
    })
    // Nothing but an empty name: nothing changed.
    expect(store.edit(id, { name: '', via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } } })).toEqual({
      viaChanged: false,
      renamed: false,
      identityChanged: false
    })
    // A sign-in change: the secret goes, the cookie, key and port stay (the same account on the same machine).
    expect(store.edit(id, { via: { kind: 'ssh', host: 'devbox', auth: { kind: 'auto' } } })).toEqual({ viaChanged: true, renamed: false, identityChanged: false })
    expect(store.get(id)).toMatchObject({ name: 'Dev', hostKey: { type: 'ssh-ed25519' }, localPort: 41000 })
    expect(await store.getCookie(id)).toBe('dev-cookie')
    store.edit(id, { via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } } })
    await store.setSecret(id, 'password', 'pw', { remember: true })
    // Forget the trusted host key (a reinstalled server): an identity change, the password kept.
    expect(store.edit(id, { via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } }, forgetHostKey: true })).toEqual({
      viaChanged: true,
      renamed: false,
      identityChanged: true
    })
    expect(store.get(id)?.hostKey).toBeUndefined()
    expect(store.get(id)?.localPort).toBeUndefined()
    expect(store.hasCookie(id)).toBe(false)
    expect(await store.getSecret(id, 'password')).toBe('pw')
    // The ccc path: maybe another server on the machine: the cookie and port go, the host key stays.
    store.setHostKey(id, { type: 'ssh-ed25519', sha256: `SHA256:${'A'.repeat(43)}` })
    store.setLocalPort(id, 41000)
    await store.setCookie(id, 'dev-cookie')
    expect(store.edit(id, { via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' }, ccc: '/opt/ccc' } }).identityChanged).toBe(true)
    expect(store.get(id)).toMatchObject({ hostKey: { type: 'ssh-ed25519' }, via: { ccc: '/opt/ccc' } })
    expect(store.hasCookie(id)).toBe(false)
    expect(store.get(id)?.localPort).toBeUndefined()
    // The port: another machine may answer, so its key is asked again, and the cookie goes.
    await store.setCookie(id, 'dev-cookie')
    expect(store.edit(id, { via: { kind: 'ssh', host: 'devbox', port: 2222, auth: { kind: 'password' } } }).identityChanged).toBe(true)
    expect(store.get(id)?.hostKey).toBeUndefined()
    expect(store.hasCookie(id)).toBe(false)
    expect(await store.getSecret(id, 'password')).toBeUndefined()
    // A memory-held secret goes with a sign-in change too.
    await store.setSecret(id, 'password', 'mem', { remember: false })
    store.edit(id, { via: { kind: 'ssh', host: 'devbox', port: 2222, user: 'root', auth: { kind: 'password' } } })
    expect(await store.getSecret(id, 'password')).toBeUndefined()
  })

  it('edit refuses another kind, a clash with another server and an unknown id; a tunnel or Direct origin change drops the cookie', async () => {
    const store = make()
    const a = store.add({ via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 } })
    store.add({ via: { kind: 'tunnel', localPort: 7332, remotePort: 7330 } })
    expect(() => store.edit(a.id, { via: { kind: 'direct', origin: 'https://box' } })).toThrow(/cannot change how a server is reached/)
    expect(() => store.edit(a.id, { via: { kind: 'tunnel', localPort: 7332, remotePort: 7330 } })).toThrow(/already saved/)
    expect(() => store.edit('nope', { via: { kind: 'tunnel', localPort: 7333, remotePort: 7330 } })).toThrow(/unknown server/)
    await store.setCookie(a.id, 'tunnel-cookie')
    expect(store.edit(a.id, { via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 } }).identityChanged).toBe(false)
    expect(await store.getCookie(a.id)).toBe('tunnel-cookie')
    expect(store.edit(a.id, { via: { kind: 'tunnel', localPort: 7340, remotePort: 7330, sshHost: 'devbox' } }).identityChanged).toBe(true)
    expect(store.get(a.id)?.via).toEqual({ kind: 'tunnel', localPort: 7340, remotePort: 7330, sshHost: 'devbox' })
    expect(store.hasCookie(a.id)).toBe(false)
    const d = store.add({ via: { kind: 'direct', origin: 'https://box.example' } })
    await store.setCookie(d.id, 'direct-cookie')
    store.edit(d.id, { via: { kind: 'direct', origin: 'https://box.example' } })
    expect(await store.getCookie(d.id)).toBe('direct-cookie')
    expect(store.edit(d.id, { via: { kind: 'direct', origin: 'https://other.example' } }).identityChanged).toBe(true)
    expect(store.hasCookie(d.id)).toBe(false)
  })

  it("edit: an unnamed server's name follows its address; a name the person chose stays", () => {
    const store = make()
    const { id } = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    expect(store.get(id)?.name).toBe('devbox')
    // Edit sends the name it showed: unchanged, so still the default, of the new host now.
    expect(store.edit(id, { name: 'devbox', via: { kind: 'ssh', host: 'newbox' } }).renamed).toBe(true)
    expect(store.get(id)?.name).toBe('newbox')
    expect(chosenServerName(store.get(id)!)).toBeUndefined()
    store.edit(id, { name: 'Work', via: { kind: 'ssh', host: 'newbox' } })
    store.edit(id, { name: 'Work', via: { kind: 'ssh', host: 'thirdbox' } })
    expect(store.get(id)?.name).toBe('Work')
    expect(chosenServerName(store.get(id)!)).toBe('Work')
    const d = store.add({ via: { kind: 'direct', origin: 'https://box.example:8443' } })
    expect(chosenServerName(store.get(d.id)!)).toBeUndefined()
    store.edit(d.id, { name: 'box.example:8443', via: { kind: 'direct', origin: 'https://other.example' } })
    expect(store.get(d.id)?.name).toBe('other.example')
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
  it('counts each saved server cookie, password and passphrase as a stored value of the secret store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-remote-stored-'))
    try {
      writeFileSync(
        join(dir, 'app.json'),
        JSON.stringify({
          schemaVersion: 1,
          remoteServers: [
            { id: 'a', cookie: 'KEYFILE-V1:x' },
            { id: 'b', cookie: '' },
            { id: 'c' },
            { id: 'd', cookie: 'dG9r' },
            { id: 'e', secrets: { password: 'KEYFILE-V1:pw', passphrase: 'cGFzcw' } },
            { id: 'f', secrets: { password: '', passphrase: 7 } },
            { id: 'g', secrets: 'junk' },
            'junk'
          ]
        })
      )
      const values = storedSecretValues(dir)
      expect(values.sort()).toEqual(['KEYFILE-V1:pw', 'KEYFILE-V1:x', 'cGFzcw', 'dG9r'])
      const os: SecretStore = { ...fakeSecretStore(), kind: 'os' }
      expect(unreadableCounts(os, values).otherMode).toBe(2)
      writeFileSync(join(dir, 'app.json'), '{not json')
      expect(storedSecretValues(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
