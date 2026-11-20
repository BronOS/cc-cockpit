// "Claude Code was not found" (main side): whether `claude` is where the Claude tabs will look for it,
// and the start-up offer to install it. main decides; the renderer asks `claude.offer`, draws the
// dialog and sends back only intents (`claude.install`, `settings.claudeOfferSet`).
//
// Decisions (docs/backlog item, Oleg 2026-11-20):
//  - The check walks the PATH the Claude tabs spawn with (buildPtyEnv over the login env, so the
//    login shell's PATH on a Mac started from Finder), with no shell and no spawn: a Claude tab runs
//    `claude` by name and node-pty's exec walks that same PATH. Empty and relative entries are
//    skipped: they mean the tab's cwd, which is the project folder, not anything main can judge.
//    A directory named `claude` passes X_OK, so the entry must be a file (statSync follows the
//    native installer's symlink to its versioned binary).
//  - 'off-path': the native installer's launcher (`~/.local/bin/claude`) is there and runs, but its
//    folder is not on that PATH (the installer does not edit shell profiles for you). The fix is a
//    PATH line, not a second install, so no install button then.
//  - The app never installs Claude Code by itself. It shows the official command with Copy and the
//    setup docs, and "Install in a new tab" opens a visible command tab running that command, which
//    the person watches and can stop, kept open after it ends so its output can be read. The command
//    is a constant here picked by the host's platform (read from https://code.claude.com/docs/en/setup
//    on 2026-11-20); the page sends only the intent, so nothing from a page or a payload reaches it.
//  - Once per launch, to the first view that may take it (the claim), like the ccc offer. On the
//    desktop that is a desktop page; in server mode the browsers are the only screen, so it is the
//    first owner browser view, never the hidden page (nobody sees it, and its modal would leave its
//    root inert, design-web.md §9.9) and never a guest. A view that may not take it does not spend it:
//    the hidden page mounts first, long before any browser attaches.
//  - Never in a test run (every e2e launch would grow a dialog) unless the spec sets
//    CC_COCKPIT_CLAUDE_OFFER=1, honoured only in a test run. "Don't ask again" (claudeOffer: false)
//    silences the dialog and the server's start-up notice alike: both are the same question.
//  - Asked before the ccc offer (the renderer waits for this one to end before asking `ccc.offer`):
//    without Claude Code the Claude tabs, which `ccc` serves, cannot start at all.
import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { ClaudeCodeState, ClaudeCodeView, ClaudeInstallOther } from '../../shared/ipc'
import type { TabCommand } from '../tabs/tab-manager'
import { commandArgv } from '../tabs/claude-argv'

/** Anthropic's setup page: the source of every command below. */
export const CLAUDE_SETUP_DOCS = 'https://code.claude.com/docs/en/setup'

/** The native installer on macOS, Linux and WSL (the setup page, 2026-11-20). */
export const CLAUDE_INSTALL_POSIX = 'curl -fsSL https://claude.ai/install.sh | bash'
/** The native installer in Windows PowerShell (the setup page, 2026-11-20). */
export const CLAUDE_INSTALL_WIN32 = 'irm https://claude.ai/install.ps1 | iex'

/** The installer tab's title. */
export const CLAUDE_INSTALL_LABEL = 'Install Claude Code'

/** The official install command for `platform`: what the dialog shows and the installer tab runs. */
export function claudeInstallCommand(platform: NodeJS.Platform): string {
  return platform === 'win32' ? CLAUDE_INSTALL_WIN32 : CLAUDE_INSTALL_POSIX
}

/** The other ways the setup page lists, as text only (the app never runs them). Homebrew has no Windows. */
export function claudeInstallOthers(platform: NodeJS.Platform): ClaudeInstallOther[] {
  const npm: ClaudeInstallOther = {
    label: 'npm',
    command: 'npm install -g @anthropic-ai/claude-code@latest',
    note: 'needs Node.js 22 or newer'
  }
  return platform === 'win32' ? [npm] : [{ label: 'Homebrew', command: 'brew install --cask claude-code' }, npm]
}

/** Where the native installer puts the launcher: `~/.local/bin/claude` (`%USERPROFILE%\.local\bin\claude.exe`). */
export function claudeLauncherPath(platform: NodeJS.Platform, home: string): string {
  return platform === 'win32' ? win32.join(home, '.local', 'bin', 'claude.exe') : posix.join(home, '.local', 'bin', 'claude')
}

/** Whether `file` is a regular file (after symlinks) this process may execute. Never throws. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface ClaudeLookup {
  /** The PATH the Claude tabs spawn with (buildPtyEnv(loginEnv).PATH); undefined = none at all. */
  path: string | undefined
  home: string
  platform: NodeJS.Platform
  /** Injected for tests; production uses isExecutableFile. */
  isExecutable?: (file: string) => boolean
}

/** The names a `claude` on PATH may have: npm puts a `.cmd` shim on Windows, the native installer an `.exe`. */
function claudeNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
}

/** found / off-path / missing, as the header says. Pure but for the probe. */
export function claudeCodeState({ path, home, platform, isExecutable = isExecutableFile }: ClaudeLookup): ClaudeCodeState {
  const p = platform === 'win32' ? win32 : posix
  for (const dir of (path ?? '').split(p.delimiter)) {
    // Empty ("cwd") and relative entries depend on the tab's folder, not on anything main can check.
    if (dir === '' || !p.isAbsolute(dir)) continue
    if (claudeNames(platform).some((name) => isExecutable(p.join(dir, name)))) return 'found'
  }
  return isExecutable(claudeLauncherPath(platform, home)) ? 'off-path' : 'missing'
}

