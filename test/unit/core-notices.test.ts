// Core notices (notifications/core-notices.ts, server-mode plan Task 22): the desktop's OS
// notification as before, and in server mode one stdout line each, kept for `ccc web status`.
import { describe, expect, it } from 'vitest'
import { CORE_NOTICE_PREFIX, CoreNotices, MAX_CORE_NOTICE_LINE, MAX_CORE_NOTICES } from '../../src/main/notifications/core-notices'
import { revocationNoticeLines } from '../../src/main/marketplace/marketplace-view'

function make(server: boolean): { notices: CoreNotices; desktop: Array<[string, string | undefined]>; out: string[] } {
  const desktop: Array<[string, string | undefined]> = []
  const out: string[] = []
  let t = 1000
  const notices = new CoreNotices({
    server,
    desktop: (text, title) => desktop.push([text, title]),
    out: (line) => out.push(line),
    now: () => t++
  })
  return { notices, desktop, out }
}

describe('CoreNotices in server mode', () => {
  it('prints each of the three kinds as one stdout line and keeps it for status, never an OS notification', () => {
    const { notices, desktop, out } = make(true)
    notices.show({ kind: 'new-device', text: 'A new device signed in to web access: Phone', title: 'cc-cockpit web access', device: 'dev-1' })
    notices.show({ kind: 'revoked', text: 'Plugin a.b was stopped: the marketplace index revoked it (the reason is on the Plugins page)' })
    notices.show({ kind: 'update', text: 'A new cc-cockpit version is available: 1.2.3 (running 1.0.0)' })
    expect(desktop).toEqual([])
    expect(out).toEqual([
      `${CORE_NOTICE_PREFIX}A new device signed in to web access: Phone`,
      `${CORE_NOTICE_PREFIX}Plugin a.b was stopped: the marketplace index revoked it (the reason is on the Plugins page)`,
      `${CORE_NOTICE_PREFIX}A new cc-cockpit version is available: 1.2.3 (running 1.0.0)`
    ])
    expect(notices.list()).toEqual([
      { kind: 'new-device', text: 'A new device signed in to web access: Phone', at: 1000, device: 'dev-1' },
      { kind: 'revoked', text: 'Plugin a.b was stopped: the marketplace index revoked it (the reason is on the Plugins page)', at: 1001 },
      { kind: 'update', text: 'A new cc-cockpit version is available: 1.2.3 (running 1.0.0)', at: 1002 }
    ])
  })

  it('makes a line plain and one line: control and bidi characters and line breaks are dropped, the length capped', () => {
    const { notices, out } = make(true)
    notices.show({ kind: 'new-device', text: `A new device: Ev\u001b[2Jil\nFAKE LINE‮ ${'x'.repeat(1000)}`, device: 'd\n1' })
    expect(out).toHaveLength(1)
    expect([...out[0]!].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && ch.charCodeAt(0) !== 0x202e)).toBe(true)
    expect(out[0]!.length).toBe(CORE_NOTICE_PREFIX.length + MAX_CORE_NOTICE_LINE)
    expect(notices.list()[0]?.device).toBe('d1')
  })

  it('says nothing for an empty text and keeps only the last MAX_CORE_NOTICES', () => {
    const { notices, out } = make(true)
    notices.show({ kind: 'update', text: ' \u0007 ' })
    expect(out).toEqual([])
    for (let i = 0; i < MAX_CORE_NOTICES + 5; i++) notices.show({ kind: 'update', text: `v${i}` })
    const kept = notices.list()
    expect(kept).toHaveLength(MAX_CORE_NOTICES)
    expect(kept[0]?.text).toBe('v5')
    expect(kept.at(-1)?.text).toBe(`v${MAX_CORE_NOTICES + 4}`)
  })

  it('lists copies: a caller cannot change what status will show', () => {
    const { notices } = make(true)
    notices.show({ kind: 'update', text: 'v1' })
    notices.list()[0]!.text = 'changed'
    expect(notices.list()[0]?.text).toBe('v1')
  })
})

describe('CoreNotices on the desktop', () => {
  it('is the OS notification with its text and title as given, and no stdout line and nothing to list', () => {
    const { notices, desktop, out } = make(false)
    notices.show({ kind: 'new-device', text: 'A new device signed in to web access: Phone', title: 'cc-cockpit web access', device: 'dev-1' })
    notices.show({ kind: 'revoked', text: 'Plugin a.b was stopped: steals tokens (revoked by https://index.example/x.json)' })
    expect(desktop).toEqual([
      ['A new device signed in to web access: Phone', 'cc-cockpit web access'],
      ['Plugin a.b was stopped: steals tokens (revoked by https://index.example/x.json)', undefined]
    ])
    expect(out).toEqual([])
    expect(notices.list()).toEqual([])
  })
})

describe('revocationNoticeLines', () => {
  it('is one line per plugin with the id only: no index reason, no index URL', () => {
    const lines = revocationNoticeLines([
      { id: 'a.b', revoked: { reason: 'steals tokens, see https://evil.example', source: 'https://index.example/x.json' } },
      { id: 'c.d', revoked: { reason: 'bad', source: 'https://other.example/y.json' } }
    ])
    expect(lines).toEqual([
      'Plugin a.b was stopped: the marketplace index revoked it (the reason is on the Plugins page)',
      'Plugin c.d was stopped: the marketplace index revoked it (the reason is on the Plugins page)'
    ])
    for (const line of lines) expect(line).not.toMatch(/steals|evil|https?:|index\.example/)
  })
})
