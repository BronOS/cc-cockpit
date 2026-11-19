import { describe, expect, it } from 'vitest'
import { GUEST_NAME_MAX, MAX_GUESTS, type GuestInviteError } from '../../src/shared/guests'
import type { PluginView, TabInfo } from '../../src/shared/ipc'
import {
  emptyInviteForm,
  inviteConfirmTitle,
  inviteErrorText,
  inviteProblem,
  inviteRequest,
  inviteTabRows,
  LIFETIME_LABEL,
  LINK_ONCE_TEXT,
  LOOPBACK_WARNING_TEXT,
  SCROLLBACK_LINE,
  sharedPluginNames,
  writeWarning
} from '../../src/renderer/guests/invite-model'

describe('the invite form', () => {
  it('starts read-only, all tabs, one day (D-12)', () => {
    expect(emptyInviteForm()).toEqual({ name: '', role: 'read', tabs: 'all', selected: [], lifetime: '1d' })
    expect(LIFETIME_LABEL).toEqual({ '1d': '1 day', '7d': '7 days', forever: 'Until removed' })
  })

  it('needs a one-line name of at most GUEST_NAME_MAX characters', () => {
    const form = emptyInviteForm()
    expect(inviteProblem(form)).toBe('Give the guest a name: it is what you and others see.')
    expect(inviteProblem({ ...form, name: '   ' })).toBeDefined()
    expect(inviteProblem({ ...form, name: 'a'.repeat(GUEST_NAME_MAX) })).toBeUndefined()
    expect(inviteProblem({ ...form, name: 'a'.repeat(GUEST_NAME_MAX + 1) })).toBe(`The name is at most ${GUEST_NAME_MAX} characters.`)
    // Counted in code points: 60 emoji are 60 characters, not 120.
    expect(inviteProblem({ ...form, name: '😀'.repeat(GUEST_NAME_MAX) })).toBeUndefined()
    // Newline, tab, NEL (C1), the line separator, DEL.
    for (const code of [0x0a, 0x09, 0x85, 0x2028, 0x7f]) {
      const bad = `a${String.fromCharCode(code)}b`
      expect(inviteProblem({ ...form, name: bad }), code.toString(16)).toBe('The name is one line of plain text.')
    }
  })

  it('needs a tab when sharing selected tabs', () => {
    const form = { ...emptyInviteForm(), name: 'Ada', tabs: 'selected' as const }
    expect(inviteProblem(form)).toBe('Pick at least one tab, or share all tabs.')
    expect(inviteProblem({ ...form, selected: ['t1'] })).toBeUndefined()
  })

  it('sends the trimmed name and the scope, dropping selected tabs that closed meanwhile', () => {
    const form = { ...emptyInviteForm(), name: '  Ada ', role: 'write' as const, lifetime: '7d' as const }
    expect(inviteRequest(form, ['t1'])).toEqual({ name: 'Ada', role: 'write', scope: 'all', lifetime: '7d' })
    const selected = { ...form, tabs: 'selected' as const, selected: ['t1', 'gone'] }
    expect(inviteRequest(selected, ['t1', 't2'])).toEqual({ name: 'Ada', role: 'write', scope: ['t1'], lifetime: '7d' })
    expect(inviteRequest({ ...selected, selected: ['gone'] }, ['t1'])).toBeUndefined()
    expect(inviteRequest({ ...form, name: '' }, [])).toBeUndefined()
  })
})

describe('the invite texts', () => {
  it('carries the write warning of design §10 verbatim', () => {
    const w = writeWarning(' Ada ')
    expect(`${w.headline} ${w.body}`).toBe(
      'Ada can run anything as you. Typing in a shared tab runs commands here as you: they can read your files, mail ' +
        'and plugin data from a shell and give themselves lasting access (a new device, an SSH key). Kicking ends their ' +
        'session, not what they ran. Invite only someone you would hand your unlocked laptop.'
    )
    expect(writeWarning('').headline).toBe('This guest can run anything as you.')
  })

  it('says the scrollback line, the one-use link line and the loopback warning (D-13, D-5, D-35)', () => {
    expect(SCROLLBACK_LINE).toBe('Scrollback from before now is visible in shared tabs.')
    expect(LINK_ONCE_TEXT).toBe('This link works once. It expires in 24 hours if unused.')
    expect(LOOPBACK_WARNING_TEXT).toBe(
      'Web access listens on this computer only, so nobody else can open this link yet. In Settings › General › Web ' +
        'access, listen on the network with TLS (or confirm plain http), or run a tunnel (Tailscale Funnel, cloudflared, ' +
        'ngrok) and set the external address.'
    )
  })

  it('names every refusal in plain words (D-1 for None)', () => {
    expect(inviteErrorText('none-mode', 'Ada')).toBe(
      'Guests need a sign-in mode: Access link, Password or Desktop confirm. Web access sign-in is None.'
    )
    expect(inviteErrorText('name-taken', ' Ada ')).toBe('A guest named Ada is already here. Pick another name.')
    expect(inviteErrorText('cap', 'Ada')).toContain(String(MAX_GUESTS))
    expect(inviteErrorText('full', 'Ada')).toContain('Revoke a device')
    const all: GuestInviteError[] = ['none-mode', 'name-taken', 'cap', 'full']
    for (const e of all) expect(inviteErrorText(e, 'x').length).toBeGreaterThan(0)
  })

  it('asks the armed confirm with the role', () => {
    expect(inviteConfirmTitle(' Ada ', 'read')).toBe('Invite Ada read-only?')
    expect(inviteConfirmTitle('Ada', 'write')).toBe('Invite Ada with write access?')
  })
})

describe('what the dialog lists', () => {
  it('lists terminal and page tabs with their strip labels', () => {
    const tabs = [
      { id: 't1', kind: 'shell', cwd: '/home/me/proj' },
      { id: 't2', kind: 'page', cwd: '/p', page: { title: 'a.ts' } },
      { id: 't3', kind: 'command', cwd: '/p', label: 'Tests' }
    ] as TabInfo[]
    expect(inviteTabRows(tabs)).toEqual([
      { id: 't1', label: 'Shell · proj' },
      { id: 't2', label: 'a.ts' },
      { id: 't3', label: 'Tests' }
    ])
  })

  it('lists the running plugins guests see now; absent guestAccess is hidden', () => {
    const p = (id: string, over: Partial<PluginView>): PluginView => ({ id, name: id.toUpperCase(), state: { ok: true }, ...over }) as PluginView
    const shown = { effective: 'shown', source: 'app', aware: true } as const
    const hidden = { effective: 'hidden', source: 'default', aware: false } as const
    expect(
      sharedPluginNames([
        p('a', { guestAccess: shown }),
        p('b', { guestAccess: hidden }),
        p('c', {}),
        p('d', { guestAccess: shown, state: { ok: false, reason: 'off' } })
      ])
    ).toEqual(['A'])
  })
})
