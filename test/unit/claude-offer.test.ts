// "Claude Code was not found" (main/hooks/claude-offer.ts): the PATH walk, the once-per-launch claim and who may
// take it (the hidden page and guests never), the fixed installer argv per platform, the view and the server notice.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_INSTALL_POSIX,
  CLAUDE_INSTALL_WIN32,
  CLAUDE_SETUP_DOCS,
  ClaudeOffer,
  claudeCodeState,
  claudeCodeView,
  claudeInstallArgv,
  claudeInstallTab,
  claudeInstalledNotice,
  CLAUDE_FAST_EXIT_MS,
  CLAUDE_TAB_FAILED_NOTICE,
  claudeInstallOverride,
  claudeLauncherPath,
  claudeMissingNotice,
  claudeOfferAllowed,
  claudeStartNotice,
  claudeTabFailureNotice,
  isExecutableFile,
  mayAskClaudeOffer
} from '../../src/main/hooks/claude-offer'
import { claudeOfferText, profilePathLine } from '../../src/renderer/tabs/claude-offer-model'

let root: string
let home: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-claude-offer-')))
  home = join(root, 'home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A file at `dir/name` with `mode`; returns its path. */
function file(dir: string, name: string, mode: number): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, mode)
  return path
}

const state = (path: string | undefined): ReturnType<typeof claudeCodeState> => claudeCodeState({ path, home, platform: 'linux' })

describe('claudeCodeState: the PATH the Claude tabs get', () => {
  it('finds an executable claude on any PATH entry', () => {
    const bin = join(root, 'bin')
    file(bin, 'claude', 0o755)
    expect(state(['/nonexistent', bin].join(':'))).toBe('found')
  })

  it('follows a symlink, as the native installer leaves one', () => {
    const real = file(join(root, 'versions'), '2.1.0', 0o755)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    symlinkSync(real, join(bin, 'claude'))
    expect(state(bin)).toBe('found')
  })

  it('is missing with nothing anywhere, an empty PATH or none', () => {
    expect(state(join(root, 'bin'))).toBe('missing')
    expect(state('')).toBe('missing')
    expect(state(undefined)).toBe('missing')
  })

  it('does not count a claude that is not executable, nor a directory named claude', () => {
    const bin = join(root, 'bin')
    file(bin, 'claude', 0o644)
    expect(state(bin)).toBe('missing')
    const dirs = join(root, 'dirs')
    mkdirSync(join(dirs, 'claude'), { recursive: true })
    expect(state(dirs)).toBe('missing')
    expect(isExecutableFile(join(dirs, 'claude'))).toBe(false)
  })

  it('skips empty and relative entries: they mean the tab\'s folder, not main\'s', () => {
    // A `claude` in main's cwd must not count: "" and "." resolve against whatever cwd the probe has.
    const seen: string[] = []
    const probe = (f: string): boolean => {
      seen.push(f)
      return true
    }
    expect(claudeCodeState({ path: ':.:bin', home, platform: 'linux', isExecutable: (f) => probe(f) && f === claudeLauncherPath('linux', home) })).toBe('off-path')
    expect(seen).toEqual([claudeLauncherPath('linux', home)])
  })

  it("is off-path when only ~/.local/bin/claude runs: installed, its folder not on the tabs' PATH", () => {
    file(join(home, '.local', 'bin'), 'claude', 0o755)
    expect(state('/usr/bin:/bin')).toBe('off-path')
    expect(state(join(home, '.local', 'bin'))).toBe('found')
  })

  it('on Windows looks for claude.exe and the npm claude.cmd, with ; between entries', () => {
    const hits = new Set(['C:\\tools\\claude.cmd'])
    const probe = (f: string): boolean => hits.has(f)
    expect(claudeCodeState({ path: 'C:\\Windows;C:\\tools', home: 'C:\\Users\\o', platform: 'win32', isExecutable: probe })).toBe('found')
    hits.clear()
    hits.add('C:\\Users\\o\\.local\\bin\\claude.exe')
    expect(claudeCodeState({ path: 'C:\\Windows', home: 'C:\\Users\\o', platform: 'win32', isExecutable: probe })).toBe('off-path')
  })
})

