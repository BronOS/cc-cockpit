import { describe, expect, it } from 'vitest'
import { buildPtyEnv } from '../../src/main/env/pty-env'

const login = { PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'en_US.UTF-8' }

describe('buildPtyEnv', () => {
  it('prepends the bin dir to PATH and sets terminal vars', () => {
    const env = buildPtyEnv(login, { binDir: '/data/bin' })
    expect(env.PATH).toBe('/data/bin:/usr/bin:/bin')
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.HOME).toBe('/home/u')
  })

  it('uses just the bin dir when PATH is unset', () => {
    expect(buildPtyEnv({}, { binDir: '/data/bin' }).PATH).toBe('/data/bin')
  })

  it('strips CLAUDECODE, CLAUDE_CODE_* and ELECTRON_* but keeps look-alikes', () => {
    const env = buildPtyEnv(
      {
        ...login,
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        CLAUDE_CONFIG_DIR: '/keep',
        MY_ELECTRON_X: 'keep'
      },
      { binDir: '/b' }
    )
    expect(env).not.toHaveProperty('CLAUDECODE')
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env).not.toHaveProperty('ELECTRON_NO_ATTACH_CONSOLE')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/keep')
    expect(env.MY_ELECTRON_X).toBe('keep')
  })

  it('adds tab vars only when given, and drops stale inherited ones', () => {
    const stale = { ...login, APP_TAB_TOKEN: 'old', APP_TAB_ID: 'old', CC_COCKPIT_SOCK: '/old' }
    const shell = buildPtyEnv(stale, { binDir: '/b' })
    expect(shell).not.toHaveProperty('APP_TAB_ID')
    expect(shell).not.toHaveProperty('APP_TAB_TOKEN')
    expect(shell).not.toHaveProperty('CC_COCKPIT_SOCK')

    const claude = buildPtyEnv(stale, { binDir: '/b', tab: { tabId: 't1', token: 'tok', sock: '/s.sock' } })
    expect(claude.APP_TAB_ID).toBe('t1')
    expect(claude.APP_TAB_TOKEN).toBe('tok')
    expect(claude.CC_COCKPIT_SOCK).toBe('/s.sock')

    // A terminal overlay: a token and the socket, but it is not a tab, so no tab id (an inherited
    // one is dropped too).
    const overlay = buildPtyEnv(stale, { binDir: '/b', tab: { token: 'win', sock: '/s.sock' } })
    expect(overlay.APP_TAB_TOKEN).toBe('win')
    expect(overlay.CC_COCKPIT_SOCK).toBe('/s.sock')
    expect(overlay).not.toHaveProperty('APP_TAB_ID')

    // No socket (main is not listening): the inherited path is dropped, never passed through.
    const noSock = buildPtyEnv(stale, { binDir: '/b', tab: { tabId: 't1', token: 'tok' } })
    expect(noSock.APP_TAB_TOKEN).toBe('tok')
    expect(noSock).not.toHaveProperty('CC_COCKPIT_SOCK')
  })
})
