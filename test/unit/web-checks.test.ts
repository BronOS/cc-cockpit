// Web access: the always-on checks (main/web/checks.ts, design-web.md §4.1) and the settings
// reading and listen plan (main/web/settings.ts). Ported in part from the spike's server test.
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { allowedHosts, checkHost, checkOrigin, secretMatches, webShellCsp } from '../../src/main/web/checks'
import {
  DEFAULT_WEB_ACCESS,
  DEFAULT_WEB_PORT,
  externalOriginOf,
  hostEntryOf,
  isLoopbackBind,
  listenPlanOf,
  MAX_WEB_HOSTS,
  webAccessOf
} from '../../src/main/web/settings'

function iface(address: string, family: 'IPv4' | 'IPv6', internal: boolean): NetworkInterfaceInfo {
  return { address, family, internal, netmask: '', mac: '', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}) } as NetworkInterfaceInfo
}

const INTERFACES = {
  lo: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
  enp1s0: [iface('192.168.1.20', 'IPv4', false), iface('fe80::1', 'IPv6', false)]
}

describe('webAccessOf', () => {
  it('is off with the defaults when absent or damaged', () => {
    expect(webAccessOf(undefined)).toEqual(DEFAULT_WEB_ACCESS)
    expect(webAccessOf('on')).toEqual(DEFAULT_WEB_ACCESS)
    expect(webAccessOf([])).toEqual(DEFAULT_WEB_ACCESS)
    expect(DEFAULT_WEB_ACCESS.enabled).toBe(false)
  })

  it('is on only for exactly true', () => {
    expect(webAccessOf({ enabled: true }).enabled).toBe(true)
    for (const enabled of ['true', 1, 'yes', null, {}]) expect(webAccessOf({ enabled }).enabled).toBe(false)
  })

  it('reads each damaged field as its own default', () => {
    const s = webAccessOf({ enabled: true, port: 80, bind: 7, mode: 'open', hosts: 'a', externalOrigin: 'ftp://x', tls: { certPath: 1 } })
    expect(s).toEqual({ ...DEFAULT_WEB_ACCESS, enabled: true })
    for (const port of [0, 1023, 65536, 7330.5, '7331', NaN]) expect(webAccessOf({ port }).port).toBe(DEFAULT_WEB_PORT)
    expect(webAccessOf({ port: 1024 }).port).toBe(1024)
    expect(webAccessOf({ port: 65535 }).port).toBe(65535)
  })

  it('keeps a network bind as typed (refused later), lowercased and trimmed', () => {
    expect(webAccessOf({ bind: ' 0.0.0.0 ' }).bind).toBe('0.0.0.0')
    expect(webAccessOf({ bind: 'LocalHost' }).bind).toBe('localhost')
    expect(webAccessOf({ bind: '  ' }).bind).toBe('127.0.0.1')
  })

  it('reads the mode, the TLS paths and the external origin', () => {
    for (const mode of ['link', 'password', 'confirm', 'none'] as const) expect(webAccessOf({ mode }).mode).toBe(mode)
    expect(webAccessOf({ mode: 'toString' }).mode).toBe('link')
    expect(webAccessOf({ tls: { certPath: '/c.pem', keyPath: '/k.pem' } }).tls).toEqual({ certPath: '/c.pem', keyPath: '/k.pem' })
    expect(webAccessOf({ tls: { certPath: '/c.pem', keyPath: '' } }).tls).toBeUndefined()
    expect(webAccessOf({ externalOrigin: 'https://Box.Tail1234.ts.net/' }).externalOrigin).toBe('https://box.tail1234.ts.net')
  })

  it('normalises the host list, drops bad and duplicate entries, and caps it', () => {
    const s = webAccessOf({ port: 7777, hosts: ['DevBox.local', 'proxy.lan:443', 'devbox.local:7777', '', 7, 'a/b', 'user@x', 'x?y', 'http://x'] })
    expect(s.hosts).toEqual(['devbox.local:7777', 'proxy.lan:443'])
    const many = Array.from({ length: MAX_WEB_HOSTS + 10 }, (_, i) => `h${i}`)
    expect(webAccessOf({ hosts: many }).hosts).toHaveLength(MAX_WEB_HOSTS)
  })
})

