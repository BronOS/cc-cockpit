// The guest's shell (design-guests §6, §9, §10; spec-review 10, 24; D-10, D-17, D-22): what each access is
// offered, the empty tab area's text, the Deny-only trash ask on a desktop host, and the port message's
// access and one-way hints. UI hints only: main refuses by the view it bound, whatever the page shows.
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PORT_MESSAGE } from '../../src/sdk/panel-core'
import { trashDenyOnlyNote, trashMayAllow } from '../../src/renderer/notices/notice-state'
import { portMessage, withPortFlags } from '../../src/renderer/plugins/frame-messages'
import { deliverPanelPort, isOneWayPort, requestPanelPort } from '../../src/renderer/plugins/panel-port-bus'
import { markWebShell, resetShellKindForTest, setGuestHint } from '../../src/renderer/shell-kind'
import { emptyTabsText, shellAllows } from '../../src/renderer/tabs/guest-shell'

afterEach(() => {
  resetShellKindForTest()
  vi.unstubAllGlobals()
})

describe('shellAllows', () => {
  it('offers the owner everything', () => {
    expect(shellAllows('owner')).toEqual({ arrange: true, ownerTools: true, write: true })
  })

  it("a write guest writes into what is shared, never arranges nor uses the owner's tools", () => {
    expect(shellAllows('write')).toEqual({ arrange: false, ownerTools: false, write: true })
  })

  it('a read guest gets none of them', () => {
    expect(shellAllows('read')).toEqual({ arrange: false, ownerTools: false, write: false })
  })
})

describe('emptyTabsText', () => {
  it('says nothing is shared to a guest, and how to start one to the owner', () => {
    expect(emptyTabsText('read')).toBe('Nothing shared right now')
    expect(emptyTabsText('write')).toBe('Nothing shared right now')
    expect(emptyTabsText('owner')).toContain('Use +')
  })
})

describe('trash asks for guests (D-10)', () => {
  it('a guest on a desktop host may only Deny; in server mode it may Allow; owners are unchanged', () => {
    expect(trashMayAllow({ guest: true, server: false })).toBe(false)
    expect(trashMayAllow({ guest: true, server: true, write: true })).toBe(true)
    expect(trashMayAllow({ guest: true, server: true, write: false })).toBe(false)
    expect(trashMayAllow({ guest: true, server: true })).toBe(false)
    expect(trashMayAllow({ guest: false, server: false })).toBe(true)
    expect(trashMayAllow({ guest: false, server: true })).toBe(true)
    expect(trashDenyOnlyNote('Oleg')).toBe('Only Oleg can move it to the Trash')
  })

  it('the Deny-only dialog draws no Allow button, and the note beside Deny', async () => {
    const dialog = '../../src/renderer/notices/ApprovalDialog.tsx'
    const { ApprovalBox } = (await import(dialog)) as { ApprovalBox: FunctionComponent<Record<string, unknown>> }
    const html = renderToStaticMarkup(
      createElement(ApprovalBox, {
        title: 'Move?',
        children: 'Body',
        allowLabel: 'Move to Trash',
        denyLabel: 'Cancel',
        denyOnly: true,
        note: trashDenyOnlyNote('Host'),
        onAnswer: () => {}
      })
    )
    expect(html).not.toContain('Move to Trash')
    expect((html.match(/<button/g) ?? []).length).toBe(1)
    expect(html).toContain('Only Host can move it to the Trash')
    expect(html).toContain('>Cancel</button>')
  })
})

describe('the port message (ccPanel.view.access, oneWay)', () => {
  it("says the desktop's access is the owner's", () => {
    expect(portMessage()).toEqual({ type: PORT_MESSAGE, remote: false, access: 'owner' })
  })

  it("says a guest's role in the web shell", () => {
    markWebShell()
    setGuestHint({ id: 'g1', name: 'Ana', role: 'read', ownerName: 'Host' })
    expect(portMessage()).toEqual({ type: PORT_MESSAGE, remote: true, access: 'read' })
  })

  it('adds oneWay only to the port message of a one-way port', () => {
    const msg = portMessage()
    expect(withPortFlags(msg, false)).toBe(msg)
    expect(withPortFlags(msg, true)).toEqual({ ...msg, oneWay: true })
    const theme = { type: 'cc-plugin.theme' }
    expect(withPortFlags(theme, true)).toBe(theme)
    expect(withPortFlags('text', true)).toBe('text')
  })

  it('remembers which delivered ports main marked one-way (only `true` counts)', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { cockpit: { invoke: () => Promise.resolve(true) } }))
    const a = new MessageChannel()
    const b = new MessageChannel()
    const c = new MessageChannel()
    try {
      const got: MessagePort[] = []
      // The module's nonces count from 1, one per request (a fresh module per test file).
      requestPanelPort('p.one/a', (port) => got.push(port))
      expect(deliverPanelPort('p.one/a', 99, a.port1, true)).toBe(false) // a nonce nobody asked with
      expect(deliverPanelPort('p.one/a', 1, a.port1, true)).toBe(true)
      requestPanelPort('p.one/b', (port) => got.push(port))
      expect(deliverPanelPort('p.one/b', 2, b.port1, 'yes')).toBe(true)
      requestPanelPort('p.one/c', (port) => got.push(port))
      expect(deliverPanelPort('p.one/c', 3, c.port1)).toBe(true)
      expect(got).toHaveLength(3)
      expect(isOneWayPort(a.port1)).toBe(true)
      expect(isOneWayPort(b.port1)).toBe(false)
      expect(isOneWayPort(c.port1)).toBe(false)
    } finally {
      for (const ch of [a, b, c]) {
        ch.port1.close()
        ch.port2.close()
      }
    }
  })
})
