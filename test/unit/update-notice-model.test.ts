import { describe, expect, it } from 'vitest'
import { QUIT_FIRST_NOTE, newestUpdateState, openReleaseFailureText, updateNoticeModel } from '../../src/renderer/updates/update-notice-model'
import type { UpdateState } from '../../src/shared/ipc'

const state = (available: UpdateState['available']): UpdateState => ({ current: '1.0.0', enabled: true, available })

describe('updateNoticeModel', () => {
  it('shows nothing without an update or a state', () => {
    expect(updateNoticeModel(null, 'mac')).toBeNull()
    expect(updateNoticeModel(state(null), 'other')).toBeNull()
  })

  it('mac: the brew command, the release notes link and the quit-first note', () => {
    const m = updateNoticeModel(state({ version: '1.2.0' }), 'mac')!
    expect(m.version).toBe('1.2.0')
    expect(m.heading).toBe('cc-cockpit 1.2.0 is available (you have 1.0.0).')
    expect(m.command).toBe('brew update && brew upgrade --cask cc-cockpit')
    expect(m.linkLabel).toBe('Release notes')
    expect(m.note).toBe(QUIT_FIRST_NOTE)
  })

  it('linux: a download link and no command', () => {
    const m = updateNoticeModel(state({ version: '1.2.0' }), 'other')!
    expect(m.version).toBe('1.2.0')
    expect(m.command).toBeNull()
    expect(m.action).toContain('Download')
    expect(m.linkLabel).toBe('Open release page')
    expect(m.note).toBe(QUIT_FIRST_NOTE)
  })
})

describe('openReleaseFailureText', () => {
  it('names the reason and a fallback', () => {
    const t = openReleaseFailureText('no handler')
    expect(t).toContain('(no handler)')
    expect(t).toContain('releases page')
  })
})

describe('newestUpdateState', () => {
  it('takes the initial reply when no event came first', () => {
    const m = newestUpdateState()
    expect(m.fromReply(state(null))).toEqual(state(null))
  })
  it('drops a reply that arrives after an event', () => {
    const m = newestUpdateState()
    const ev = state({ version: '1.1.0' })
    expect(m.fromEvent(ev)).toBe(ev)
    expect(m.fromReply(state(null))).toBeNull()
  })
})
