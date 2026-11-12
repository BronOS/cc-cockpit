// The ~/.ssh/config reader (src/main/remote/ssh-config.ts) over an in-memory file system: nothing
// here reads the real ~/.ssh. `files` maps absolute paths to text; directories are derived from them.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hostPatternsMatch,
  nodeSshConfigFiles,
  resolveSshConfig,
  splitConfigArgs,
  SSH_CONFIG_MAX_BYTES,
  wildcardMatch,
  type SshConfigOptions
} from '../../src/main/remote/ssh-config'

const HOME = '/home/u'
const CONFIG = `${HOME}/.ssh/config`

function memFs(files: Record<string, string>): Pick<SshConfigOptions, 'read' | 'list'> & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    read: async (path) => {
      reads.push(path)
      return files[path] ?? null
    },
    list: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const names = new Set<string>()
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!)
      return names.size === 0 ? null : [...names]
    }
  }
}

function resolve(host: string, files: Record<string, string>) {
  return resolveSshConfig(host, { home: HOME, ...memFs(files) })
}

describe('wildcardMatch and Host patterns', () => {
  it('matches * and ? without a regex', () => {
    expect(wildcardMatch('*', 'anything')).toBe(true)
    expect(wildcardMatch('dev*', 'devbox')).toBe(true)
    expect(wildcardMatch('*.corp', 'a.b.corp')).toBe(true)
    expect(wildcardMatch('*.corp', 'corp')).toBe(false)
    expect(wildcardMatch('h?st', 'host')).toBe(true)
    expect(wildcardMatch('h?st', 'hst')).toBe(false)
    expect(wildcardMatch('a*b*c', 'aXXbYYc')).toBe(true)
    expect(wildcardMatch('a*b*c', 'aXXbYY')).toBe(false)
    expect(wildcardMatch('', '')).toBe(true)
  })

  it('a matching negation turns the line off wherever it stands; case does not matter', () => {
    expect(hostPatternsMatch(['*', '!bastion'], 'devbox')).toBe(true)
    expect(hostPatternsMatch(['*', '!bastion'], 'bastion')).toBe(false)
    expect(hostPatternsMatch(['!bastion', '*'], 'bastion')).toBe(false)
    expect(hostPatternsMatch(['!bastion'], 'devbox')).toBe(false)
    expect(hostPatternsMatch(['DevBox'], 'devBOX')).toBe(true)
  })

  it('splits arguments with quotes, escapes and a trailing comment', () => {
    expect(splitConfigArgs('a b\t c')).toEqual(['a', 'b', 'c'])
    expect(splitConfigArgs('"~/My Keys/id" x')).toEqual(['~/My Keys/id', 'x'])
    expect(splitConfigArgs("'it''s' a\\ b")).toEqual(['its', 'a b'])
    expect(splitConfigArgs('value # a comment')).toEqual(['value'])
    expect(splitConfigArgs('"open')).toBeNull()
  })
})

