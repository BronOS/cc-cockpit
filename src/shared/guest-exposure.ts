// What showing a plugin to guests exposes (design-guests §6, spec-review item 18): one generic text per guest
// role, for the Plugins page beside the "Shown to guests" switch, so the owner decides knowing what each guest
// gets. Built only from what the app knows for every plugin, `aware` and the port a role gets (`guestPort`);
// no manifest text in v1, and no line for any plugin id (a bundled plugin reads like any other: what is
// special about one goes in its own docs, D-34).
//
// Pure, renderer-safe: the page imports it with `PluginView.guestAccess` (shared/guest-access.ts).

import { guestPort, type GuestAccessResult } from './guest-access'

export interface GuestExposure {
  /** One line: whether guests can get the plugin at all. */
  summary: string
  /** What a read-only guest gets while the plugin is shown (the same text while it is hidden: what showing it would do). */
  read: string
  /** What a write guest gets while the plugin is shown. */
  write: string
}

const NOTHING = 'Nothing.'
const SETTINGS = 'Never its settings.'

/** The texts for one plugin row; `r` is its `PluginView.guestAccess`. */
export function guestExposure(r: Pick<GuestAccessResult, 'aware' | 'blocked'>): GuestExposure {
  if (r.blocked === 'all-windows') {
    return {
      summary: 'Never shown to guests: it sees the Claude tabs of every window, so its pages could show another project.',
      read: NOTHING,
      write: NOTHING
    }
  }
  // As if shown: the switch's text says what turning it on would give.
  const shown: GuestAccessResult = { effective: 'shown', source: 'default', aware: r.aware }
  const read =
    guestPort(shown, 'read') === 'full'
      ? `Sees its panels, slots and tabs; the plugin is told the viewer is a read-only guest and decides what they may do. ${SETTINGS}`
      : // One way: the page's messages never reach the plugin, its "hello" included, so only what the plugin sends
        // unasked shows (a page that asks for its state first stays empty); the text must not promise more.
        `Sees what the plugin pushes to its panels, slots and tabs; a page that asks for its state first shows nothing. What they click or type does not reach the plugin. ${SETTINGS}`
  const write = r.aware
    ? `Uses its panels, slots and tabs; the plugin is told the viewer is a guest and decides what they may do. ${SETTINGS}`
    : `Uses its panels, slots and tabs like you: anything they let you do, a write guest can do. ${SETTINGS}`
  return {
    summary: r.aware
      ? 'Checks who is looking: it can limit what guests see and do.'
      : 'Does not check who is looking: guests see what you see in its pages.',
    read,
    write
  }
}
