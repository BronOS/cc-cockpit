// A guest's saved server (design-guests §11, D-29, D-32): the invite link Direct reads
// (`parseRemoteLink` over the web client's own `parseInviteFragment`), the record's `guest` and
// `certSha256` as `validateRemoteServers` reads them back from a hand-editable app.json (absent in old
// records, a damaged pin dropped: no pin is Chromium's own verdict, so it fails closed), the pin's
// display and answer forms, and the store carrying both fields from `prepare` to `insert` while
// Edit cannot move a guest to another address.
import { describe, expect, it } from 'vitest'
import { RemoteServerStore } from '../../src/main/remote/remote-servers'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { certAnswerPin, certFingerprintText, certPinOf, parseRemoteLink, validateRemoteServers } from '../../src/shared/remote-servers'
import type { AppSettings } from '../../src/shared/types'
import { inviteLink } from '../../src/shared/web-protocol'

/** An invite token as the host mints it: 43 base64url characters. */
const INVITE = 'Ab0-'.repeat(10) + 'x_Z'
const PIN = '0123456789abcdef'.repeat(4)
const ORIGIN = 'https://host.example:8765'

describe('parseRemoteLink: guest invites', () => {
  it('reads #i=<token>, with the pin from &c= on https; the token never lands in `token`', () => {
    expect(parseRemoteLink(`${ORIGIN}/#i=${INVITE}`)).toEqual({ origin: ORIGIN, guest: true, invite: INVITE })
    expect(parseRemoteLink(inviteLink(ORIGIN, INVITE, PIN))).toEqual({ origin: ORIGIN, guest: true, invite: INVITE, certPin: PIN })
    expect(parseRemoteLink(`  ${ORIGIN}/#c=${PIN}&i=${INVITE}  `)).toEqual({ origin: ORIGIN, guest: true, invite: INVITE, certPin: PIN })
    // An invite on plain http is fine with no pin (a LAN host with TLS off).
    expect(parseRemoteLink(`http://192.168.1.5:8765/#i=${INVITE}`)).toEqual({ origin: 'http://192.168.1.5:8765', guest: true, invite: INVITE })
    // An access link is still one, and says nothing of guests.
    expect(parseRemoteLink(`${ORIGIN}/#t=abc`)).toEqual({ origin: ORIGIN, token: 'abc' })
  })

  it('refuses a pin on an http link', () => {
    expect(parseRemoteLink(`http://192.168.1.5:8765/#i=${INVITE}&c=${PIN}`)).toEqual({ error: 'a certificate pin needs an https link' })
  })

  it.each([
    ['an unknown key', `#i=${INVITE}&x=1`],
    ['an access token beside it', `#t=abc&i=${INVITE}`],
    ['a repeated token', `#i=${INVITE}&i=${INVITE}`],
    ['a repeated pin', `#i=${INVITE}&c=${PIN}&c=${PIN}`],
    ['a short token', '#i=abc'],
    ['an empty token', '#i='],
    ['a token with a dot', `#i=${INVITE.slice(1)}.`],
    ['an upper-case pin', `#i=${INVITE}&c=${PIN.toUpperCase()}`],
    ['a short pin', `#i=${INVITE}&c=${PIN.slice(1)}`],
    ['a pin with no token', `#c=${PIN}&i`]
  ])('refuses %s, never reading it as an access link', (_what, fragment) => {
    const link = parseRemoteLink(`${ORIGIN}/${fragment}`)
    expect(link).toEqual({ error: 'this invite link is damaged; ask the host for a new one' })
  })

  it('still holds an invite to the origin rules (no path, no query, no user)', () => {
    expect(parseRemoteLink(`${ORIGIN}/app#i=${INVITE}`)).toHaveProperty('error')
    expect(parseRemoteLink(`${ORIGIN}/?project=p#i=${INVITE}`)).toHaveProperty('error')
    expect(parseRemoteLink(`https://me@host.example/#i=${INVITE}`)).toHaveProperty('error')
  })
})

describe('certificate pin forms', () => {
  it('shows a pin as colon pairs and takes either form back', () => {
    const shown = certFingerprintText(PIN)
    expect(shown).toBe('01:23:45:67:89:AB:CD:EF:'.repeat(4).slice(0, -1))
    expect(certAnswerPin(shown)).toBe(PIN)
    expect(certAnswerPin(PIN)).toBe(PIN)
    expect(certAnswerPin(PIN.toUpperCase())).toBe(PIN)
    for (const bad of [undefined, 7, '', 'zz', PIN.slice(2), `${PIN}00`, `${shown}:${'0'.repeat(80)}`]) expect(certAnswerPin(bad)).toBeUndefined()
    expect(certPinOf(PIN)).toBe(PIN)
    expect(certPinOf(PIN.toUpperCase())).toBeUndefined()
  })
})

