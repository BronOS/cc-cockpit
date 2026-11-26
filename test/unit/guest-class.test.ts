import { describe, expect, it } from 'vitest'
import {
  byCommand,
  byOverlayButton,
  byOverlayDiscuss,
  byPageDiscuss,
  byTab,
  byTabCreate,
  byUploadSource,
  byUploadTab,
  GUEST_CLASS,
  GUEST_SAFE_COMMANDS,
  guestClassOf,
  guestRoleAllows,
  type GuestRule
} from '../../src/shared/guest-class'
import { INVOKE_CHANNELS, REMOTE_CLASS, type InvokeChannel } from '../../src/shared/ipc'
import { CORE_COMMANDS } from '../../src/main/commands/command-registry'

// design-guests §4 / shared/design.md §16.3: what a guest may call. Default deny, narrower than REMOTE_CLASS.

const MALFORMED: unknown[] = [undefined, null, 3, 'x', [], [{ tabId: 't' }], { tabId: 3 }, { tabId: '' }, { tabId: 'x'.repeat(201) }]

describe('GUEST_CLASS', () => {
  it('has exactly one entry per invoke channel', () => {
    expect(Object.keys(GUEST_CLASS).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('only narrows REMOTE_CLASS: no channel a remote view may not call is read or write for a guest', () => {
    for (const channel of INVOKE_CHANNELS) {
      if (REMOTE_CLASS[channel] === 'no') expect(GUEST_CLASS[channel].cls, channel).toBe('no')
    }
  })

  it('answers no for unknown and inherited names', () => {
    for (const name of ['nope', '__proto__', 'toString', 'constructor', 'hasOwnProperty', '']) expect(guestClassOf(name).cls).toBe('no')
  })

  it('gives every read or write channel whose request names a target an extractor', () => {
    // Runtime twin of the type rule (GuestRule): a read/write entry of a channel whose request has a target
    // field. Channels with no target field and no extractor are the "plain" ones listed here.
    const plain = new Set([
      'window.info', 'app.openExternal', 'theme.get', 'theme.scheme', 'prefs.get', 'sessions.list', 'layout.get',
      'commands.list', 'pageTabs.unsaved', 'overlays.list', 'tabs.list', 'groups.get', 'tabs.visibility', 'presence.get',
      // An upload id only (design-upload.md §6): the role alone, and main answers the id only to its device.
      'uploads.resolve', 'uploads.cancel', 'uploads.paste'
    ])
    for (const channel of INVOKE_CHANNELS) {
      const rule = guestClassOf(channel)
      if (rule.cls === 'no') continue
      if (plain.has(channel)) expect(rule.target, channel).toBeUndefined()
      else expect(typeof rule.target, channel).toBe('function')
    }
  })

  // docs/design-overlay-views.md §5 "Guest rows": a guest's own copy of a perView overlay (the handlers refuse any
  // other overlay); Take over stays the owner's; results and the close are write (a read guest's ✕ is its release).
  it('a guest connects, talks through and releases its own overlay copy (read, the overlay its target)', () => {
    for (const channel of ['overlays.ready', 'overlays.loaded', 'overlays.message', 'overlays.release'] as const) {
      const rule = GUEST_CLASS[channel]
      expect(rule.cls, channel).toBe('read')
      const target = 'target' in rule ? rule.target : undefined
      expect(target?.({ overlayId: 'o1', copy: 'c' }), channel).toEqual([{ overlay: 'o1' }])
      // Fails closed on a malformed request: no overlay named, or not a string.
      expect(target?.({ copy: 'c' }), channel).toBeUndefined()
      expect(target?.({ overlayId: 7 }), channel).toBeUndefined()
      expect(target?.(undefined), channel).toBeUndefined()
    }
    expect(GUEST_CLASS['overlays.take'].cls).toBe('no')
    expect(GUEST_CLASS['overlays.result'].cls).toBe('write')
    expect(GUEST_CLASS['overlays.close'].cls).toBe('write')
  })

  // shared/design.md §3, §5 (00 contract): a read guest reads its copy's notes; writing notes and Ask (start, say,
  // close, pick) are a write guest's; Continue in a tab opens a Claude tab in the owner's project, the owner's alone.
  it('notes.read is read; notes.write and ask.start/say/close/pick are write; ask.continue is no', () => {
    const rules: Array<[InvokeChannel, 'read' | 'write']> = [
      ['overlays.notes.read', 'read'],
      ['overlays.notes.write', 'write'],
      ['overlays.ask.start', 'write'],
      ['overlays.ask.say', 'write'],
      ['overlays.ask.close', 'write'],
      ['overlays.ask.pick', 'write']
    ]
    for (const [channel, cls] of rules) {
      const rule = GUEST_CLASS[channel]
      expect(rule.cls, channel).toBe(cls)
      const target = 'target' in rule ? rule.target : undefined
      expect(target?.({ overlayId: 'o1', copy: 'c', op: 'add' }), channel).toEqual([{ overlay: 'o1' }])
      // A malformed payload names no target: refused before the handler.
      for (const bad of [undefined, null, 'o1', [], { copy: 'c' }, { overlayId: 7 }, { overlayId: '' }]) {
        expect(target?.(bad), `${channel} ${JSON.stringify(bad)}`).toBeUndefined()
      }
    }
    expect(GUEST_CLASS['overlays.ask.continue'].cls).toBe('no')
    for (const channel of ['overlays.notes.read', 'overlays.notes.write', 'overlays.ask.start', 'overlays.ask.continue'] as const) {
      expect(REMOTE_CLASS[channel], channel).toBe('yes')
    }
  })

  it('keeps the riskiest channels away from guests (design §4)', () => {
    const never: InvokeChannel[] = [
      'links.answer', 'oauth.paste', 'plugins.limits.set', 'plugins.globalLimits.set', 'projects.close',
      'settings.pluginInstall', 'settings.marketplaceInstall', 'settings.pluginSettingsSave', 'settings.webDeviceRevoke',
      'settings.webAccessSet', 'layout.set', 'tabs.flag', 'tabs.toggleFlag', 'tabs.rename', 'tabs.reorder', 'tabs.roomMark',
      'tabs.commands', 'tabs.screen', 'rooms.doc', 'rooms.pause', 'overlays.take', 'overlays.bounds', 'sessions.closeAnswer',
      'groups.place', 'groups.area', 'notices.click', 'settingsPage.connect', 'guests.list', 'guests.invite', 'guests.kick',
      'guests.setRole', 'guests.setScope', 'guests.shareTab', 'guests.revokeInvite', 'settings.pluginGuestAccessSet',
      'tabs.guestCloseAnswer', 'settings.claudeStatus', 'settings.claudeOfferSet', 'claude.offer', 'claude.install'
    ]
    for (const channel of never) expect(GUEST_CLASS[channel].cls, channel).toBe('no')
  })

  it('lets a read guest watch and a write guest pair', () => {
    for (const c of ['tabs.list', 'tabs.ack', 'tabs.selected', 'panels.connect', 'groups.get', 'presence.get'] as const) {
      expect(GUEST_CLASS[c].cls, c).toBe('read')
    }
    for (const c of ['tabs.input', 'tabs.fit', 'tabs.create', 'tabs.close', 'trash.answer', 'downloads.accept', 'commands.run'] as const) {
      expect(GUEST_CLASS[c].cls, c).toBe('write')
    }
  })

  it('the type makes an extractor mandatory on a read or write entry whose request names a target', () => {
    // @ts-expect-error: tabs.input names a tabId, so a write entry without a target does not compile.
    const bad: GuestRule<'tabs.input'> = { cls: 'write' }
    const fine: GuestRule<'tabs.input'> = { cls: 'no' }
    const plain: GuestRule<'tabs.list'> = { cls: 'read' }
    expect([bad.cls, fine.cls, plain.cls]).toEqual(['write', 'no', 'read'])
  })
})

describe('guestRoleAllows', () => {
  it('read for both roles, write for write guests, no for none', () => {
    expect(guestRoleAllows('read', 'read')).toBe(true)
    expect(guestRoleAllows('write', 'read')).toBe(true)
    expect(guestRoleAllows('read', 'write')).toBe(false)
    expect(guestRoleAllows('write', 'write')).toBe(true)
    expect(guestRoleAllows('write', 'no')).toBe(false)
    expect(guestRoleAllows('read', 'no')).toBe(false)
  })
})

describe('target extractors (fail closed)', () => {
  it('byTab: the tab, or undefined for anything malformed', () => {
    expect(byTab({ tabId: 't1', data: 'x' })).toEqual([{ tab: 't1' }])
    for (const raw of MALFORMED) expect(byTab(raw), JSON.stringify(raw)).toBeUndefined()
    // An inherited key is not the payload's own.
    expect(byTab(Object.create({ tabId: 't1' }))).toBeUndefined()
  })

  it('every extractor of the table is undefined on a non-object', () => {
    for (const channel of INVOKE_CHANNELS) {
      const target = guestClassOf(channel).target
      if (!target) continue
      for (const raw of [undefined, null, 3, 'x', []]) expect(target(raw), `${channel} ${JSON.stringify(raw)}`).toBeUndefined()
    }
  })

  it('commands.run: the plugin before the first slash; core ids and junk refused', () => {
    expect(byCommand({ id: 'bronos.team/start' })).toEqual([{ plugin: 'bronos.team' }])
    expect(byCommand({ id: 'a.b/c/d' })).toEqual([{ plugin: 'a.b' }])
    for (const id of ['tab.close', '/x', '', 3, undefined, 'x'.repeat(201)]) expect(byCommand({ id }), String(id)).toBeUndefined()
  })

  it('tabs.create: Claude and Shell only; beside must name a tab', () => {
    expect(byTabCreate({ kind: 'claude' })).toEqual([])
    expect(byTabCreate({ kind: 'shell', cwd: '/x' })).toEqual([])
    expect(byTabCreate({ kind: 'claude', beside: { tabId: 't2', edge: 'right' } })).toEqual([{ tab: 't2' }])
    expect(byTabCreate({ kind: 'command', level: 'app', entryId: 'e' })).toBeUndefined()
    expect(byTabCreate({ kind: 'page' })).toBeUndefined()
    expect(byTabCreate({ kind: 'claude', beside: {} })).toBeUndefined()
    expect(byTabCreate({ kind: 'claude', beside: 'left' })).toBeUndefined()
    expect(GUEST_CLASS['tabs.create'].cls).toBe('write')
  })

  it('the Terminal panel is never a guest\'s: no tab created there, no dock, no panel selection (design-terminal-panel §8)', () => {
    expect(byTabCreate({ kind: 'shell', dock: 'panel' })).toBeUndefined()
    // Any value, even one main would not take: present is refused.
    expect(byTabCreate({ kind: 'shell', dock: null })).toBeUndefined()
    expect(GUEST_CLASS['tabs.dock'].cls).toBe('no')
    expect(GUEST_CLASS['tabs.panelSelected'].cls).toBe('no')
    expect(REMOTE_CLASS['tabs.dock']).toBe('yes')
    expect(REMOTE_CLASS['tabs.panelSelected']).toBe('adapted')
  })

  it('Discuss: the page tab or overlay and the target tab; a new session names none', () => {
    expect(byPageDiscuss({ tabId: 'p', question: 'q', target: { kind: 'tab', tabId: 'c' } })).toEqual([{ tab: 'p' }, { tab: 'c' }])
    expect(byPageDiscuss({ tabId: 'p', question: 'q', target: { kind: 'new' } })).toEqual([{ tab: 'p' }])
    expect(byPageDiscuss({ tabId: 'p', target: { kind: 'tab' } })).toBeUndefined()
    expect(byPageDiscuss({ tabId: 'p' })).toBeUndefined()
    expect(byOverlayDiscuss({ overlayId: 'o', target: { kind: 'tab', tabId: 'c' } })).toEqual([{ overlay: 'o' }, { tab: 'c' }])
    expect(byOverlayDiscuss({ overlayId: 'o', target: { kind: 'other', tabId: 'c' } })).toBeUndefined()
  })

  it('uploads.begin: exactly one source, a panel or a tab; both, neither or junk refused', () => {
    expect(byUploadSource({ source: { panel: 'cockpit.files/tree' }, folder: '', files: [] })).toEqual([{ panel: 'cockpit.files/tree' }])
    expect(byUploadSource({ source: { tab: 't1' }, folder: '' })).toEqual([{ tab: 't1' }])
    for (const source of [undefined, null, 'cockpit.files/tree', {}, { panel: 'a/b', tab: 't1' }, { panel: '' }, { tab: 3 }, { tab: 'x'.repeat(201) }, ['t1'], Object.create({ tab: 't1' })]) {
      expect(byUploadSource({ source }), JSON.stringify(source)).toBeUndefined()
    }
    // A panel and a tab together are refused even when one of them is junk: the handler must act on what was checked.
    expect(byUploadSource({ source: { panel: 'a/b', tab: 3 } })).toBeUndefined()
    expect(GUEST_CLASS['uploads.begin'].cls).toBe('write')
  })

  it('uploads.folders: the terminal tab (`tab`, not `tabId`)', () => {
    expect(byUploadTab({ tab: 't1', path: 'src' })).toEqual([{ tab: 't1' }])
    for (const raw of [{ tabId: 't1' }, { tab: '' }, { tab: 2 }, { tab: 'x'.repeat(201) }]) expect(byUploadTab(raw), JSON.stringify(raw)).toBeUndefined()
    expect(GUEST_CLASS['uploads.folders'].cls).toBe('write')
    for (const c of ['uploads.resolve', 'uploads.cancel', 'uploads.paste'] as const) expect(GUEST_CLASS[c]).toEqual({ cls: 'write' })
  })

  it('overlays.button: the overlay, plus the plugin of a type button', () => {
    expect(byOverlayButton({ overlayId: 'o', source: 'opener', buttonId: 'b' })).toEqual([{ overlay: 'o' }])
    expect(byOverlayButton({ overlayId: 'o', source: 'type', pluginId: 'x.y', buttonId: 'b' })).toEqual([{ overlay: 'o' }, { plugin: 'x.y' }])
    expect(byOverlayButton({ overlayId: 'o', source: 'type', pluginId: 7, buttonId: 'b' })).toBeUndefined()
  })
})

describe('GUEST_SAFE_COMMANDS', () => {
  it('names only core commands, and a write guest has every read command', () => {
    const core = new Set(CORE_COMMANDS.map((c) => c.id))
    for (const role of ['read', 'write'] as const) for (const id of GUEST_SAFE_COMMANDS[role]) expect(core.has(id), id).toBe(true)
    for (const id of GUEST_SAFE_COMMANDS.read) expect(GUEST_SAFE_COMMANDS.write).toContain(id)
  })

  it('never offers settings, folders, flags, layout or group edits', () => {
    for (const id of ['app.openSettings', 'app.openFolder', 'tab.toggleFlag', 'zone.toggleLeft', 'pane.splitRight', 'pane.ungroup']) {
      expect(GUEST_SAFE_COMMANDS.write, id).not.toContain(id)
    }
    expect(GUEST_SAFE_COMMANDS.read).not.toContain('tab.newClaude')
    expect(GUEST_SAFE_COMMANDS.read).not.toContain('tab.close')
  })
})
