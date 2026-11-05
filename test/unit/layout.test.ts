import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_SIZE,
  DEFAULT_ZONE_SIZE,
  MAX_REMEMBERED,
  MAX_SIZE,
  MIN_SIZE,
  RENAMED_PANEL_KEYS,
  defaultLayout,
  hidePanel,
  movePanel,
  normalizeLayout,
  reconcile,
  resizePanel,
  resizeZone,
  setZoneCollapsed,
  togglePanel,
  unhidePanel,
  zoneOf,
  type AvailablePanel,
  type LayoutState,
  type ZoneId
} from '../../src/shared/layout'

const SESSIONS: AvailablePanel = { panelKey: 'test/sessions', defaultZone: 'left', defaultOpen: true }
const BOARD: AvailablePanel = { panelKey: 'jira/board', defaultZone: 'left' }
const LOG: AvailablePanel = { panelKey: 'jira/log', defaultZone: 'bottom' }

const keys = (l: LayoutState, zone: ZoneId): string[] => l.zones[zone].panels.map((p) => p.panelKey)
const panel = (l: LayoutState, key: string) =>
  l.zones[zoneOf(l, key)!].panels.find((p) => p.panelKey === key)!

describe('reconcile', () => {
  it('puts new panels in their default zone, in available order, with default open and size', () => {
    const l = reconcile(defaultLayout(), [SESSIONS, BOARD, LOG])
    expect(keys(l, 'left')).toEqual(['test/sessions', 'jira/board'])
    expect(keys(l, 'bottom')).toEqual(['jira/log'])
    expect(panel(l, 'test/sessions')).toEqual({
      panelKey: 'test/sessions',
      open: true,
      size: DEFAULT_PANEL_SIZE
    })
    expect(panel(l, 'jira/board').open).toBe(false)
  })

  it('returns the same object when nothing changes', () => {
    const l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    expect(reconcile(l, [SESSIONS, BOARD])).toBe(l)
  })

  it('keeps existing placement and order, appending a newly available panel', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = movePanel(l, 'test/sessions', 'right')
    l = reconcile(l, [SESSIONS, BOARD, LOG])
    expect(keys(l, 'right')).toEqual(['test/sessions'])
    expect(keys(l, 'left')).toEqual(['jira/board'])
    expect(keys(l, 'bottom')).toEqual(['jira/log'])
  })

  it('ignores a panel listed twice in available', () => {
    const l = reconcile(defaultLayout(), [BOARD, { ...BOARD, defaultZone: 'right' }])
    expect(keys(l, 'left')).toEqual(['jira/board'])
    expect(keys(l, 'right')).toEqual([])
  })

  it('drops panels that are no longer available and remembers their placement', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = movePanel(togglePanel(l, 'jira/board'), 'jira/board', 'bottom')
    l = resizePanel(l, 'jira/board', 333)
    const dropped = reconcile(l, [SESSIONS])
    expect(zoneOf(dropped, 'jira/board')).toBeUndefined()
    expect(dropped.remembered['jira/board']).toEqual({
      zone: 'bottom',
      open: true,
      size: 333,
      hidden: false
    })
    expect(keys(dropped, 'left')).toEqual(['test/sessions'])
  })

  it('restores the remembered zone, open state and size when the plugin is enabled again', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = movePanel(togglePanel(l, 'jira/board'), 'jira/board', 'bottom')
    l = resizePanel(l, 'jira/board', 333)
    const disabled = reconcile(l, [SESSIONS])
    const enabled = reconcile(disabled, [SESSIONS, BOARD])
    expect(keys(enabled, 'bottom')).toEqual(['jira/board'])
    expect(panel(enabled, 'jira/board')).toEqual({ panelKey: 'jira/board', open: true, size: 333 })
    expect(enabled.remembered).toEqual({})
  })

  it('restores a panel that was hidden before the plugin was disabled as hidden', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = movePanel(l, 'jira/board', 'right')
    l = hidePanel(l, 'jira/board')
    const disabled = reconcile(l, [SESSIONS])
    expect(disabled.hidden).toEqual([])
    const enabled = reconcile(disabled, [SESSIONS, BOARD])
    expect(enabled.hidden).toEqual(['jira/board'])
    expect(zoneOf(enabled, 'jira/board')).toBeUndefined()
    // and unhiding still lands in the zone it was hidden from
    expect(keys(unhidePanel(enabled, 'jira/board'), 'right')).toEqual(['jira/board'])
  })

  it('survives a persist and reload between disable and enable', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = hidePanel(movePanel(l, 'jira/board', 'right'), 'jira/board')
    const disabled = normalizeLayout(JSON.parse(JSON.stringify(reconcile(l, [SESSIONS]))))
    const enabled = reconcile(disabled, [SESSIONS, BOARD])
    expect(enabled.hidden).toEqual(['jira/board'])
  })

  it('keeps a hidden panel hidden while it stays available', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = hidePanel(l, 'jira/board')
    expect(reconcile(l, [SESSIONS, BOARD])).toBe(l)
  })

  it('does not re-place a hidden panel that is available', () => {
    const l = hidePanel(reconcile(defaultLayout(), [BOARD]), 'jira/board')
    const again = reconcile(l, [BOARD, LOG])
    expect(again.hidden).toEqual(['jira/board'])
    expect(keys(again, 'left')).toEqual([])
  })

  it('caps the remembered map, dropping the oldest non-hidden entries', () => {
    const many: AvailablePanel[] = Array.from({ length: MAX_REMEMBERED + 20 }, (_, i) => ({
      panelKey: `p/${i}`,
      defaultZone: 'left'
    }))
    const l = reconcile(defaultLayout(), many)
    const dropped = reconcile(l, [])
    expect(Object.keys(dropped.remembered)).toHaveLength(MAX_REMEMBERED)
    expect(dropped.remembered['p/0']).toBeUndefined()
    expect(dropped.remembered[`p/${MAX_REMEMBERED + 19}`]).toBeDefined()
  })

  it('caps hidden entries of dropped panels but keeps those still in hidden', () => {
    const many: AvailablePanel[] = Array.from({ length: MAX_REMEMBERED + 20 }, (_, i) => ({
      panelKey: `p/${i}`,
      defaultZone: 'left'
    }))
    let l = reconcile(defaultLayout(), many)
    for (const a of many) l = hidePanel(l, a.panelKey)
    const gone = reconcile(l, [])
    expect(Object.keys(gone.remembered).length).toBeLessThanOrEqual(MAX_REMEMBERED)
    // Panels still in `hidden` keep their entry even past the cap (unhide needs the zone).
    expect(Object.keys(l.remembered)).toHaveLength(MAX_REMEMBERED + 20)
  })

  it('falls back to the left zone for an invalid defaultZone', () => {
    const bad = { panelKey: 'x/y', defaultZone: 'nope' } as unknown as AvailablePanel
    expect(keys(reconcile(defaultLayout(), [bad]), 'left')).toEqual(['x/y'])
  })
})

