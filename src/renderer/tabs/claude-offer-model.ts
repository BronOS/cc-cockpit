// The words of the "Claude Code was not found" dialog (ClaudeOfferDialog), pure so a unit test reads
// them. Every command and path comes from main's view (main/hooks/claude-offer.ts): a browser view may
// run on another OS than the host, so nothing here picks a command by the page's own platform.
import type { ClaudeCodeView } from '../../shared/ipc'

export interface ClaudeOfferText {
  title: string
  /** What is wrong and why it matters. */
  lead: string
  /** 'off-path': the line that puts the launcher's folder on PATH, for the shell profile; else undefined. */
  pathLine?: string
}

/**
 * The shell profile line for the native installer's folder (always `~/.local/bin`, main's
 * claudeLauncherPath), or undefined on Windows, whose PATH is set in System settings (the folder is
 * named in the text instead). A Windows binDir is the one that is not absolute in POSIX terms.
 */
export function profilePathLine(view: Pick<ClaudeCodeView, 'binDir'>): string | undefined {
  return view.binDir.startsWith('/') ? 'export PATH="$HOME/.local/bin:$PATH"' : undefined
}

export function claudeOfferText(view: ClaudeCodeView): ClaudeOfferText {
  if (view.state === 'off-path') {
    const pathLine = profilePathLine(view)
    return {
      title: 'Claude Code is not on the PATH',
      lead:
        `Claude Code is installed at ${view.launcher}, but ${view.binDir} is not on the PATH the Claude tabs get, so ` +
        'they cannot start it. Add that folder to PATH in your shell profile, then restart cc-cockpit.',
      ...(pathLine === undefined ? {} : { pathLine })
    }
  }
  return {
    title: 'Claude Code was not found',
    lead:
      'The Claude tabs run Claude Code (the claude command), and it is not on the PATH they get. Install it with the ' +
      'official command below, then open a new Claude tab.'
  }
}
