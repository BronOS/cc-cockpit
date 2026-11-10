// The logic behind Settings › General › Web access and the top bar chip (plan Task 9), apart from the
// React that draws them: Show hides the link by default, the form's patch, the QR matrix.
import { describe, expect, it } from 'vitest'
import { qrOf } from '../../src/renderer/settings/qr'
import {
  agoText,
  confirmCodeReady,
  confirmLeft,
  deviceDetail,
  displayedLink,
  draftOf,
  expiresIn,
  hide,
  hiddenReveal,
  HIDDEN_LINK,
  hostsFromText,
  hostsText,
  indicatorText,
  indicatorTitle,
  isDirty,
  modeNeedsPassword,
  MODE_CHANGE_KEEPS_DEVICES,
  modeHelp,
  modeOptions,
  passwordDraftProblem,
  patchOf,
  qrText,
  revealFrom
} from '../../src/renderer/settings/web-access-model'
import type { WebAccessForm } from '../../src/shared/web-access'

const TOKEN = 'T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenT0k'
const LINK = `http://127.0.0.1:7330/#t=${TOKEN}`
const NOW = 1_700_000_000_000

const form: WebAccessForm = { enabled: true, port: 7330, externalOrigin: '', hosts: ['box.local:7330'], mode: 'link' }

describe('Show hides the link by default', () => {
  it('prints the mask, never the token, until a reply has been revealed', () => {
    const r = hiddenReveal()
    expect(r.shown).toBe(false)
    expect(r.link).toBeUndefined()
    expect(displayedLink(r, NOW)).toBe(HIDDEN_LINK)
    expect(displayedLink(r, NOW)).not.toContain('#t=')
    expect(qrText(r, NOW)).toBeUndefined()
  })

  it('shows the link and its QR text after main answered, and hides again on Hide with nothing kept', () => {
    const r = revealFrom({ ok: true, link: LINK })
    expect(displayedLink(r, NOW)).toBe(LINK)
    expect(qrText(r, NOW)).toBe(LINK)
    const h = hide(r)
    expect(displayedLink(h, NOW)).toBe(HIDDEN_LINK)
    expect(JSON.stringify(h)).not.toContain(TOKEN)
  })

  it('a refusal keeps the reason, shows nothing, and hiding keeps the reason too', () => {
    const r = revealFrom({ ok: false, reason: 'Turn web access on first' })
    expect(r.shown).toBe(false)
    expect(r.reason).toBe('Turn web access on first')
    expect(displayedLink(r, NOW)).toBe(HIDDEN_LINK)
    expect(hide(r).reason).toBe('Turn web access on first')
  })

  it('a one-time link stops being displayed when it expires and counts down', () => {
    const r = revealFrom({ ok: true, link: LINK, expiresAt: NOW + 90_000 })
    expect(displayedLink(r, NOW)).toBe(LINK)
    expect(expiresIn(r, NOW)).toBe('1:30')
    expect(expiresIn(r, NOW + 61_000)).toBe('0:29')
    expect(displayedLink(r, NOW + 90_000)).toBe(HIDDEN_LINK)
    expect(qrText(r, NOW + 90_000)).toBeUndefined()
    expect(expiresIn(r, NOW + 90_000)).toBe('')
    expect(expiresIn(revealFrom({ ok: true, link: LINK }), NOW)).toBe('')
  })
})

describe('the address form', () => {
  it('shows hosts one per line without the gateway port, and reads lines or commas back', () => {
    expect(hostsText(['box.local:7330', 'other:9000', '[::1]:7330'], 7330)).toBe('box.local\nother:9000\n[::1]')
    expect(hostsFromText(' a ,b\n\n c\n')).toEqual(['a', 'b', 'c'])
    expect(hostsFromText('')).toEqual([])
  })

  it('is clean until something differs, and an untouched draft makes an empty patch', () => {
    const draft = draftOf(form)
    expect(draft).toEqual({ port: '7330', externalOrigin: '', hosts: 'box.local' })
    expect(patchOf(form, draft)).toEqual({ patch: {} })
    expect(isDirty(form, draft)).toBe(false)
  })

  it('sends only what changed', () => {
    expect(patchOf(form, { ...draftOf(form), port: '8000' })).toEqual({ patch: { port: 8000 } })
    expect(patchOf(form, { ...draftOf(form), externalOrigin: ' https://x.example ' })).toEqual({ patch: { externalOrigin: 'https://x.example' } })
    expect(patchOf(form, { ...draftOf(form), hosts: 'box.local\nphone.local' })).toEqual({ patch: { hosts: ['box.local', 'phone.local'] } })
    const withOrigin = { ...form, externalOrigin: 'https://x.example' }
    expect(patchOf(withOrigin, { ...draftOf(withOrigin), externalOrigin: '' })).toEqual({ patch: { externalOrigin: null } })
    expect(patchOf(form, { ...draftOf(form), hosts: '' })).toEqual({ patch: { hosts: [] } })
  })

  it('refuses a port that is not a whole number before sending anything', () => {
    for (const port of ['', ' ', 'abc', '80.5', '1e2x']) {
      expect(patchOf(form, { ...draftOf(form), port })).toEqual({ error: 'The port must be a whole number.' })
      expect(isDirty(form, { ...draftOf(form), port })).toBe(true)
    }
    // A number outside the range is main's to refuse, with its own words.
    expect(patchOf(form, { ...draftOf(form), port: '80' })).toEqual({ patch: { port: 80 } })
  })
})