describe('togglePanel', () => {
  it('opens a closed panel and closes an open one', () => {
    let l = reconcile(defaultLayout(), [BOARD])
    l = togglePanel(l, 'jira/board')
    expect(panel(l, 'jira/board').open).toBe(true)
    l = togglePanel(l, 'jira/board')
    expect(panel(l, 'jira/board').open).toBe(false)
  })

  it('expands a collapsed zone when opening, leaves it collapsed when closing', () => {
    let l = reconcile(defaultLayout(), [SESSIONS])
    l = setZoneCollapsed(l, 'left', true)
    l = togglePanel(l, 'test/sessions') // open -> closed
    expect(l.zones.left.collapsed).toBe(true)
    l = togglePanel(l, 'test/sessions') // closed -> open
    expect(l.zones.left.collapsed).toBe(false)
    expect(panel(l, 'test/sessions').open).toBe(true)
  })

  it('only touches the named panel', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = togglePanel(l, 'jira/board')
    expect(panel(l, 'test/sessions').open).toBe(true)
  })

  it('ignores unknown and hidden panels', () => {
    const l = hidePanel(reconcile(defaultLayout(), [BOARD]), 'jira/board')
    expect(togglePanel(l, 'jira/board')).toBe(l)
    expect(togglePanel(l, 'nope/x')).toBe(l)
  })
})