/**
 * The installer tab main opens (TabManager.createCommand: the login shell as argv[0] runs the command
 * as ONE `-c` argument, commandArgv), or null where tabs cannot run it: the app has no Windows tab
 * spawn path (shell tabs are `$SHELL -l`, loginShellOf falls back to /bin/sh), so on win32 the dialog
 * shows the PowerShell command with Copy and no button. `override` is the e2e's harmless stand-in, passed
 * only in a test run (index.ts); the displayed and copied command stays the real one.
 */
export function claudeInstallTab(platform: NodeJS.Platform, override?: string): TabCommand | null {
  if (platform === 'win32') return null
  return { label: CLAUDE_INSTALL_LABEL, command: override ?? claudeInstallCommand(platform) }
}

/** The argv the installer tab spawns with `shell` (what TabManager runs for claudeInstallTab), or null. */
export function claudeInstallArgv(platform: NodeJS.Platform, shell: string): string[] | null {
  const tab = claudeInstallTab(platform)
  return tab === null ? null : commandArgv(shell, tab.command)
}

/** The dialog's and the Settings row's view. */
export function claudeCodeView(i: {
  state: ClaudeCodeState
  home: string
  platform: NodeJS.Platform
  offerAtStart: boolean
}): ClaudeCodeView {
  const launcher = claudeLauncherPath(i.platform, i.home)
  return {
    state: i.state,
    launcher,
    binDir: (i.platform === 'win32' ? win32 : posix).dirname(launcher),
    command: claudeInstallCommand(i.platform),
    docsUrl: CLAUDE_SETUP_DOCS,
    others: claudeInstallOthers(i.platform),
    installInTab: i.state === 'missing' && claudeInstallTab(i.platform) !== null,
    offerAtStart: i.offerAtStart
  }
}

/** Who asks: the view main bound the call to, never the payload. */
export interface ClaudeOfferCaller {
  /** A browser view (CallView.remote). */
  remote: boolean
  /** isOwner(view): never a guest. */
  owner: boolean
}

/**
 * Whether this view may ever be asked: the owner, and on the desktop its own page, in server mode a
 * browser (the hidden page is never seen). The same rule gates `claude.install` and the setting.
 */
export function mayAskClaudeOffer(server: boolean, caller: ClaudeOfferCaller): boolean {
  if (!caller.owner) return false
  return server ? caller.remote : !caller.remote
}

export interface ClaudeOfferGate {
  /** isTestRun(): an e2e launch. */
  testRun: boolean
  /** CC_COCKPIT_CLAUDE_OFFER=1 in a test run: the spec asks for the offer. */
  forcedByTest: boolean
  /** The person did not switch it off ("Don't ask again"). */
  enabled: boolean
}

/** The launch-wide gate, before any state is read: the dialog and the server's notice both pass it. */
export function claudeOfferAllowed(g: ClaudeOfferGate): boolean {
  if (g.testRun && !g.forcedByTest) return false
  return g.enabled
}

export class ClaudeOffer {
  private claimed = false

  constructor(
    private readonly deps: {
      server: boolean
      testRun: boolean
      forcedByTest: boolean
      enabled: () => boolean
    }
  ) {}

  /**
   * True for the first view of the launch that may be asked while the gate is open; false after that,
   * and for a view that may never be asked, which leaves the claim for the next. Synchronous, before
   * the caller awaits the login env: two windows asking at once must not both pass. Whether `claude`
   * is found is the caller's next step (it needs the login env): a found one spends the claim too.
   */
  claim(caller: ClaudeOfferCaller): boolean {
    if (!mayAskClaudeOffer(this.deps.server, caller)) return false
    if (this.claimed) return false
    this.claimed = true
    return claudeOfferAllowed({ testRun: this.deps.testRun, forcedByTest: this.deps.forcedByTest, enabled: this.deps.enabled() })
  }
}

/**
 * The server's start-up core notice when `claude` is not found (a stdout line and `ccc web status`;
 * core-notices.ts): plain text, no link, only what main made. Undefined when there is nothing to say.
 */
export function claudeMissingNotice(state: ClaudeCodeState, launcher: string): string | undefined {
  if (state === 'missing') {
    return 'Claude Code (claude) was not found on the PATH Claude tabs get, so they cannot start; open cc-cockpit in a browser for the install command.'
  }
  if (state === 'off-path') {
    return `Claude Code is at ${launcher}, but its folder is not on the PATH Claude tabs get; add it to PATH in the shell profile and restart cc-cockpit.`
  }
  return undefined
}

/** The installer tab ended with 0: what the re-check found, for a core notice. */
export function claudeInstalledNotice(state: ClaudeCodeState, launcher: string): string {
  if (state === 'found') return 'Claude Code is installed: new Claude tabs will use it.'
  if (state === 'off-path') {
    return `Claude Code is installed at ${launcher}, but its folder is not on the PATH Claude tabs get; add it to PATH in your shell profile and restart cc-cockpit.`
  }
  return 'The Claude Code installer finished, but claude is still not found; see its output in the tab.'
}