describe('resolveSshConfig', () => {
  it('reads the basic keywords for a matching block, case-insensitive, both = and blank forms', async () => {
    const r = await resolve('devbox', {
      [CONFIG]: [
        '# comment',
        'host devbox',
        '  HOSTNAME devbox.lan',
        '  user=alice',
        '  Port = 2222',
        '  IdentityFile ~/.ssh/id_devbox',
        '  IdentityFile "/keys/with space"',
        '  IdentityAgent ~/.1password/agent.sock',
        ''
      ].join('\r\n')
    })
    expect(r).toEqual({
      hostName: 'devbox.lan',
      user: 'alice',
      port: 2222,
      identityFiles: [`${HOME}/.ssh/id_devbox`, '/keys/with space'],
      identityAgent: { kind: 'path', path: `${HOME}/.1password/agent.sock` },
      jump: false,
      matchSkipped: false,
      notes: []
    })
  })

  it('first value wins across blocks; IdentityFile accumulates in order', async () => {
    const r = await resolve('web1', {
      [CONFIG]: [
        'Host web?',
        '  User deploy',
        '  IdentityFile ~/.ssh/web',
        'Host other',
        '  User nobody',
        'Host *',
        '  User fallback',
        '  Port 22',
        '  IdentityFile ~/.ssh/web',
        '  IdentityFile ~/.ssh/id_ed25519'
      ].join('\n')
    })
    expect(r.user).toBe('deploy')
    expect(r.port).toBe(22)
    expect(r.hostName).toBeUndefined()
    expect(r.identityFiles).toEqual([`${HOME}/.ssh/web`, `${HOME}/.ssh/id_ed25519`])
  })

  it('lines before any Host apply to every host; a negated block is skipped', async () => {
    const files = {
      [CONFIG]: ['User top', 'Host * !bastion', '  Port 2200', 'Host bastion', '  Port 22'].join('\n')
    }
    expect((await resolve('devbox', files)).port).toBe(2200)
    const b = await resolve('bastion', files)
    expect(b.port).toBe(22)
    expect(b.user).toBe('top')
  })

  it('several patterns on one Host line', async () => {
    const files = { [CONFIG]: 'Host alpha beta *.corp\n  User team\n' }
    expect((await resolve('beta', files)).user).toBe('team')
    expect((await resolve('x.corp', files)).user).toBe('team')
    expect((await resolve('gamma', files)).user).toBeUndefined()
  })

  it('a value with a % token is ignored and named, and still counts as the first value', async () => {
    const r = await resolve('devbox', {
      [CONFIG]: [
        'Host devbox',
        '  IdentityFile ~/.ssh/%h.key',
        '  IdentityFile ~/.ssh/id_ok',
        '  User %u',
        'Host *',
        '  User later'
      ].join('\n')
    })
    expect(r.identityFiles).toEqual([`${HOME}/.ssh/id_ok`])
    expect(r.user).toBeUndefined()
    expect(r.notes.some((n) => n.includes('%h.key'))).toBe(true)
    expect(r.notes.some((n) => n.includes('User %u'))).toBe(true)
  })

  it('HostName expands %h and %%; other tokens leave it unset', async () => {
    expect((await resolve('devbox', { [CONFIG]: 'Host *\n HostName %h.example.com\n' })).hostName).toBe('devbox.example.com')
    const r = await resolve('devbox', { [CONFIG]: 'Host *\n HostName %d.example.com\n' })
    expect(r.hostName).toBeUndefined()
    expect(r.notes).toHaveLength(1)
  })

  it('relative and ~user paths are not guessed at; a bad port is named', async () => {
    const r = await resolve('h', { [CONFIG]: 'IdentityFile keys/id\nIdentityFile ~bob/id\nPort 70000\n' })
    expect(r.identityFiles).toEqual([])
    expect(r.port).toBeUndefined()
    expect(r.notes).toHaveLength(3)
  })

  it('IdentityAgent forms: none, SSH_AUTH_SOCK, $NAME', async () => {
    expect((await resolve('h', { [CONFIG]: 'IdentityAgent none' })).identityAgent).toEqual({ kind: 'none' })
    expect((await resolve('h', { [CONFIG]: 'IdentityAgent SSH_AUTH_SOCK' })).identityAgent).toEqual({ kind: 'env', name: 'SSH_AUTH_SOCK' })
    expect((await resolve('h', { [CONFIG]: 'IdentityAgent $MY_SOCK' })).identityAgent).toEqual({ kind: 'env', name: 'MY_SOCK' })
    expect((await resolve('h', { [CONFIG]: 'IdentityAgent $1bad' })).identityAgent).toBeUndefined()
  })

  it('ProxyJump and ProxyCommand report jump; the first one decides and none is a direct dial', async () => {
    expect((await resolve('h', { [CONFIG]: 'Host h\n ProxyJump bastion\n' })).jump).toBe(true)
    expect((await resolve('h', { [CONFIG]: 'Host h\n ProxyCommand ssh -W %h:%p bastion\n' })).jump).toBe(true)
    expect((await resolve('h', { [CONFIG]: 'Host h\n ProxyJump none\nHost *\n ProxyCommand nc %h %p\n' })).jump).toBe(false)
    expect((await resolve('other', { [CONFIG]: 'Host h\n ProxyJump bastion\n' })).jump).toBe(false)
  })

  it('Match blocks are skipped up to the next Host, and reported', async () => {
    const r = await resolve('devbox', {
      [CONFIG]: ['Match host devbox exec "true"', '  User frommatch', 'Host devbox', '  Port 2022'].join('\n')
    })
    expect(r.user).toBeUndefined()
    expect(r.port).toBe(2022)
    expect(r.matchSkipped).toBe(true)
  })

  it('a missing config is an empty result with no notes', async () => {
    expect(await resolve('devbox', {})).toEqual({ identityFiles: [], jump: false, matchSkipped: false, notes: [] })
  })

  it('Include: relative to ~/.ssh, absolute and ~ forms, globs sorted, dot files left out, in place', async () => {
    const r = await resolve('devbox', {
      [CONFIG]: ['Include config.d/*.conf ~/extra', 'Host *', '  User last', '  Port 1'].join('\n'),
      [`${HOME}/.ssh/config.d/b.conf`]: 'Host devbox\n  Port 2002\n',
      [`${HOME}/.ssh/config.d/a.conf`]: 'Host devbox\n  User from-a\n',
      [`${HOME}/.ssh/config.d/.hidden.conf`]: 'Host devbox\n  HostName hidden\n',
      [`${HOME}/.ssh/config.d/c.txt`]: 'Host devbox\n  HostName txt\n',
      [`${HOME}/extra`]: 'IdentityFile ~/.ssh/extra_key\n'
    })
    expect(r.user).toBe('from-a')
    expect(r.port).toBe(2002)
    expect(r.hostName).toBeUndefined()
    expect(r.identityFiles).toEqual([`${HOME}/.ssh/extra_key`])
  })

  it('Include globs in a directory part', async () => {
    const r = await resolve('devbox', {
      [CONFIG]: 'Include /etc/ssh/*/devbox.conf',
      '/etc/ssh/one/devbox.conf': 'User one\n'
    })
    expect(r.user).toBe('one')
  })

  it('an Include inside a block that does not match is not read; Host lines in it do not leak out', async () => {
    const fs = memFs({
      [CONFIG]: ['Host other', '  Include skipped', 'Host devbox', '  Include inc', '  User main'].join('\n'),
      [`${HOME}/.ssh/skipped`]: 'User wrong\n',
      [`${HOME}/.ssh/inc`]: 'Host nomatch\n  Port 9\n'
    })
    const r = await resolveSshConfig('devbox', { home: HOME, ...fs })
    expect(fs.reads).not.toContain(`${HOME}/.ssh/skipped`)
    expect(r.port).toBeUndefined()
    // Back in the including file, the devbox block is active again after the include's own Host line.
    expect(r.user).toBe('main')
  })

  it('an Include loop is cut and named', async () => {
    const fs = memFs({
      [CONFIG]: 'Include a\nUser top\n',
      [`${HOME}/.ssh/a`]: 'Include b\n',
      [`${HOME}/.ssh/b`]: 'Include a\nInclude config\nPort 7\n'
    })
    const r = await resolveSshConfig('h', { home: HOME, ...fs })
    expect(r.port).toBe(7)
    expect(r.user).toBe('top')
    expect(r.notes.filter((n) => n.startsWith('Include loop'))).toHaveLength(2)
    expect(fs.reads).toEqual([CONFIG, `${HOME}/.ssh/a`, `${HOME}/.ssh/b`])
  })

  it('Include depth stops at 4 levels below the main file', async () => {
    const files: Record<string, string> = { [CONFIG]: 'Include l1\n' }
    for (let i = 1; i <= 5; i++) files[`${HOME}/.ssh/l${i}`] = `Include l${i + 1}\nIdentityFile ~/.ssh/k${i}\n`
    const r = await resolve('h', files)
    // Each Include is read in place, before its file's own IdentityFile line: deepest first.
    expect(r.identityFiles).toEqual([4, 3, 2, 1].map((i) => `${HOME}/.ssh/k${i}`))
    expect(r.notes.some((n) => n.includes('deeper than 4') && n.includes('l5'))).toBe(true)
  })

  it('a file over 256 KiB is not read and is named', async () => {
    const big = `User big\n${'#'.repeat(SSH_CONFIG_MAX_BYTES)}\n`
    const r = await resolve('h', { [CONFIG]: 'Include big\nPort 3\n', [`${HOME}/.ssh/big`]: big })
    expect(r.user).toBeUndefined()
    expect(r.port).toBe(3)
    expect(r.notes.some((n) => n.includes('over 256 KiB'))).toBe(true)
  })

  it('a line with an unterminated quote is ignored and named', async () => {
    const r = await resolve('h', { [CONFIG]: 'User "alice\nPort 5\n' })
    expect(r.user).toBeUndefined()
    expect(r.port).toBe(5)
    expect(r.notes).toHaveLength(1)
  })
})