describe('movePanel', () => {
  it('moves to the end of the target zone and keeps open state and size', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD, LOG])
    l = resizePanel(l, 'test/sessions', 400)
    l = movePanel(l, 'test/sessions', 'bottom')
    expect(keys(l, 'left')).toEqual(['jira/board'])
    expect(keys(l, 'bottom')).toEqual(['jira/log', 'test/sessions'])
    expect(panel(l, 'test/sessions')).toEqual({ panelKey: 'test/sessions', open: true, size: 400 })
  })

  it('moving within the same zone sends the panel to the end', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = movePanel(l, 'test/sessions', 'left')
    expect(keys(l, 'left')).toEqual(['jira/board', 'test/sessions'])
  })

  it('unhides a hidden panel, using its remembered open state and size', () => {
    let l = reconcile(defaultLayout(), [SESSIONS])
    l = hidePanel(resizePanel(l, 'test/sessions', 500), 'test/sessions')
    l = movePanel(l, 'test/sessions', 'right')
    expect(l.hidden).toEqual([])
    expect(l.remembered).toEqual({})
    expect(panel(l, 'test/sessions')).toEqual({ panelKey: 'test/sessions', open: true, size: 500 })
    expect(zoneOf(l, 'test/sessions')).toBe('right')
  })

  it('ignores an unknown panel or zone', () => {
    const l = reconcile(defaultLayout(), [SESSIONS])
    expect(movePanel(l, 'nope/x', 'right')).toBe(l)
    expect(movePanel(l, 'test/sessions', 'top' as ZoneId)).toBe(l)
  })

  it('does not mutate its input', () => {
    const l = reconcile(defaultLayout(), [SESSIONS])
    const before = JSON.stringify(l)
    movePanel(l, 'test/sessions', 'right')
    expect(JSON.stringify(l)).toBe(before)
  })
})

describe('hidePanel / unhidePanel', () => {
  it('hides a panel out of its zone and remembers where it was', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = hidePanel(l, 'jira/board')
    expect(keys(l, 'left')).toEqual(['test/sessions'])
    expect(l.hidden).toEqual(['jira/board'])
    expect(l.remembered['jira/board']).toMatchObject({ zone: 'left', hidden: true })
  })

  it('unhide returns the panel to its old zone with open state and size', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, LOG])
    l = movePanel(togglePanel(l, 'jira/log'), 'jira/log', 'right')
    l = resizePanel(l, 'jira/log', 210)
    l = unhidePanel(hidePanel(l, 'jira/log'), 'jira/log')
    expect(l.hidden).toEqual([])
    expect(l.remembered).toEqual({})
    expect(panel(l, 'jira/log')).toEqual({ panelKey: 'jira/log', open: true, size: 210 })
    expect(zoneOf(l, 'jira/log')).toBe('right')
  })

  it('unhide expands a collapsed zone for an open panel but not for a closed one', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = setZoneCollapsed(hidePanel(hidePanel(l, 'test/sessions'), 'jira/board'), 'left', true)
    expect(unhidePanel(l, 'test/sessions').zones.left.collapsed).toBe(false) // was open
    expect(unhidePanel(l, 'jira/board').zones.left.collapsed).toBe(true) // was closed
  })

  it('unhide uses the fallback zone when nothing was remembered', () => {
    const l = unhidePanel({ ...defaultLayout(), hidden: ['jira/board'] }, 'jira/board', 'bottom')
    expect(keys(l, 'bottom')).toEqual(['jira/board'])
    expect(panel(l, 'jira/board')).toEqual({
      panelKey: 'jira/board',
      open: false,
      size: DEFAULT_PANEL_SIZE
    })
  })

  it('ignores hiding an unknown or already hidden panel and unhiding a visible one', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    expect(hidePanel(l, 'nope/x')).toBe(l)
    expect(unhidePanel(l, 'test/sessions')).toBe(l)
    l = hidePanel(l, 'jira/board')
    expect(hidePanel(l, 'jira/board')).toBe(l)
  })
})

