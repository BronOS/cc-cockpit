import { describe, expect, it } from 'vitest'
import {
  claudeArgv,
  commandArgv,
  commandOverlaySpec,
  loginShellOf,
  PROMPT_AFTER_DOUBLE_DASH,
  shellArgv
} from '../../src/main/tabs/claude-argv'

const hooksPath = '/data/hooks.json'

describe('claudeArgv', () => {
  it('starts a new session with only our settings file', () => {
    expect(claudeArgv({ hooksPath })).toEqual(['claude', '--settings', hooksPath])
  })

  it('resumes a known session', () => {
    expect(claudeArgv({ hooksPath, resumeId: '0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e' })).toEqual([
      'claude',
      '--settings',
      hooksPath,
      '--resume',
      '0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e'
    ])
  })

  it('refuses a session id that is not a plain token', () => {
    for (const resumeId of ['', '-x', '--settings', 'a b', 'a\nb', 'x'.repeat(200)]) {
      expect(() => claudeArgv({ hooksPath, resumeId })).toThrow(/session id/)
    }
  })

  it('passes the prompt as one argument after `--`', () => {
    const prompt = 'fix the bug; rm -rf / "quoted" $(whoami)'
    expect(claudeArgv({ hooksPath, prompt })).toEqual(['claude', '--settings', hooksPath, '--', ' ' + prompt])
  })

  it('keeps a bare subcommand name from being dispatched as a command', () => {
    expect(claudeArgv({ hooksPath, prompt: 'update' }).slice(-2)).toEqual(['--', ' update'])
  })

  it('puts resume before the prompt', () => {
    expect(claudeArgv({ hooksPath, resumeId: 'abc', prompt: 'hi' })).toEqual([
      'claude',
      '--settings',
      hooksPath,
      '--resume',
      'abc',
      '--',
      ' hi'
    ])
  })

  it('ignores an empty prompt', () => {
    expect(claudeArgv({ hooksPath, prompt: '' })).toEqual(['claude', '--settings', hooksPath])
  })

  describe('`--` supported (the default)', () => {
    it('uses the recorded finding', () => {
      expect(PROMPT_AFTER_DOUBLE_DASH).toBe(true)
    })

    it('passes a prompt starting with "-" after `--`', () => {
      expect(claudeArgv({ hooksPath, prompt: '-x', doubleDash: true })).toEqual([
        'claude',
        '--settings',
        hooksPath,
        '--',
        ' -x'
      ])
    })
  })

  describe('`--` unsupported (the fallback branch)', () => {
    it('refuses a prompt starting with "-" instead of passing it as a flag', () => {
      expect(() => claudeArgv({ hooksPath, prompt: '-x', doubleDash: false })).toThrow(
        /may not start with "-"/
      )
      expect(() =>
        claudeArgv({ hooksPath, prompt: '--settings=/evil.json', doubleDash: false })
      ).toThrow(/may not start with "-"/)
    })

    it('passes any other prompt bare', () => {
      expect(claudeArgv({ hooksPath, prompt: 'hello world', doubleDash: false })).toEqual([
        'claude',
        '--settings',
        hooksPath,
        'hello world'
      ])
    })
  })

  describe('pluginDirs', () => {
    const core = '/data/claude-plugins/core'
    const other = '/data/claude-plugins/acme.jira'

    it('emits one `--plugin-dir <dir>` pair per dir, each dir one element, in the given order', () => {
      expect(claudeArgv({ hooksPath, pluginDirs: [core, other] })).toEqual([
        'claude',
        '--settings',
        hooksPath,
        '--plugin-dir',
        core,
        '--plugin-dir',
        other
      ])
    })

    it('keeps a dir with spaces or shell characters as one element', () => {
      const odd = '/Users/me/My Data/$(x); rm/claude-plugins/core'
      expect(claudeArgv({ hooksPath, pluginDirs: [odd] }).slice(3)).toEqual(['--plugin-dir', odd])
    })

    it('goes before --resume and before the prompt marker', () => {
      const id = '0b6a3f0e-1c11-4f7e-9d0e-5b1f7a1c2d3e'
      expect(claudeArgv({ hooksPath, pluginDirs: [core], resumeId: id })).toEqual([
        'claude',
        '--settings',
        hooksPath,
        '--plugin-dir',
        core,
        '--resume',
        id
      ])
      expect(claudeArgv({ hooksPath, pluginDirs: [core], prompt: 'hi' })).toEqual([
        'claude',
        '--settings',
        hooksPath,
        '--plugin-dir',
        core,
        '--',
        ' hi'
      ])
    })

    it('an empty list adds nothing', () => {
      expect(claudeArgv({ hooksPath, pluginDirs: [] })).toEqual(['claude', '--settings', hooksPath])
    })

    it('refuses a dir that is not absolute (it could be read as an option)', () => {
      for (const dir of ['', 'core', '-x', '--settings', './core']) {
        expect(() => claudeArgv({ hooksPath, pluginDirs: [dir] })).toThrow(/absolute/)
      }
    })
  })
})

describe('shellArgv', () => {
  it('runs the shell as a login shell', () => {
    expect(shellArgv('/bin/zsh')).toEqual(['/bin/zsh', '-l'])
  })
})

describe('commandArgv', () => {
  it('hands the whole command line to the login shell as one argv element, untouched', () => {
    const command = `docker compose logs -f | grep 'api' && echo "$(date)"; exit 3 # -l -c`
    const argv = commandArgv('/bin/zsh', command)
    expect(argv).toEqual(['/bin/zsh', '-l', '-i', '-c', command])
    expect(argv).toHaveLength(5)
    // The same flags the login-env capture runs the shell with (login-env.ts).
    expect(commandArgv('/bin/bash', '-x')).toEqual(['/bin/bash', '-l', '-i', '-c', '-x'])
  })
})

describe('commandOverlaySpec', () => {
  it("is the command tab's argv in the project folder, titled by the label", () => {
    expect(commandOverlaySpec('/bin/zsh', { label: 'Git', command: 'lazygit -p .' }, '/p')).toEqual({
      kind: 'terminal',
      argv: ['/bin/zsh', '-l', '-i', '-c', 'lazygit -p .'],
      cwd: '/p',
      title: 'Git'
    })
  })
})

describe('loginShellOf', () => {
  it("is the login env's SHELL, else the app's, else /bin/sh", () => {
    const saved = process.env.SHELL
    try {
      expect(loginShellOf({ SHELL: '/opt/fish' })).toBe('/opt/fish')
      process.env.SHELL = '/bin/bash'
      expect(loginShellOf({})).toBe('/bin/bash')
      delete process.env.SHELL
      expect(loginShellOf({ SHELL: '' })).toBe('/bin/sh')
    } finally {
      if (saved === undefined) delete process.env.SHELL
      else process.env.SHELL = saved
    }
  })
})
