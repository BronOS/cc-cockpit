// The Plugins page's and This Project's guest visibility control (design-guests §6, §16.1, D-11,
// spec-review 18): absent read as hidden, the app control reads the app value, a widening decided from
// the value left in force, and the three outcomes by shell (desktop at once, server browser confirm,
// desktop host's browser refused). Hints only: main applies its own rule.
import { describe, expect, it } from 'vitest'
import {
  appGuestValue,
  canShowToGuests,
  GUEST_BLOCKED_TEXT,
  globalGuestLabel,
  guestAccessOf,
  guestChange,
  guestEffectiveText,
  guestExposureLines,
  guestWindowLines,
  guestExposureText,
  guestOverrideNote,
  guestShowAskText,
  isGuestWidening,
  projectGuestChoice,
  projectGuestValue,
  projectOverrideStart,
  type GuestShell,
  type PluginGuestAccess
} from '../../src/renderer/settings/guest-visibility-model'
import { guestExposure } from '../../src/shared/guest-exposure'

const DESKTOP: GuestShell = { webShell: false, serverView: false }
const SERVER: GuestShell = { webShell: true, serverView: true }
const BROWSER: GuestShell = { webShell: true, serverView: false }

function access(over: Partial<PluginGuestAccess> = {}): PluginGuestAccess {
  return { effective: 'hidden', source: 'default', aware: false, ...over }
}

const AWARE_E = guestExposure({ aware: true })
const NOT_AWARE_E = guestExposure({ aware: false })
const AWARE = `${AWARE_E.summary} Read-only guests: ${AWARE_E.read} Write guests: ${AWARE_E.write}`
const NOT_AWARE = `${NOT_AWARE_E.summary} Read-only guests: ${NOT_AWARE_E.read} Write guests: ${NOT_AWARE_E.write}`

describe('guestAccessOf', () => {
  it('reads an absent field as hidden by default, not aware', () => {
    expect(guestAccessOf({})).toEqual({ effective: 'hidden', source: 'default', aware: false })
  })
  it('passes main’s value through', () => {
    const a = access({ effective: 'shown', source: 'app', appValue: 'shown', aware: true })
    expect(guestAccessOf({ guestAccess: a })).toBe(a)
  })
})

describe('texts', () => {
  it('names what showing exposes with the shared generic text (no manifest text)', () => {
    expect(guestExposureText({ aware: true })).toBe(AWARE)
    expect(guestExposureText({ aware: false })).toBe(NOT_AWARE)
    expect(guestExposureText({ aware: false, blocked: 'all-windows' })).toBe(GUEST_BLOCKED_TEXT)
  })
  it('the card lines: blocked reason alone, summary and a line per role, "If shown" while hidden', () => {
    expect(guestExposureLines(access({ blocked: 'all-windows', appValue: 'shown' }))).toEqual([GUEST_BLOCKED_TEXT])
    expect(GUEST_BLOCKED_TEXT).toBe(guestExposure({ aware: false, blocked: 'all-windows' }).summary)
    expect(guestExposureLines(access({ appValue: 'shown', effective: 'shown', source: 'app', aware: true }))).toEqual([
      AWARE_E.summary,
      `Read-only guests: ${AWARE_E.read}`,
      `Write guests: ${AWARE_E.write}`
    ])
    expect(guestExposureLines(access())[0]).toBe(`If shown: ${NOT_AWARE_E.summary}`)
  })
  it('names a project override under the app control, never for a blocked plugin', () => {
    expect(guestOverrideNote(access({ source: 'app', appValue: 'shown', effective: 'shown' }))).toBeUndefined()
    expect(guestOverrideNote(access({ source: 'project', projectValue: 'shown', effective: 'shown' }))).toBe(
      'This project overrides it: shown to its guests (This Project).'
    )
    expect(guestOverrideNote(access({ source: 'project', projectValue: 'shown', blocked: 'all-windows' }))).toBeUndefined()
  })
  it('This Project says what is in force here and where it comes from', () => {
    expect(guestEffectiveText(access())).toBe('Guests here: hidden (the default).')
    expect(guestEffectiveText(access({ effective: 'shown', source: 'app', appValue: 'shown' }))).toBe('Guests here: shown (the global value).')
    expect(guestEffectiveText(access({ effective: 'hidden', source: 'project', projectValue: 'hidden', appValue: 'shown' }))).toBe(
      'Guests here: hidden (set for this project).'
    )
    expect(guestEffectiveText(access({ blocked: 'all-windows', source: 'project', projectValue: 'shown' }))).toBe(GUEST_BLOCKED_TEXT)
    expect(globalGuestLabel(access({ appValue: 'shown' }))).toBe('Use global (shown)')
    expect(globalGuestLabel(access())).toBe('Use global (hidden)')
  })
  it('the confirm says what showing exposes and how far it reaches', () => {
    const app = guestShowAskText('Team', access({ aware: true }), 'app')
    expect(app.title).toBe('Show Team to guests?')
    expect(app.body.startsWith(AWARE)).toBe(true)
    expect(app.body).toContain("Every project's guests")
    expect(app.allowLabel).toBe('Show to guests')
    expect(guestShowAskText('Team', access(), 'project').body).toBe(`${NOT_AWARE} This project's guests get it.`)
  })
})