describe('resize', () => {
  it('sets a panel size and clamps it', () => {
    let l = reconcile(defaultLayout(), [SESSIONS])
    l = resizePanel(l, 'test/sessions', 123.6)
    expect(panel(l, 'test/sessions').size).toBe(124)
    expect(panel(resizePanel(l, 'test/sessions', 1), 'test/sessions').size).toBe(MIN_SIZE)
    expect(panel(resizePanel(l, 'test/sessions', 1e9), 'test/sessions').size).toBe(MAX_SIZE)
  })

  it('sets a zone size and clamps it', () => {
    let l = resizeZone(defaultLayout(), 'right', 410)
    expect(l.zones.right.size).toBe(410)
    expect(l.zones.left.size).toBe(DEFAULT_ZONE_SIZE.left)
    l = resizeZone(l, 'right', -5)
    expect(l.zones.right.size).toBe(MIN_SIZE)
  })

  it('ignores NaN, Infinity, unknown panels and zones', () => {
    const l = reconcile(defaultLayout(), [SESSIONS])
    expect(resizePanel(l, 'test/sessions', NaN)).toBe(l)
    expect(resizePanel(l, 'test/sessions', Infinity)).toBe(l)
    expect(resizePanel(l, 'nope/x', 100)).toBe(l)
    expect(resizeZone(l, 'left', NaN)).toBe(l)
    expect(resizeZone(l, 'top' as ZoneId, 100)).toBe(l)
  })

  it('does not change other panels', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD])
    l = resizePanel(l, 'jira/board', 300)
    expect(panel(l, 'test/sessions').size).toBe(DEFAULT_PANEL_SIZE)
  })
})

describe('setZoneCollapsed', () => {
  it('flips when no value is given and sets explicitly otherwise', () => {
    let l = setZoneCollapsed(defaultLayout(), 'bottom')
    expect(l.zones.bottom.collapsed).toBe(true)
    l = setZoneCollapsed(l, 'bottom')
    expect(l.zones.bottom.collapsed).toBe(false)
    l = setZoneCollapsed(l, 'bottom', false)
    expect(l.zones.bottom.collapsed).toBe(false)
    expect(setZoneCollapsed(l, 'bottom', false)).toBe(l)
  })

  it('keeps the open state of the panels inside', () => {
    let l = reconcile(defaultLayout(), [SESSIONS])
    l = setZoneCollapsed(l, 'left', true)
    expect(panel(l, 'test/sessions').open).toBe(true)
  })

  it('leaves the other zones alone and ignores an unknown zone', () => {
    const l = setZoneCollapsed(defaultLayout(), 'left', true)
    expect(l.zones.right.collapsed).toBe(false)
    expect(setZoneCollapsed(l, 'top' as ZoneId, true)).toBe(l)
  })
})