describe('the installer: a fixed command, the shell as argv[0], the command as one -c argument', () => {
  it('runs the setup page\'s native installer on macOS and Linux through the login shell, like a command tab', () => {
    expect(claudeInstallArgv('darwin', '/bin/zsh')).toEqual(['/bin/zsh', '-l', '-i', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
    expect(claudeInstallArgv('linux', '/bin/bash')).toEqual(['/bin/bash', '-l', '-i', '-c', CLAUDE_INSTALL_POSIX])
  })

  it('has no installer tab on Windows (no tab spawn path there): the PowerShell command is shown to copy', () => {
    expect(claudeInstallArgv('win32', 'C:\\Windows\\System32\\cmd.exe')).toBeNull()
    expect(claudeInstallTab('win32')).toBeNull()
    const view = claudeCodeView({ state: 'missing', home: 'C:\\Users\\o', platform: 'win32', offerAtStart: true })
    expect(view).toMatchObject({ command: 'irm https://claude.ai/install.ps1 | iex', installInTab: false, launcher: 'C:\\Users\\o\\.local\\bin\\claude.exe' })
    expect(view.command).toBe(CLAUDE_INSTALL_WIN32)
    expect(view.others.map((o) => o.label)).toEqual(['npm'])
  })

  it('takes a test stand-in for what the tab runs (index.ts passes it only in a test run)', () => {
    expect(claudeInstallTab('linux', 'echo fake')).toEqual({ label: 'Install Claude Code', command: 'echo fake' })
    expect(claudeInstallTab('linux')).toEqual({ label: 'Install Claude Code', command: CLAUDE_INSTALL_POSIX })
  })
})

describe('claudeCodeView', () => {
  it('carries main\'s command, the docs, the other ways and the launcher', () => {
    const view = claudeCodeView({ state: 'missing', home: '/home/o', platform: 'linux', offerAtStart: true })
    expect(view).toEqual({
      state: 'missing',
      launcher: '/home/o/.local/bin/claude',
      binDir: '/home/o/.local/bin',
      command: CLAUDE_INSTALL_POSIX,
      docsUrl: CLAUDE_SETUP_DOCS,
      others: [
        { label: 'Homebrew', command: 'brew install --cask claude-code' },
        { label: 'npm', command: 'npm install -g @anthropic-ai/claude-code@latest', note: 'needs Node.js 22 or newer' }
      ],
      installInTab: true,
      offerAtStart: true
    })
    expect(CLAUDE_SETUP_DOCS).toBe('https://code.claude.com/docs/en/setup')
  })

  it('offers no install when only PATH needs fixing, nor when claude is found', () => {
    expect(claudeCodeView({ state: 'off-path', home: '/h', platform: 'darwin', offerAtStart: false }).installInTab).toBe(false)
    expect(claudeCodeView({ state: 'found', home: '/h', platform: 'darwin', offerAtStart: true }).installInTab).toBe(false)
  })
})

describe('who may be asked', () => {
  const desktopPage = { remote: false, owner: true }
  const ownerBrowser = { remote: true, owner: true }
  const guest = { remote: true, owner: false }

  it('on the desktop: its own page, never a browser view or a guest', () => {
    expect(mayAskClaudeOffer(false, desktopPage)).toBe(true)
    expect(mayAskClaudeOffer(false, ownerBrowser)).toBe(false)
    expect(mayAskClaudeOffer(false, guest)).toBe(false)
  })

  it('in server mode: an owner browser, never the hidden page or a guest', () => {
    expect(mayAskClaudeOffer(true, ownerBrowser)).toBe(true)
    expect(mayAskClaudeOffer(true, desktopPage)).toBe(false)
    expect(mayAskClaudeOffer(true, guest)).toBe(false)
  })
})

describe('ClaudeOffer: once per launch', () => {
  const make = (o: { server?: boolean; testRun?: boolean; forced?: boolean; enabled?: () => boolean } = {}): ClaudeOffer =>
    new ClaudeOffer({ server: o.server ?? false, testRun: o.testRun ?? false, forcedByTest: o.forced ?? false, enabled: o.enabled ?? (() => true) })

  it('answers the first view that may be asked, and nobody after', () => {
    const offer = make()
    expect(offer.claim({ remote: false, owner: true })).toBe(true)
    expect(offer.claim({ remote: false, owner: true })).toBe(false)
  })

  it('server mode: the hidden page and a guest do not spend the claim; the first owner browser takes it', () => {
    const offer = make({ server: true })
    expect(offer.claim({ remote: false, owner: true })).toBe(false)
    expect(offer.claim({ remote: true, owner: false })).toBe(false)
    expect(offer.claim({ remote: true, owner: true })).toBe(true)
    expect(offer.claim({ remote: true, owner: true })).toBe(false)
  })

  it('a desktop browser view never spends the desktop page\'s claim', () => {
    const offer = make()
    expect(offer.claim({ remote: true, owner: true })).toBe(false)
    expect(offer.claim({ remote: false, owner: true })).toBe(true)
  })

  it('holds the ccc claim for the dialog\'s view until the question is settled, app-wide', async () => {
    const offer = make()
    expect(await offer.cccMayAsk('desktop:2')).toBe(true) // nothing claimed yet
    expect(offer.claim({ remote: false, owner: true })).toBe(true)
    let other: boolean | undefined
    void offer.cccMayAsk('desktop:2').then((v) => (other = v))
    await Promise.resolve()
    expect(other).toBeUndefined() // waits while the claim's answer is computed
    offer.settle('desktop:1')
    await new Promise((r) => setTimeout(r, 0))
    expect(other).toBe(false) // another window: the dialog's window takes it after its dialog closes
    expect(await offer.cccMayAsk('desktop:1')).toBe(true)
  })

  it('frees the ccc claim when nothing was offered, or when the gate kept the claim shut', async () => {
    const offer = make()
    offer.claim({ remote: false, owner: true })
    offer.settle(null)
    expect(await offer.cccMayAsk('desktop:2')).toBe(true)
    const shut = make({ enabled: () => false })
    shut.claim({ remote: false, owner: true })
    expect(await shut.cccMayAsk('desktop:2')).toBe(true)
  })

  it('not in a test run unless the spec asks; not after "Don\'t ask again" (read at the claim)', () => {
    expect(make({ testRun: true }).claim({ remote: false, owner: true })).toBe(false)
    expect(make({ testRun: true, forced: true }).claim({ remote: false, owner: true })).toBe(true)
    expect(make({ enabled: () => false }).claim({ remote: false, owner: true })).toBe(false)
    expect(claudeOfferAllowed({ testRun: false, forcedByTest: true, enabled: true })).toBe(true)
    expect(claudeOfferAllowed({ testRun: true, forcedByTest: false, enabled: true })).toBe(false)
  })
})

describe('notices', () => {
  it('the server line is plain text with no link, and nothing when claude is found', () => {
    const missing = claudeMissingNotice('missing', '/h/.local/bin/claude')
    expect(missing).toMatch(/not found on the PATH Claude tabs get/)
    expect(missing).not.toMatch(/https?:|claude\.ai/)
    expect(claudeMissingNotice('off-path', '/h/.local/bin/claude')).toContain('/h/.local/bin/claude')
    expect(claudeMissingNotice('found', '/h/.local/bin/claude')).toBeUndefined()
  })

  it('the server line points at Settings, which stays true after the dialog was declined', () => {
    expect(claudeMissingNotice('missing', '/h/.local/bin/claude')).toMatch(/Settings › Claude Code/)
  })

  it('the re-check after the installer says what new Claude tabs will find, with no host path', () => {
    expect(claudeInstalledNotice('found')).toMatch(/new Claude tabs will use it/)
    expect(claudeInstalledNotice('off-path')).toMatch(/not on the PATH.*restart cc-cockpit/)
    expect(claudeInstalledNotice('missing')).toMatch(/still not found/)
    for (const state of ['found', 'off-path', 'missing'] as const) expect(claudeInstalledNotice(state)).not.toMatch(/\/(home|Users)\//)
  })
})

describe('the server start line (claudeStartNotice): server only, behind the offer gate', () => {
  const gate = { testRun: false, forcedByTest: false, enabled: true }
  const launcher = '/h/.local/bin/claude'
  it('says so on a server with no claude', () => {
    expect(claudeStartNotice({ server: true, gate, state: 'missing', launcher })).toBe(claudeMissingNotice('missing', launcher))
    expect(claudeStartNotice({ server: true, gate, state: 'off-path', launcher })).toContain(launcher)
  })
  it('says nothing on the desktop, when found, after "Don\'t ask again", or in a test run that did not opt in', () => {
    expect(claudeStartNotice({ server: false, gate, state: 'missing', launcher })).toBeUndefined()
    expect(claudeStartNotice({ server: true, gate, state: 'found', launcher })).toBeUndefined()
    expect(claudeStartNotice({ server: true, gate: { ...gate, enabled: false }, state: 'missing', launcher })).toBeUndefined()
    expect(claudeStartNotice({ server: true, gate: { ...gate, testRun: true }, state: 'missing', launcher })).toBeUndefined()
    expect(claudeStartNotice({ server: true, gate: { ...gate, testRun: true, forcedByTest: true }, state: 'missing', launcher })).toBeDefined()
  })
})

describe('a Claude tab that ends right after its start (claudeTabFailureNotice)', () => {
  const base = { livedMs: 300, state: 'missing' as const, shown: false, allowed: true }
  it('notices an early exit while claude is not found or off the PATH', () => {
    expect(claudeTabFailureNotice(base)).toBe(true)
    expect(claudeTabFailureNotice({ ...base, state: 'off-path' })).toBe(true)
    expect(claudeTabFailureNotice({ ...base, livedMs: CLAUDE_FAST_EXIT_MS })).toBe(true)
  })
  it('not for a later exit, a found claude, a second time, or a gate that is shut', () => {
    expect(claudeTabFailureNotice({ ...base, livedMs: CLAUDE_FAST_EXIT_MS + 1 })).toBe(false)
    expect(claudeTabFailureNotice({ ...base, state: 'found' })).toBe(false)
    expect(claudeTabFailureNotice({ ...base, shown: true })).toBe(false)
    expect(claudeTabFailureNotice({ ...base, allowed: false })).toBe(false)
  })
  it('the notice is plain text pointing at Settings', () => {
    expect(CLAUDE_TAB_FAILED_NOTICE).toBe('Claude Code was not found. Settings › Claude Code has the install command.')
  })
})

describe('the installer stand-in (claudeInstallOverride): a test run only', () => {
  const env = { CC_COCKPIT_TEST: '1', CC_COCKPIT_CLAUDE_INSTALL_COMMAND: 'echo fake' }
  it('is honoured in an unpackaged test run', () => {
    expect(claudeInstallOverride(env, false)).toBe('echo fake')
  })
  it('is refused outside a test run, in a packaged app, or when empty: the constant runs', () => {
    expect(claudeInstallOverride({ CC_COCKPIT_CLAUDE_INSTALL_COMMAND: 'echo fake' }, false)).toBeUndefined()
    expect(claudeInstallOverride(env, true)).toBeUndefined()
    expect(claudeInstallOverride({ ...env, CC_COCKPIT_TEST: 'yes' }, false)).toBeUndefined()
    expect(claudeInstallOverride({ ...env, CC_COCKPIT_CLAUDE_INSTALL_COMMAND: '' }, false)).toBeUndefined()
    expect(claudeInstallTab('linux', claudeInstallOverride(env, true))).toEqual({ label: 'Install Claude Code', command: CLAUDE_INSTALL_POSIX })
  })
})

describe('the dialog\'s words (renderer, claude-offer-model.ts)', () => {
  it('missing: says the Claude tabs need it', () => {
    const t = claudeOfferText(claudeCodeView({ state: 'missing', home: '/h', platform: 'linux', offerAtStart: true }))
    expect(t.title).toBe('Claude Code was not found')
    expect(t.lead).toMatch(/Claude tabs run Claude Code/)
    expect(t.pathLine).toBeUndefined()
  })

  it('off-path: names the launcher and gives the profile line (none on Windows)', () => {
    const t = claudeOfferText(claudeCodeView({ state: 'off-path', home: '/h', platform: 'darwin', offerAtStart: true }))
    expect(t.title).toBe('Claude Code is not on the PATH')
    expect(t.lead).toContain('/h/.local/bin/claude')
    expect(t.pathLine).toBe('export PATH="$HOME/.local/bin:$PATH"')
    expect(profilePathLine({ binDir: 'C:\\Users\\o\\.local\\bin' })).toBeUndefined()
  })
})
