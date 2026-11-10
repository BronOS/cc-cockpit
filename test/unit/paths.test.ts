import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  SOCKET_PATH_MAX_BYTES,
  dataPaths,
  fallbackSocketDir,
  pluginDataDir,
  pluginInstallDir,
  projectFile,
  projectId,
  resolveDataDir,
  socketPath
} from '../../src/main/paths'

describe('resolveDataDir', () => {
  it('uses the base when there is no override', () => {
    expect(resolveDataDir('/base', {})).toBe('/base')
  })

  it('prefers CC_COCKPIT_DATA_DIR', () => {
    expect(resolveDataDir('/base', { CC_COCKPIT_DATA_DIR: '/tmp/x' })).toBe('/tmp/x')
  })

  it('ignores an empty override', () => {
    expect(resolveDataDir('/base', { CC_COCKPIT_DATA_DIR: '' })).toBe('/base')
  })

  it('resolves a relative override to an absolute path', () => {
    expect(resolveDataDir('/base', { CC_COCKPIT_DATA_DIR: 'rel/dir' })).toBe(resolve('rel/dir'))
  })
})

describe('dataPaths', () => {
  it('derives every path from the layout', () => {
    const p = dataPaths('/data')
    expect(p).toEqual({
      dataDir: '/data',
      appJson: '/data/app.json',
      projectsDir: '/data/projects',
      pluginsDir: '/data/plugins',
      pluginsJson: '/data/plugins.json',
      pluginDataRoot: '/data/plugin-data',
      logsDir: '/data/logs',
      hooksJson: '/data/hooks.json',
      claudePluginsDir: '/data/claude-plugins',
      secretsJson: '/data/secrets.json',
      webAccessJson: '/data/web-access.json',
      binDir: '/data/bin',
      cccWrapper: '/data/bin/ccc',
      defaultSocket: '/data/app.sock'
    })
  })

  it('derives per-project and per-plugin paths', () => {
    expect(projectFile('/data', 'abc')).toBe('/data/projects/abc.json')
    expect(pluginInstallDir('/data', 'acme.jira', '1.2.0')).toBe('/data/plugins/acme.jira@1.2.0')
    expect(pluginDataDir('/data', 'abc', 'acme.jira')).toBe('/data/plugin-data/abc/acme.jira')
  })
})

describe('projectId', () => {
  it('is 16 hex chars and deterministic', () => {
    const id = projectId('/Users/me/proj')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(projectId('/Users/me/proj')).toBe(id)
    expect(projectId('/Users/me/other')).not.toBe(id)
  })
})

describe('socketPath', () => {
  const tmp = '/tmp'

  it('uses <data>/app.sock when it fits', () => {
    expect(socketPath('/data', {}, 501, tmp)).toBe('/data/app.sock')
  })

  it('keeps a path of exactly the limit and falls back one byte over', () => {
    const base = '/' + 'a'.repeat(SOCKET_PATH_MAX_BYTES - '/app.sock'.length - 1)
    const exact = join(base, 'app.sock')
    expect(Buffer.byteLength(exact)).toBe(SOCKET_PATH_MAX_BYTES)
    expect(socketPath(base, {}, 501, tmp)).toBe(exact)

    const over = base + 'a'
    expect(socketPath(over, {}, 501, tmp).startsWith(fallbackSocketDir(tmp, 501))).toBe(true)
  })

  it('uses a fallback under tmpdir/ccc-<uid> when the path is over 100 bytes', () => {
    const dataDir = '/' + 'long'.repeat(40)
    const sock = socketPath(dataDir, {}, 501, tmp)
    expect(sock).toMatch(/^\/tmp\/ccc-501\/[0-9a-f]{12}\.sock$/)
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES)
  })

  it('is deterministic for the same data dir and differs between data dirs', () => {
    const a = '/' + 'a'.repeat(120)
    const b = '/' + 'b'.repeat(120)
    expect(socketPath(a, {}, 501, tmp)).toBe(socketPath(a, {}, 501, tmp))
    expect(socketPath(a, {}, 501, tmp)).not.toBe(socketPath(b, {}, 501, tmp))
  })

  it('separates users by uid', () => {
    const a = '/' + 'a'.repeat(120)
    expect(socketPath(a, {}, 501, tmp)).not.toBe(socketPath(a, {}, 502, tmp))
  })

  it('honours CC_COCKPIT_SOCK, and falls back when that is too long as well', () => {
    expect(socketPath('/data', { CC_COCKPIT_SOCK: '/run/x.sock' }, 501, tmp)).toBe('/run/x.sock')
    const long = '/' + 'z'.repeat(150)
    expect(socketPath('/data', { CC_COCKPIT_SOCK: long }, 501, tmp)).toMatch(
      /^\/tmp\/ccc-501\/[0-9a-f]{12}\.sock$/
    )
  })

  it('counts bytes, not characters', () => {
    // 60 two-byte characters = 120 bytes but only 60 characters.
    const dataDir = '/' + 'é'.repeat(60)
    expect(socketPath(dataDir, {}, 501, tmp)).toMatch(/^\/tmp\/ccc-501\//)
  })
})