describe('the sign-in modes', () => {
  it('lists all four in the design order, every one can be picked (plan Task 27)', () => {
    const options = modeOptions()
    expect(options.map((o) => o.value)).toEqual(['link', 'password', 'confirm', 'none'])
    expect(options.every((o) => !('unavailable' in o))).toBe(true)
  })

  it('every mode says a change signs no browser out (devices keep their cookie across modes)', () => {
    for (const o of modeOptions()) {
      expect(modeHelp(o.value)).toContain(o.help)
      expect(modeHelp(o.value)).toContain(MODE_CHANGE_KEEPS_DEVICES)
    }
    expect(MODE_CHANGE_KEEPS_DEVICES).toContain('Revoke all')
  })

  it('the password mode asks for a password first when none is set', () => {
    expect(modeNeedsPassword('password', false)).toBe(true)
    expect(modeNeedsPassword('password', true)).toBe(false)
    expect(modeNeedsPassword('confirm', false)).toBe(false)
  })

  it('checks the two password fields before a round trip', () => {
    expect(passwordDraftProblem('short', 'short')).toMatch(/at least 8/)
    expect(passwordDraftProblem('long enough', 'long enougH')).toMatch(/differ/)
    expect(passwordDraftProblem('long enough', 'long enough')).toBeUndefined()
  })
})

describe('the desktop-confirm card', () => {
  it('counts down, and is empty once lapsed', () => {
    const ask = { id: 'a', name: 'Phone', expiresAt: NOW + 95_000 }
    expect(confirmLeft(ask, NOW)).toBe('1:35')
    expect(confirmLeft(ask, NOW + 95_000)).toBe('')
  })

  it('enables Allow only for something shaped like the six-digit code', () => {
    expect(confirmCodeReady('123456')).toBe(true)
    expect(confirmCodeReady('123 456')).toBe(true)
    expect(confirmCodeReady('123-456')).toBe(true)
    expect(confirmCodeReady('12345')).toBe(false)
    expect(confirmCodeReady('1234567')).toBe(false)
    expect(confirmCodeReady('12345a')).toBe(false)
    expect(confirmCodeReady('')).toBe(false)
  })
})

describe('devices and the chip', () => {
  it('words a last use', () => {
    expect(agoText(NOW - 5_000, NOW)).toBe('just now')
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe('5 min ago')
    expect(agoText(NOW - 3 * 3600_000, NOW)).toBe('3 h ago')
    expect(agoText(NOW - 5 * 86_400_000, NOW)).toBe('5 days ago')
    expect(agoText(NOW + 1000, NOW)).toBe('just now')
  })

  it('says how a device signed in and whether it is connected now', () => {
    const d = { id: 'a', name: 'Phone', createdAt: 0, lastSeenAt: NOW - 120_000, mode: 'add', connected: false }
    expect(deviceDetail(d, NOW)).toBe('one-time link, last used 2 min ago')
    expect(deviceDetail({ ...d, connected: true, mode: 'link' }, NOW)).toBe('access link, connected now')
    expect(deviceDetail({ ...d, mode: 'weird' }, NOW)).toContain('weird')
  })

  it('shows nothing with no device and no warning, a count with devices, and a label for a warning alone', () => {
    expect(indicatorText({ connected: 0 })).toBeUndefined()
    expect(indicatorText({ connected: 1 })).toBe('1 device')
    expect(indicatorText({ connected: 3 })).toBe('3 devices')
    expect(indicatorText({ connected: 0, warning: 'x' })).toBe('Web access')
    expect(indicatorText({ connected: 2, warning: 'x' })).toBe('2 devices')
  })

  it('puts the warning in the hover text', () => {
    expect(indicatorTitle({ connected: 1 })).toMatch(/^1 browser is connected/)
    expect(indicatorTitle({ connected: 2, warning: 'Sign-in is off.' })).toContain('Sign-in is off.')
    expect(indicatorTitle({ connected: 0 })).toMatch(/No browser/)
  })
})

describe('qrOf', () => {
  it('makes a square matrix as path data, and nothing for empty text', () => {
    const qr = qrOf(LINK)
    expect(qr).toBeDefined()
    // A ~70 character link fits version 5 at level M or smaller: at most 37 modules a side.
    expect(qr?.size).toBeGreaterThanOrEqual(21)
    expect(qr?.size).toBeLessThanOrEqual(45)
    expect(qr?.path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/)
    expect(qrOf('')).toBeUndefined()
  })

  it('is deterministic and differs for different text', () => {
    expect(qrOf(LINK)?.path).toBe(qrOf(LINK)?.path)
    expect(qrOf(LINK)?.path).not.toBe(qrOf(`${LINK}x`)?.path)
  })

  it('has the three finder patterns (their corners are dark)', () => {
    const qr = qrOf(LINK)
    if (!qr) throw new Error('no code')
    const dark = new Set(qr.path.match(/M\d+ \d+/g)?.map((m) => m.slice(1)))
    for (const [x, y] of [[0, 0], [qr.size - 1, 0], [0, qr.size - 1]]) expect(dark.has(`${x} ${y}`)).toBe(true)
  })

  it('gives up cleanly on text too long for any version', () => {
    expect(qrOf('x'.repeat(5000))).toBeUndefined()
  })
})