describe('hostEntryOf / externalOriginOf', () => {
  it('takes plain names, IPs and bracketed IPv6 with or without a port', () => {
    expect(hostEntryOf('my-vm.tail1234.ts.net', 7330)).toBe('my-vm.tail1234.ts.net:7330')
    expect(hostEntryOf('10.0.0.7:9000', 7330)).toBe('10.0.0.7:9000')
    expect(hostEntryOf('[fe80::1]:9000', 7330)).toBe('[fe80::1]:9000')
    expect(hostEntryOf(' MAC.local ', 7330)).toBe('mac.local:7330')
  })

  it('refuses anything that is not a plain host', () => {
    for (const bad of ['', ' ', 'a b', 'a/b', 'a\\b', 'u:p@h', 'h#x', 'h?x', 'http://h', 'h:99999', ':80', 'a'.repeat(400), undefined, 3]) {
      expect(hostEntryOf(bad, 7330), String(bad)).toBeUndefined()
    }
  })

  it('takes an http(s) origin and nothing more', () => {
    expect(externalOriginOf('https://box.ts.net')).toBe('https://box.ts.net')
    expect(externalOriginOf('https://box.ts.net:443/')).toBe('https://box.ts.net')
    expect(externalOriginOf('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
    for (const bad of ['box.ts.net', 'ftp://box', 'https://box/path', 'https://box/?', 'https://box/#x', 'https://u:p@box', 'javascript:alert(1)', '', 5]) {
      expect(externalOriginOf(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('listenPlanOf', () => {
  const on = (over: object) => webAccessOf({ enabled: true, ...over })

  it('does not listen while off', () => {
    expect(listenPlanOf(webAccessOf({}))).toEqual({ ok: false, reason: 'web access is off' })
  })

  it('listens on loopback binds', () => {
    for (const bind of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
      expect(listenPlanOf(on({ bind })), bind).toMatchObject({ ok: true, bind, port: DEFAULT_WEB_PORT })
    }
  })

  it('refuses every network bind until TLS and the confirms exist', () => {
    for (const bind of ['0.0.0.0', '::', '192.168.1.20', 'devbox.local', '128.0.0.1', '127.0.0.1.evil.example', '1.127.0.0']) {
      const plan = listenPlanOf(on({ bind }))
      expect(plan.ok, bind).toBe(false)
      if (!plan.ok) expect(plan.reason).toContain('loopback only')
    }
  })

  it('refuses a plain-http external origin on a network name, allows https and loopback http', () => {
    expect(listenPlanOf(on({ externalOrigin: 'http://box.lan' })).ok).toBe(false)
    expect(listenPlanOf(on({ externalOrigin: 'https://box.ts.net' }))).toMatchObject({ ok: true, externalOrigin: 'https://box.ts.net' })
    expect(listenPlanOf(on({ externalOrigin: 'http://localhost:8080' })).ok).toBe(true)
  })

  it('tells loopback binds from network ones', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true)
    expect(isLoopbackBind('localhost')).toBe(true)
    expect(isLoopbackBind('0.0.0.0')).toBe(false)
    expect(isLoopbackBind('localhost.evil.example')).toBe(false)
  })
})

describe('allowedHosts / checkHost', () => {
  it('allows the loopback names with the port, the person’s hosts and the proxy’s host, nothing from the interfaces', () => {
    const hosts = allowedHosts({
      bind: '127.0.0.1',
      port: 7777,
      hosts: ['my-vm.tail1234.ts.net:7777', 'proxy.lan:443'],
      externalOrigin: 'https://box.ts.net',
      interfaces: INTERFACES,
      hostname: 'DevBox'
    })
    for (const host of ['127.0.0.1:7777', 'localhost:7777', 'LOCALHOST:7777', '[::1]:7777', 'my-vm.tail1234.ts.net:7777', 'proxy.lan:443', 'box.ts.net']) {
      expect(checkHost(host, hosts), host).toBe(host.toLowerCase())
    }
    for (const host of ['192.168.1.20:7777', 'devbox:7777', 'devbox.local:7777']) expect(checkHost(host, hosts), host).toBeUndefined()
  })

  it('refuses a rebinding name, another port, a smuggled suffix and a missing Host', () => {
    const hosts = allowedHosts({ bind: '127.0.0.1', port: 7777, hosts: [] })
    for (const host of ['evil.example:7777', '127.0.0.1:8888', '127.0.0.1', 'localhost', '127.0.0.1:7777.evil.example', '', ' ']) {
      expect(checkHost(host, hosts), host).toBeUndefined()
    }
    expect(checkHost(undefined, hosts)).toBeUndefined()
  })

  it('adds the machine’s addresses and mDNS name only for a network bind (plan Task 28)', () => {
    const hosts = allowedHosts({ bind: '0.0.0.0', port: 1, hosts: [], interfaces: INTERFACES, hostname: 'mac.local' })
    expect([...hosts].sort()).toEqual(['0.0.0.0:1', '127.0.0.1:1', '192.168.1.20:1', '[::1]:1', 'localhost:1', 'mac.local:1'])
  })
})

describe('checkOrigin', () => {
  const rule = { scheme: 'http' as const }

  it('wants the page origin of the very host the request came in on', () => {
    expect(checkOrigin('http://127.0.0.1:7777', '127.0.0.1:7777', rule)).toBe(true)
    expect(checkOrigin('http://localhost:7777', 'localhost:7777', rule)).toBe(true)
  })

  it('refuses another allowed name, another port, another scheme, null and no Origin', () => {
    expect(checkOrigin('http://localhost:7777', '127.0.0.1:7777', rule)).toBe(false)
    // Every localhost page is same-site: a dev server on another port must not get in.
    expect(checkOrigin('http://localhost:3000', 'localhost:7777', rule)).toBe(false)
    expect(checkOrigin('https://127.0.0.1:7777', '127.0.0.1:7777', rule)).toBe(false)
    expect(checkOrigin('http://evil.example', '127.0.0.1:7777', rule)).toBe(false)
    expect(checkOrigin('null', '127.0.0.1:7777', rule)).toBe(false)
    expect(checkOrigin('http://127.0.0.1:7777/', '127.0.0.1:7777', rule)).toBe(false)
    expect(checkOrigin('', '127.0.0.1:7777', rule)).toBe(false)
    expect(checkOrigin(undefined, '127.0.0.1:7777', rule)).toBe(false)
  })

  it('takes the external origin behind a proxy while Host is loopback', () => {
    const behind = { scheme: 'http' as const, externalOrigin: 'https://box.ts.net' }
    expect(checkOrigin('https://box.ts.net', '127.0.0.1:7777', behind)).toBe(true)
    expect(checkOrigin('https://BOX.ts.net', '127.0.0.1:7777', behind)).toBe(true)
    expect(checkOrigin('http://box.ts.net', '127.0.0.1:7777', behind)).toBe(false)
    expect(checkOrigin('https://other.ts.net', '127.0.0.1:7777', behind)).toBe(false)
  })
})

describe('secretMatches / webShellCsp', () => {
  it('compares secrets exactly', () => {
    expect(secretMatches('abc', 'abc')).toBe(true)
    expect(secretMatches('abd', 'abc')).toBe(false)
    expect(secretMatches('ab', 'abc')).toBe(false)
    expect(secretMatches('', 'abc')).toBe(false)
    expect(secretMatches('', '')).toBe(false)
    expect(secretMatches(undefined, 'abc')).toBe(false)
    expect(secretMatches(['abc'], 'abc')).toBe(false)
  })

  it('keeps the shell unframeable, frames to the plugin paths only', () => {
    const csp = webShellCsp(['http://127.0.0.1:7777', 'https://box.ts.net', 'http://127.0.0.1:7777'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain('frame-src http://127.0.0.1:7777/p/ http://127.0.0.1:7777/o/ https://box.ts.net/p/ https://box.ts.net/o/;')
    expect(webShellCsp([])).toContain("frame-src 'none'")
  })
})
