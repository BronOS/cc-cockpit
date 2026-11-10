import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, INVOKE_CHANNELS, REMOTE_CLASS, remoteAllowed, remoteClassOf } from '../../src/shared/ipc'

// Design-web §2.3: every channel has a remote class next to its declaration. The type of
// REMOTE_CLASS already rejects a missing or extra key; this checks the runtime lists the preload
// and the gateway use, so a channel cannot reach a remote view without a decision on it.
describe('REMOTE_CLASS drift', () => {
  const channels = new Set<string>([...INVOKE_CHANNELS, ...EVENT_CHANNELS])

  it('classifies every invoke and event channel', () => {
    const missing = [...channels].filter((c) => !Object.hasOwn(REMOTE_CLASS, c))
    expect(missing).toEqual([])
  })

  it('has no key that is not a channel', () => {
    const extra = Object.keys(REMOTE_CLASS).filter((c) => !channels.has(c))
    expect(extra).toEqual([])
  })

  it('uses only the three classes', () => {
    for (const value of Object.values(REMOTE_CLASS)) expect(['yes', 'no', 'adapted']).toContain(value)
  })

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(REMOTE_CLASS)).toBe(true)
  })

  // The ones design §2.3 and §6.1 name: a regression here would expose the host's screen or let a
  // remote view act on the host's windows.
  it.each([
    'projects.openFolder',
    'projects.relink',
    'settings.pluginLink',
    'settings.projectRelink',
    'window.reopen',
    'window.state',
    'webviews.placement',
    'webviews.step',
    'webviews.current',
    'webviews.navigated',
    'overlays.bounds'
  ])('%s is no', (channel) => {
    expect(REMOTE_CLASS[channel as keyof typeof REMOTE_CLASS]).toBe('no')
  })

  it.each(['app.openExternal', 'updates.openRelease', 'notify.soundData'])('%s is adapted', (channel) => {
    expect(REMOTE_CLASS[channel as keyof typeof REMOTE_CLASS]).toBe('adapted')
  })
})

describe('remoteAllowed', () => {
  it('allows a yes channel', () => {
    expect(remoteClassOf('tabs.input')).toBe('yes')
    expect(remoteAllowed('tabs.input')).toBe(true)
  })

  it('refuses a no channel', () => {
    expect(remoteClassOf('projects.openFolder')).toBe('no')
    expect(remoteAllowed('projects.openFolder')).toBe(false)
  })

  it('allows an adapted channel (its handler answers a remote caller differently)', () => {
    expect(remoteClassOf('app.openExternal')).toBe('adapted')
    expect(remoteAllowed('app.openExternal')).toBe(true)
  })

  it.each(['no.such.channel', '', 'TABS.INPUT', 'tabs.input ', 'tabs'])('refuses an unknown channel %j', (channel) => {
    expect(remoteClassOf(channel)).toBe('no')
    expect(remoteAllowed(channel)).toBe(false)
  })

  // A frame's channel is untrusted text: an inherited property must not count as a class.
  it.each(['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf'])('refuses the inherited name %s', (channel) => {
    expect(remoteClassOf(channel)).toBe('no')
    expect(remoteAllowed(channel)).toBe(false)
  })
})
