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
    'overlays.bounds',
    // Web access: what adds or widens access, in both modes (design-web.md §9.6: minting stays on
    // the server shell); a browser must never read the link or widen its access.
    'settings.webAccessSet',
    'settings.webAccessLink',
    'settings.webAccessRegenerate',
    'settings.webAccessAddDevice',
    'settings.webAccessSetPassword',
    'webAccess.confirmAnswer',
    // The desktop page seeds web access's terminal copies from its own screen: a browser's answer
    // would be shown to the other views.
    'tabs.screen',
    'tabs.screenAsk',
    // Remote desktop (design-remote-desktop.md §3): they dial out over SSH and keep device cookies
    // on this machine; a browser view of this desktop must never drive them.
    'remote.list',
    'remote.connect',
    'remote.open',
    'remote.edit',
    'remote.pickKey',
    'remote.rename',
    'remote.forget',
    'remote.changed'
  ])('%s is no', (channel) => {
    expect(REMOTE_CLASS[channel as keyof typeof REMOTE_CLASS]).toBe('no')
  })

  it.each([
    'app.openExternal',
    'updates.openRelease',
    'notify.soundData',
    'tabs.list',
    'tabs.ack',
    'tabs.selected',
    'tabs.data',
    'links.answer',
    'projects.close',
    // A server's streamed webviews (design-web-browser.md §3.2): a browser view's own placement.
    'webviews.place',
    'webviews.fit',
    // Its toolbar (§3.5): a server's browsers only (handler refusal, remoteEvent).
    'webviews.step',
    'webviews.current',
    'webviews.navigated',
    // The web access card's read side and the narrowing calls: a server's browsers only (§9.4, §9.6).
    'settings.webAccess',
    'webAccess.state',
    'webAccess.changed',
    'settings.webDeviceRevoke',
    'settings.webDevicesRevokeAll',
    'settings.webDeviceDisconnect',
    // A server's in-page notices and the chime (§9.9): the browsers only, and only from a server.
    'notify.chime',
    'notices.show',
    'notices.gone',
    'notices.click',
    'notices.dismiss',
    // A plugin's OAuth sign-in settled by the pasted redirect (§9.9): a server's browsers only.
    'oauth.paste'
  ])('%s is adapted', (channel) => {
    expect(REMOTE_CLASS[channel as keyof typeof REMOTE_CLASS]).toBe('adapted')
  })

  // The Move to Trash confirm (files/trash-asks.ts): a trash started from a browser is answered there.
  // A sign-in's end (§9.9): main sends it to a window's browsers in server mode only, like app.linkNotice.
  it.each(['app.linkNotice', 'oauth.signInEnded'])('%s is yes', (channel) => {
    expect(REMOTE_CLASS[channel as keyof typeof REMOTE_CLASS]).toBe('yes')
  })

  it.each(['trash.ask', 'trash.settled', 'trash.answer'])('%s is yes', (channel) => {
    expect(REMOTE_CLASS[channel as keyof typeof REMOTE_CLASS]).toBe('yes')
  })
})

// Every channel whose name says it manages web access is `no`, but for the six server mode opens to
// its browsers (`adapted`: the read side and the narrowing calls, decided by main's flag in the
// handler, design-web.md §9.4, §9.6): a channel added later under these names (`settings.web*`,
// `webAccess.*`) without thought cannot reach a browser by being classified `yes` or `adapted`.
describe('web access channels', () => {
  const SERVER_CARD = new Set([
    'settings.webAccess',
    'webAccess.state',
    'webAccess.changed',
    'settings.webDeviceRevoke',
    'settings.webDevicesRevokeAll',
    'settings.webDeviceDisconnect'
  ])
  it('every settings.web* and webAccess.* channel is no, but the six of the server card', () => {
    const names = [...INVOKE_CHANNELS, ...EVENT_CHANNELS].filter((c) => c.startsWith('settings.web') || c.startsWith('webAccess.'))
    expect(names.length).toBeGreaterThanOrEqual(10)
    for (const name of names) expect(REMOTE_CLASS[name as keyof typeof REMOTE_CLASS], name).toBe(SERVER_CARD.has(name) ? 'adapted' : 'no')
    for (const name of SERVER_CARD) expect(names, name).toContain(name)
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
