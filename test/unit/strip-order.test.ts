import { describe, expect, it } from 'vitest'
import { topStripClass, statusLabel, statusText } from '../../src/renderer/status/strip-order'

// The top bar itself needs a DOM; it is covered end to end in test/e2e/top-strip.spec.ts. The
// other windows' strip (order, text) is the cockpit.sessions plugin's (plugins/sessions/test).

describe('statusText', () => {
  it('is `status · tool`, without the tool when there is none', () => {
    expect(statusText('working', 'Bash')).toBe('working · Bash')
    expect(statusText('needs-permission')).toBe('needs permission')
    expect(statusLabel('waiting')).toBe('waiting for input')
  })

  it('a dialog tool in needs-permission reads as needing you, not as a permission', () => {
    expect(statusText('needs-permission', 'AskUserQuestion')).toBe('needs you · question')
    expect(statusText('needs-permission', 'ExitPlanMode')).toBe('needs you · plan approval')
    expect(statusText('needs-permission', 'Bash')).toBe('needs permission · Bash')
    // Only a needs-permission tab: a stale tool name on another status is shown as it is.
    expect(statusText('working', 'AskUserQuestion')).toBe('working · AskUserQuestion')
    expect(statusText('idle')).toBe('idle')
  })
})

describe('topStripClass', () => {
  it('reserves the traffic lights room on the macOS bar and collapses it in full screen', () => {
    expect(topStripClass(true, false)).toBe('top-strip title-bar')
    expect(topStripClass(true, true)).toBe('top-strip title-bar full-screen')
  })

  it('ignores full screen where the native title bar stays', () => {
    expect(topStripClass(false, true)).toBe('top-strip')
    expect(topStripClass(false, false)).toBe('top-strip')
  })
})