describe('normalizeLayout', () => {
  it('gives the default layout for the old placeholder {} and for junk', () => {
    expect(normalizeLayout({})).toEqual(defaultLayout())
    expect(normalizeLayout(null)).toEqual(defaultLayout())
    expect(normalizeLayout('x')).toEqual(defaultLayout())
    expect(normalizeLayout([])).toEqual(defaultLayout())
  })

  it('round-trips a valid layout through JSON', () => {
    let l = reconcile(defaultLayout(), [SESSIONS, BOARD, LOG])
    l = hidePanel(movePanel(togglePanel(l, 'jira/board'), 'jira/board', 'right'), 'jira/log')
    l = resizeZone(setZoneCollapsed(l, 'right', true), 'left', 300)
    expect(normalizeLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
  })

  it('drops malformed panels and clamps sizes', () => {
    const l = normalizeLayout({
      zones: {
        left: {
          collapsed: 'yes',
          size: 1e9,
          panels: [
            { panelKey: 'ok/one', open: true, size: 'big' },
            { panelKey: 42 },
            { panelKey: 'no-slash' },
            null,
            { panelKey: 'ok/two', open: 1, size: 5 }
          ]
        },
        right: 'nope'
      },
      hidden: ['ok/three', 7]
    })
    expect(l.zones.left.collapsed).toBe(false)
    expect(l.zones.left.size).toBe(MAX_SIZE)
    expect(l.zones.left.panels).toEqual([
      { panelKey: 'ok/one', open: true, size: DEFAULT_PANEL_SIZE },
      { panelKey: 'ok/two', open: false, size: MIN_SIZE }
    ])
    expect(l.zones.right).toEqual(defaultLayout().zones.right)
    expect(l.hidden).toEqual(['ok/three'])
  })

  it('keeps a panel listed in two places only in the first', () => {
    const l = normalizeLayout({
      zones: {
        left: { panels: [{ panelKey: 'a/b', open: true, size: 100 }] },
        right: { panels: [{ panelKey: 'a/b', open: false, size: 200 }] }
      },
      hidden: ['a/b', 'c/d', 'c/d']
    })
    expect(zoneOf(l, 'a/b')).toBe('left')
    expect(keys(l, 'right')).toEqual([])
    expect(l.hidden).toEqual(['c/d'])
  })

  it('drops remembered entries for panels that are placed and bad zones', () => {
    const l = normalizeLayout({
      zones: { left: { panels: [{ panelKey: 'a/b', open: true, size: 100 }] } },
      remembered: {
        'a/b': { zone: 'left', open: true, size: 100 },
        'c/d': { zone: 'top', open: true, size: 100 },
        'e/f': { zone: 'bottom', open: true, size: 100, hidden: true },
        'g/h': 5
      }
    })
    expect(Object.keys(l.remembered)).toEqual(['e/f'])
    expect(l.remembered['e/f']).toEqual({ zone: 'bottom', open: true, size: 100, hidden: true })
  })
})

describe('renamed panel keys (the core Sessions panel became cockpit.sessions/sessions)', () => {
  const OLD = 'core/sessions'
  const NEW = 'cockpit.sessions/sessions'

  it('maps the old core key to the bundled plugin\'s panel', () => {
    expect(RENAMED_PANEL_KEYS[OLD]).toBe(NEW)
  })

  it('keeps the zone, the order, the open state and the size', () => {
    const l = normalizeLayout({
      zones: {
        right: {
          collapsed: false,
          size: 330,
          panels: [
            { panelKey: 'jira/board', open: false, size: 200 },
            { panelKey: OLD, open: true, size: 310 },
            { panelKey: 'jira/log', open: false, size: 100 }
          ]
        }
      }
    })
    expect(keys(l, 'right')).toEqual(['jira/board', NEW, 'jira/log'])
    expect(panel(l, NEW)).toEqual({ panelKey: NEW, open: true, size: 310 })
    expect(JSON.stringify(l)).not.toContain(OLD)
    // Idempotent: the next read of what was stored is the same.
    expect(normalizeLayout(JSON.parse(JSON.stringify(l)))).toEqual(l)
  })

  it('renames a hidden one (still hidden) and a remembered one (its placement kept)', () => {
    const hidden = normalizeLayout({
      hidden: [OLD],
      remembered: { [OLD]: { zone: 'bottom', open: true, size: 150, hidden: true } }
    })
    expect(hidden.hidden).toEqual([NEW])
    expect(hidden.remembered).toEqual({ [NEW]: { zone: 'bottom', open: true, size: 150, hidden: true } })
    const remembered = normalizeLayout({ remembered: { [OLD]: { zone: 'left', open: false, size: 90 } } })
    expect(remembered.remembered).toEqual({ [NEW]: { zone: 'left', open: false, size: 90, hidden: false } })
  })

  it('drops the old entry when the layout already has the plugin\'s panel anywhere', () => {
    const placed = normalizeLayout({
      zones: {
        left: { collapsed: false, size: 280, panels: [{ panelKey: NEW, open: false, size: 240 }] },
        right: { collapsed: false, size: 320, panels: [{ panelKey: OLD, open: true, size: 300 }] }
      }
    })
    expect(keys(placed, 'left')).toEqual([NEW])
    expect(keys(placed, 'right')).toEqual([])
    expect(panel(placed, NEW).open).toBe(false)
    const hidden = normalizeLayout({
      zones: { right: { collapsed: false, size: 320, panels: [{ panelKey: OLD, open: true, size: 300 }] } },
      hidden: [NEW]
    })
    expect(keys(hidden, 'right')).toEqual([])
    expect(hidden.hidden).toEqual([NEW])
    const remembered = normalizeLayout({
      hidden: [OLD],
      remembered: { [NEW]: { zone: 'left', open: false, size: 90 } }
    })
    expect(remembered.hidden).toEqual([])
    expect(remembered.remembered).toEqual({ [NEW]: { zone: 'left', open: false, size: 90, hidden: false } })
  })

  it('reconciles the renamed panel into its stored place once the plugin declares it', () => {
    const stored = normalizeLayout({
      zones: { right: { collapsed: false, size: 320, panels: [{ panelKey: OLD, open: true, size: 260 }] } }
    })
    // The plugin's manifest says left; the person's place (right) wins.
    const l = reconcile(stored, [{ panelKey: NEW, defaultZone: 'left' }])
    expect(keys(l, 'right')).toEqual([NEW])
    expect(panel(l, NEW)).toEqual({ panelKey: NEW, open: true, size: 260 })
  })
})