describe('the app control', () => {
  it('shows the app value, not the effective one a project override may set', () => {
    expect(appGuestValue(access({ effective: 'shown', source: 'project', projectValue: 'shown' }))).toBe('hidden')
    expect(appGuestValue(access({ effective: 'hidden', source: 'project', projectValue: 'hidden', appValue: 'shown' }))).toBe('shown')
  })
})

describe('isGuestWidening', () => {
  it('app-wide: Shown widens (every other project), Hidden narrows', () => {
    expect(isGuestWidening(access(), 'app', 'shown')).toBe(true)
    // Even where this project hides it: other projects' guests get it.
    expect(isGuestWidening(access({ projectValue: 'hidden', source: 'project' }), 'app', 'shown')).toBe(true)
    expect(isGuestWidening(access({ appValue: 'shown' }), 'app', 'hidden')).toBe(false)
  })
  it('project: decided by the value left in force, so Use global over a global Shown widens', () => {
    expect(isGuestWidening(access(), 'project', 'shown')).toBe(true)
    expect(isGuestWidening(access({ appValue: 'shown' }), 'project', null)).toBe(true)
    expect(isGuestWidening(access({ appValue: 'hidden' }), 'project', null)).toBe(false)
    expect(isGuestWidening(access(), 'project', null)).toBe(false)
    expect(isGuestWidening(access({ appValue: 'shown' }), 'project', 'hidden')).toBe(false)
  })
})

describe('guestChange', () => {
  it('a narrowing is direct in every shell', () => {
    for (const shell of [DESKTOP, SERVER, BROWSER]) {
      expect(guestChange(access({ appValue: 'shown' }), 'app', 'hidden', shell)).toBe('direct')
      expect(guestChange(access(), 'project', null, shell)).toBe('direct')
    }
  })
  it('a widening: desktop at once, a server browser behind the confirm (D-11), a desktop host’s browser refused', () => {
    expect(guestChange(access(), 'app', 'shown', DESKTOP)).toBe('direct')
    expect(guestChange(access(), 'app', 'shown', SERVER)).toBe('confirm')
    expect(guestChange(access(), 'app', 'shown', BROWSER)).toBe('refused')
    expect(guestChange(access({ appValue: 'shown' }), 'project', null, SERVER)).toBe('confirm')
    expect(guestChange(access({ appValue: 'shown' }), 'project', null, BROWSER)).toBe('refused')
  })
  it('bundled plugins are no special case: the rule takes no id', () => {
    expect(guestChange(access({ aware: true }), 'app', 'shown', SERVER)).toBe('confirm')
  })
  it('Shown is offered on the desktop and in a server browser only', () => {
    expect(canShowToGuests(DESKTOP)).toBe(true)
    expect(canShowToGuests(SERVER)).toBe(true)
    expect(canShowToGuests(BROWSER)).toBe(false)
  })
})

describe('This Project choice', () => {
  it('reads an absent project value as Use global and sends null for it', () => {
    expect(projectGuestChoice(access())).toBe('global')
    expect(projectGuestChoice(access({ projectValue: 'shown' }))).toBe('shown')
    expect(projectGuestValue('global')).toBeNull()
    expect(projectGuestValue('hidden')).toBe('hidden')
    expect(projectGuestValue('shown')).toBe('shown')
  })
  it('unchecking Use global stores the global value, or Hidden where Shown would be refused', () => {
    expect(projectOverrideStart(access({ appValue: 'shown' }), DESKTOP)).toBe('shown')
    expect(projectOverrideStart(access({ appValue: 'shown' }), SERVER)).toBe('shown')
    expect(projectOverrideStart(access({ appValue: 'shown' }), BROWSER)).toBe('hidden')
    expect(projectOverrideStart(access(), BROWSER)).toBe('hidden')
    expect(projectOverrideStart(access(), DESKTOP)).toBe('hidden')
  })
})

describe('guestWindowLines', () => {
  const shown = access({ appValue: 'shown', effective: 'shown', source: 'app', aware: true })
  it('a perView plugin: its windows show on guests', () => {
    expect(guestWindowLines({ guestAccess: shown, overlaysPerView: true })).toEqual(["Its windows show on guests' screens too."])
  })
  it('a plugin without it: its windows stay on the owner, guests see a note', () => {
    expect(guestWindowLines({ guestAccess: shown })).toEqual(['Its windows stay on your screen; guests see a note.'])
  })
  it('perView and a service: the D-4 line too', () => {
    expect(guestWindowLines({ guestAccess: shown, overlaysPerView: true, providesServices: true })).toEqual([
      "Its windows show on guests' screens too.",
      'What another plugin opens in it reaches guests only when that plugin is shown too; data it fetches itself is shown as its own.'
    ])
  })
  it('not shown to guests, or blocked: no line', () => {
    expect(guestWindowLines({ guestAccess: access(), overlaysPerView: true })).toEqual([])
    expect(guestWindowLines({ overlaysPerView: true })).toEqual([])
    expect(guestWindowLines({ guestAccess: access({ ...shown, blocked: 'all-windows' }), overlaysPerView: true })).toEqual([])
  })
})
