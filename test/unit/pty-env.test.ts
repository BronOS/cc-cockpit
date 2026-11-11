import { describe, expect, it } from 'vitest'
import { buildPtyEnv, isStrippedVar } from '../../src/main/env/pty-env'
import { ENV_BEGIN_MARKER, ENV_END_MARKER, loadLoginEnv } from '../../src/main/env/login-env'

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

  // design-web.md §9.10: a server run from boot signs Claude tabs in with `claude setup-token`'s
  // token in main's environment. That one exact name passes; every other CLAUDE_CODE_* is stripped.
  it('keeps CLAUDE_CODE_OAUTH_TOKEN, by its exact name only', () => {
    const env = buildPtyEnv(
      {
        ...login,
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
        CLAUDE_CODE_OAUTH_TOKEN_X: 'drop',
        CLAUDE_CODE_OAUTH: 'drop',
        CLAUDE_CODE_SSE_PORT: '1234',
        CLAUDE_CODE_ENTRYPOINT: 'cli'
      },
      { binDir: '/b', tab: { tabId: 't1', token: 'tok' } }
    )
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-x')
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN_X', 'CLAUDE_CODE_OAUTH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT']) {
      expect(env).not.toHaveProperty(name)
    }
    expect(isStrippedVar('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false)
    expect(isStrippedVar('CLAUDE_CODE_OAUTH_TOKEN ')).toBe(true)
    expect(isStrippedVar('CLAUDE_CODE_')).toBe(true)
  })

  it('the token passes from the login-shell capture and from its process.env fallback alike', async () => {
    const base = { ...login, SHELL: '/bin/zsh', CLAUDE_CODE_OAUTH_TOKEN: 'from-main', CLAUDE_CODE_ENTRYPOINT: 'cli' }
    // The login shell inherits main's env, so its capture carries the token (and the other names).
    const captured = await loadLoginEnv(base, {
      spawner: async () => ({
        code: 0,
        stdout: `\0${ENV_BEGIN_MARKER}\0PATH=/usr/bin\0CLAUDE_CODE_OAUTH_TOKEN=from-main\0CLAUDE_CODE_SSE_PORT=9\0${ENV_END_MARKER}\0`
      }),
      log: () => {}
    })
    const failed = await loadLoginEnv(base, { spawner: async () => ({ code: 1, stdout: '' }), log: () => {} })
    for (const loginEnv of [captured, failed]) {
      const env = buildPtyEnv(loginEnv, { binDir: '/b' })
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('from-main')
      expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_'))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
    }
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