describe('validateRemoteServers: guest fields', () => {
  const direct = (origin: string, extra: Record<string, unknown> = {}) => ({ id: 'g1', name: 'Host', via: { kind: 'direct', origin }, recent: [], ...extra })

  it('keeps a guest and its pin; an old record has neither', () => {
    expect(validateRemoteServers([direct(ORIGIN, { guest: true, certSha256: PIN })])).toEqual([direct(ORIGIN, { guest: true, certSha256: PIN })])
    expect(validateRemoteServers([direct(ORIGIN, { guest: true })])).toEqual([direct(ORIGIN, { guest: true })])
    const [old] = validateRemoteServers([direct(ORIGIN)])
    expect(old).toEqual(direct(ORIGIN))
    expect(old).not.toHaveProperty('guest')
    expect(old).not.toHaveProperty('certSha256')
  })

  it.each([
    ['upper case', PIN.toUpperCase()],
    ['too short', PIN.slice(1)],
    ['not hex', `${PIN.slice(1)}g`],
    ['the shown form', certFingerprintText(PIN)],
    ['a number', 5]
  ])('drops a malformed pin (%s) and keeps the guest: no pin fails closed', (_what, certPin) => {
    expect(validateRemoteServers([direct(ORIGIN, { guest: true, certSha256: certPin })])).toEqual([direct(ORIGIN, { guest: true })])
  })

  it('drops a pin on http, a pin with no guest, a guest flag that is not true, and guest fields on another kind', () => {
    expect(validateRemoteServers([direct('http://192.168.1.5:8765', { guest: true, certSha256: PIN })])).toEqual([direct('http://192.168.1.5:8765', { guest: true })])
    expect(validateRemoteServers([direct(ORIGIN, { certSha256: PIN })])).toEqual([direct(ORIGIN)])
    expect(validateRemoteServers([direct(ORIGIN, { guest: 'yes', certSha256: PIN })])).toEqual([direct(ORIGIN)])
    expect(validateRemoteServers([{ id: 's1', name: 'devbox', via: { kind: 'ssh', host: 'devbox' }, recent: [], guest: true, certSha256: PIN }])).toEqual([
      { id: 's1', name: 'devbox', via: { kind: 'ssh', host: 'devbox' }, recent: [] }
    ])
  })
})

describe('RemoteServerStore: guest records', () => {
  function make() {
    const app = { data: {} as AppSettings, update: (mutate: (data: AppSettings) => void) => mutate(app.data) }
    let ids = 0
    return { app, store: new RemoteServerStore({ app, secrets: fakeSecretStore(), newId: () => `g${++ids}` }) }
  }

  it('carries guest and the pin from prepare to insert, and lists them', async () => {
    const { store, app } = make()
    const prepared = store.prepare({ via: { kind: 'direct', origin: ORIGIN }, guest: true, certPin: PIN })
    expect(prepared.saved).toBe(false)
    expect(prepared.record).toMatchObject({ guest: true, certSha256: PIN })
    expect(app.data.remoteServers).toBeUndefined()
    store.insert(prepared.record)
    expect(store.get('g1')).toEqual({ id: 'g1', name: 'host.example:8765', via: { kind: 'direct', origin: ORIGIN }, recent: [], guest: true, certSha256: PIN })
    expect((await store.list())[0]).toMatchObject({ guest: true, certSha256: PIN })
    // A saved one keeps its own fields: prepare answers it as is.
    expect(store.prepare({ via: { kind: 'direct', origin: ORIGIN } })).toMatchObject({ saved: true, record: { guest: true, certSha256: PIN } })
  })

  it('refuses a pin it would not read back; ignores guest fields on another kind', () => {
    const { store } = make()
    expect(() => store.prepare({ via: { kind: 'direct', origin: 'http://192.168.1.5:8765' }, guest: true, certPin: PIN })).toThrow('the certificate pin is not valid')
    expect(() => store.prepare({ via: { kind: 'direct', origin: ORIGIN }, guest: true, certPin: PIN.toUpperCase() })).toThrow('the certificate pin is not valid')
    const ssh = store.prepare({ via: { kind: 'ssh', host: 'devbox' }, guest: true, certPin: PIN })
    expect(ssh.record).not.toHaveProperty('guest')
    expect(() => store.insert({ id: 'x1', name: 'x', via: { kind: 'direct', origin: ORIGIN }, recent: [], guest: true, certSha256: 'nope' })).toThrow('the certificate pin is not valid')
  })

  it('a guest server\'s recents say guest (the picker\'s "Guest at" row) and keep it on read; an owner\'s do not', () => {
    const { store, app } = make()
    store.insert(store.prepare({ via: { kind: 'direct', origin: ORIGIN }, guest: true }).record)
    store.insert(store.prepare({ via: { kind: 'direct', origin: 'https://own.example' } }).record)
    store.recordRecent('g1', 'p1', 'one', 5)
    store.recordRecent('g2', 'p1', 'one', 5)
    expect(store.get('g1')?.recent).toEqual([{ projectId: 'p1', name: 'one', at: 5, guest: true }])
    expect(store.get('g2')?.recent).toEqual([{ projectId: 'p1', name: 'one', at: 5 }])
    expect(validateRemoteServers(app.data.remoteServers)[0]?.recent).toEqual([{ projectId: 'p1', name: 'one', at: 5, guest: true }])
    const damaged = { id: 'g9', name: 'Host', via: { kind: 'direct', origin: ORIGIN }, recent: [{ projectId: 'p', name: 'n', at: 1, guest: 'yes' }] }
    expect(validateRemoteServers([damaged])[0]?.recent).toEqual([{ projectId: 'p', name: 'n', at: 1 }])
  })

  it("Edit renames a guest but never moves it to another address (the pin is that host's)", () => {
    const { store } = make()
    store.insert(store.prepare({ via: { kind: 'direct', origin: ORIGIN }, guest: true, certPin: PIN }).record)
    expect(() => store.edit('g1', { via: { kind: 'direct', origin: 'https://other.example' } })).toThrow('forget it and join again')
    expect(store.edit('g1', { name: 'Alice', via: { kind: 'direct', origin: ORIGIN } })).toEqual({ viaChanged: false, renamed: true, identityChanged: false })
    expect(store.get('g1')).toMatchObject({ name: 'Alice', guest: true, certSha256: PIN })
  })
})