describe('nodeSshConfigFiles', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('reads regular files up to the cap plus one byte, lists directories, null for the rest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ssh-config-'))
    writeFileSync(join(dir, 'small'), 'Host x\n')
    writeFileSync(join(dir, 'big'), Buffer.alloc(SSH_CONFIG_MAX_BYTES + 100, 0x23))
    mkdirSync(join(dir, 'sub'))
    expect(await nodeSshConfigFiles.read(join(dir, 'small'))).toBe('Host x\n')
    expect((await nodeSshConfigFiles.read(join(dir, 'big')))?.length).toBe(SSH_CONFIG_MAX_BYTES + 1)
    expect(await nodeSshConfigFiles.read(join(dir, 'sub'))).toBeNull()
    expect(await nodeSshConfigFiles.read(join(dir, 'missing'))).toBeNull()
    expect((await nodeSshConfigFiles.list(dir))?.sort()).toEqual(['big', 'small', 'sub'])
    expect(await nodeSshConfigFiles.list(join(dir, 'missing'))).toBeNull()
  })

  it('resolves through the real file system against an injected home', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ssh-config-'))
    mkdirSync(join(dir, '.ssh', 'conf.d'), { recursive: true })
    writeFileSync(join(dir, '.ssh', 'config'), 'Include conf.d/*\n')
    writeFileSync(join(dir, '.ssh', 'conf.d', 'one'), 'Host devbox\n  User real\n')
    const r = await resolveSshConfig('devbox', { home: dir, ...nodeSshConfigFiles })
    expect(r.user).toBe('real')
  })
})
