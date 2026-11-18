import { describe, expect, it } from 'vitest'
import {
  autoZoomed,
  cellEstimate,
  dragMinShare,
  edgePreview,
  edgeZone,
  equalizeSplits,
  FRAME_INSET_PX,
  frameBoxes,
  holdsCells,
  moveDivider,
  needsAutoZoom,
  nudgePane,
  PANE_CHROME,
  splitFits,
  successorInGroup,
  tookItsSpace,
  withSizes
} from '../../src/renderer/tabs/pane-layout'
import { GROUP_CAPS, type PaneNode, type PaneSplit, type TabGroup } from '../../src/shared/tab-groups'

const leaf = (tab: string): PaneNode => ({ tab })
const split = (id: string, dir: 'row' | 'column', children: PaneNode[], sizes?: number[]): PaneSplit => ({
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length)
})

// row[ A | column[ B / C ] ]
const tree = split('s1', 'row', [leaf('A'), split('s2', 'column', [leaf('B'), leaf('C')])])
const cell = { width: 8, height: 16 }

describe('pane-layout', () => {
  it('estimates a cell from the font', () => {
    expect(cellEstimate({ size: 10 })).toEqual({ width: 6, height: 12 })
    expect(cellEstimate({ size: 10, lineHeight: 1.5, letterSpacing: 1 })).toEqual({ width: 7, height: 18 })
    // Junk falls back to the default size rather than a zero cell.
    expect(cellEstimate({ size: Number.NaN }).width).toBeGreaterThan(0)
  })

  it('counts cells after the pane chrome', () => {
    // 20 cols need 160px + 18px padding + 14px xterm keeps for its scrollbar + 1px of rounding (qa
    // run 1 Q4: without them a pane ended at 19 columns); 5 rows need 80px + 16px padding + 1px
    // (+22 header).
    expect(holdsCells({ w: 193, h: 97 }, cell, { cols: 20, rows: 5 }, false)).toBe(true)
    expect(holdsCells({ w: 192.9, h: 97 }, cell, { cols: 20, rows: 5 }, false)).toBe(false)
    expect(holdsCells({ w: 193, h: 97 }, cell, { cols: 20, rows: 5 }, true)).toBe(false)
    expect(holdsCells({ w: 193, h: 119 }, cell, { cols: 20, rows: 5 }, true)).toBe(true)
  })

  it('auto-zooms a narrow view only (D5)', () => {
    // A: half the width; B and C: half of half the height.
    expect(needsAutoZoom(tree, { width: 1400, height: 800 }, cell)).toBe(false)
    // A phone: 400px wide gives A 200px, under 40 columns.
    expect(needsAutoZoom(tree, { width: 400, height: 800 }, cell)).toBe(true)
    // Short: B and C get 120px each, 5 rows with the header taken off: under 6.
    expect(needsAutoZoom(tree, { width: 1400, height: 240 }, cell)).toBe(true)
    // 150px each is 6 rows: shown side by side (it zoomed while the minimum was 10 rows).
    expect(needsAutoZoom(tree, { width: 1400, height: 300 }, cell)).toBe(false)
    // Not measured yet: nothing zooms.
    expect(needsAutoZoom(tree, { width: 0, height: 0 }, cell)).toBe(false)
  })

  it('auto-zooms for a narrow view, not for a divider dragged on a wide one', () => {
    // A pane dragged to 25% of 1400px (350px, ~41 cols) and B/C at 75%: fine at even shares.
    const dragged = split('s1', 'row', [leaf('A'), split('s2', 'column', [leaf('B'), leaf('C')])], [0.2, 0.8])
    expect(autoZoomed(dragged, { width: 1400, height: 800 }, cell)).toBe(false)
    // The same shares on a 700px screen: A gets 140px, under the 20-column minimum.
    expect(autoZoomed(dragged, { width: 700, height: 800 }, cell)).toBe(true)
    // A phone: too narrow even at even shares.
    expect(autoZoomed(tree, { width: 400, height: 800 }, cell)).toBe(true)
    expect(autoZoomed(tree, { width: 1400, height: 800 }, cell)).toBe(false)
  })

  it('refuses a split whose halves fall under 20x5 (D5)', () => {
    expect(splitFits({ w: 400, h: 300 }, 'right', cell)).toBe(true)
    expect(splitFits({ w: 300, h: 300 }, 'right', cell)).toBe(false)
    expect(splitFits({ w: 300, h: 300 }, 'down', cell)).toBe(true)
    expect(splitFits({ w: 300, h: 200 }, 'down', cell)).toBe(false)
  })

  it('finds the pane that took the space of a leaving one (D3)', () => {
    // C leaves: B takes the whole right column.
    const after = split('s1', 'row', [leaf('A'), leaf('B')])
    expect(tookItsSpace(tree, after, 'C')).toBe('B')
    // A leaves: the column takes its place; both overlap nothing of A's old rect, B is first.
    const afterA = split('s2', 'column', [leaf('B'), leaf('C')])
    expect(['B', 'C']).toContain(tookItsSpace(tree, afterA, 'A'))
    // A dissolved group: the one left.
    expect(tookItsSpace(split('s', 'row', [leaf('X'), leaf('Y')]), undefined, 'X', 'Y')).toBe('Y')
    expect(tookItsSpace(tree, after, 'nope')).toBeUndefined()
  })

  it('computes the successor from the page copy of the groups', () => {
    const groups: TabGroup[] = [{ id: 'g', root: tree }]
    expect(successorInGroup(groups, ['A', 'B', 'C', 'D'], 'C')).toBe('B')
    expect(successorInGroup(groups, ['A', 'B', 'C', 'D'], 'B')).toBe('C')
    // A plain tab has none: the strip's own rule applies.
    expect(successorInGroup(groups, ['A', 'B', 'C', 'D'], 'D')).toBeUndefined()
    const two: TabGroup[] = [{ id: 'g', root: split('s', 'row', [leaf('X'), leaf('Y')]) }]
    expect(successorInGroup(two, ['X', 'Y'], 'Y')).toBe('X')
  })

  it('moves a divider within the minimum share', () => {
    expect(moveDivider([0.5, 0.5], 0, 0.1, 0.1)).toEqual([0.6, 0.4])
    expect(moveDivider([0.5, 0.5], 0, 0.9, 0.1)).toEqual([0.9, 0.1].map((v) => expect.closeTo(v, 9)))
    expect(moveDivider([0.5, 0.5], 0, -0.9, 0.1)).toEqual([0.1, 0.9].map((v) => expect.closeTo(v, 9)))
    // The other children never change.
    expect(moveDivider([0.2, 0.3, 0.5], 1, 0.1, 0.1)).toEqual([0.2, expect.closeTo(0.4, 9), expect.closeTo(0.4, 9)])
    expect(moveDivider([0.5, 0.5], 3, 0.1, 0.1)).toEqual([0.5, 0.5])
  })

  it('nudges the focused pane along the nearest split of the axis', () => {
    // A grows right: the root row's divider.
    expect(nudgePane(tree, 'A', 'right', 0.05)).toEqual({ splitId: 's1', sizes: [expect.closeTo(0.55, 9), expect.closeTo(0.45, 9)] })
    // B down: the column's divider moves down.
    expect(nudgePane(tree, 'B', 'down', 0.05)).toEqual({ splitId: 's2', sizes: [expect.closeTo(0.55, 9), expect.closeTo(0.45, 9)] })
    // C has nothing below: its divider above moves down (C shrinks).
    expect(nudgePane(tree, 'C', 'down', 0.05)?.splitId).toBe('s2')
    // B right: no row divider after it in its column; the root row's divider before it moves right.
    expect(nudgePane(tree, 'B', 'right', 0.05)).toEqual({ splitId: 's1', sizes: [expect.closeTo(0.55, 9), expect.closeTo(0.45, 9)] })
    // At the limit: nothing.
    const edge = split('s', 'row', [leaf('X'), leaf('Y')], [0.9, 0.1])
    expect(nudgePane(edge, 'X', 'right', 0.05)).toBeUndefined()
    // A has no column split: up and down do nothing.
    expect(nudgePane(tree, 'A', 'up', 0.05)).toBeUndefined()
    expect(nudgePane(tree, 'zz', 'up', 0.05)).toBeUndefined()
  })

  it('equalizes only splits that are not even (D16)', () => {
    const uneven = split('s1', 'row', [leaf('A'), split('s2', 'column', [leaf('B'), leaf('C')], [0.7, 0.3])], [0.5, 0.5])
    expect(equalizeSplits(uneven)).toEqual([{ splitId: 's2', sizes: [0.5, 0.5] }])
    expect(equalizeSplits(tree)).toEqual([])
  })

  it('D26 N1: a pane dragged to the stop does not auto-zoom when both use the same cell', () => {
    // The reviewer's case: a measured row of 15px against a 16px estimate; and a narrow measured column.
    for (const c of [{ width: 7.8, height: 15 }, { width: 7.5, height: 16 }, { width: 7.796, height: 17 }]) {
      for (const dir of ['row', 'column'] as const) {
        const area = { width: 1400, height: 1000 }
        const share = dragMinShare(dir === 'row' ? area.width : area.height, dir, c)
        const root: PaneSplit = { id: 's', dir, children: [{ tab: 'a' }, { tab: 'b' }], sizes: [share, 1 - share] }
        expect(autoZoomed(root, area, c)).toBe(false)
      }
    }
  })

  it('keeps a dragged divider off the pane minimum', () => {
    // 20 cols of 8px + 18 padding + 14 scrollbar + 2 rounding = 194px of a 1000px split.
    expect(dragMinShare(1000, 'row', cell)).toBeCloseTo(0.194)
    // A pane at the stop holds the minimum (so it never auto-zooms), whatever the split's width.
    for (const px of [600, 842, 1000, 1913]) {
      const share = dragMinShare(px, 'row', { width: 7.796, height: 17 })
      expect(holdsCells({ w: share * px - 0.01, h: 400 }, { width: 7.796, height: 17 }, { cols: 20, rows: 5 }, true)).toBe(true)
    }
    // A wide split: main's 10% floor.
    expect(dragMinShare(4000, 'row', cell)).toBe(GROUP_CAPS.minShare)
    // Never more than half: two children always fit somewhere.
    expect(dragMinShare(100, 'column', cell)).toBe(0.5)
    expect(dragMinShare(0, 'row', cell)).toBe(GROUP_CAPS.minShare)
  })

  it('finds the edge zone of a drop point', () => {
    const pane = { x: 100, y: 100, w: 400, h: 200 }
    expect(edgeZone(pane, { x: 110, y: 200 })).toBe('left')
    expect(edgeZone(pane, { x: 490, y: 200 })).toBe('right')
    expect(edgeZone(pane, { x: 300, y: 105 })).toBe('up')
    expect(edgeZone(pane, { x: 300, y: 295 })).toBe('down')
    // The middle cancels, and so does outside.
    expect(edgeZone(pane, { x: 300, y: 200 })).toBeNull()
    expect(edgeZone(pane, { x: 50, y: 200 })).toBeNull()
    expect(edgeZone({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0 })).toBeNull()
    expect(edgePreview(pane, 'right')).toEqual({ x: 300, y: 100, w: 200, h: 200 })
    expect(edgePreview(pane, 'up')).toEqual({ x: 100, y: 100, w: 400, h: 100 })
  })
})

describe('frameBoxes: where page frames go (design-split-pages.md §2)', () => {
  const area = { width: 1000, height: 600 }
  const H = PANE_CHROME.header
  const I = FRAME_INSET_PX
  const pages = (...ids: string[]) => (id: string): boolean => ids.includes(id)
  const view = (visible: string[], isPage: (id: string) => boolean, zoomed = false) => ({ visible, zoomed, isPage })

  it('a two-pane row: the page pane only, below its header and inset on each side', () => {
    const root = split('r', 'row', [leaf('T'), leaf('P')])
    expect(frameBoxes(view(['T', 'P'], pages('P')), root, area, true)).toEqual([
      { tab: 'P', left: 500 + I, top: H + I, width: 500 - 2 * I, height: 600 - H - 2 * I }
    ])
  })

  it('a column and two page panes side by side', () => {
    const col = split('c', 'column', [leaf('P'), leaf('Q')])
    expect(frameBoxes(view(['P', 'Q'], pages('P', 'Q')), col, area, true)).toEqual([
      { tab: 'P', left: I, top: H + I, width: 1000 - 2 * I, height: 300 - H - 2 * I },
      { tab: 'Q', left: I, top: 300 + H + I, width: 1000 - 2 * I, height: 300 - H - 2 * I }
    ])
    const row = split('r', 'row', [leaf('P'), leaf('Q')])
    const [p, q] = frameBoxes(view(['P', 'Q'], pages('P', 'Q')), row, area, true)
    // Never overlapping, the dividers' grab zone left between them.
    expect(p!.left + p!.width).toBeLessThan(q!.left)
  })

  it('nested splits: each page pane at its own rect', () => {
    // row[ A | column[ B / C ] ], B and C pages
    const boxes = frameBoxes(view(['A', 'B', 'C'], pages('B', 'C')), tree, area, true)
    expect(boxes.map((b) => b.tab)).toEqual(['B', 'C'])
    expect(boxes[0]).toEqual({ tab: 'B', left: 500 + I, top: H + I, width: 500 - 2 * I, height: 300 - H - 2 * I })
    expect(boxes[1]!.top).toBe(300 + H + I)
  })

  it('a plain or zoomed page tab gets the whole area: no header, no inset', () => {
    const whole = [{ tab: 'P', left: 0, top: 0, width: 1000, height: 600 }]
    expect(frameBoxes(view(['P'], pages('P')), undefined, area, false)).toEqual(whole)
    // Zoomed by the person or by D5 (PaneView.visible holds the zoomed pane alone).
    const root = split('r', 'row', [leaf('T'), leaf('P')])
    expect(frameBoxes(view(['P'], pages('P'), true), root, area, false)).toEqual(whole)
  })

  it("a live divider drag's sizes move the frame", () => {
    const root = split('r', 'row', [leaf('T'), leaf('P')])
    const dragged = withSizes(root, 'r', [0.3, 0.7])
    expect(frameBoxes(view(['T', 'P'], pages('P')), dragged, area, true)[0]).toMatchObject({ left: 300 + I, width: 700 - 2 * I })
  })

  it('terminal panes and an area not measured yet yield nothing; edges are whole pixels', () => {
    const root = split('r', 'row', [leaf('T'), leaf('U')])
    expect(frameBoxes(view(['T', 'U'], pages()), root, area, true)).toEqual([])
    expect(frameBoxes(view(['P'], pages('P')), undefined, { width: 0, height: 0 }, false)).toEqual([])
    const three = split('r', 'row', [leaf('A'), leaf('P'), leaf('B')])
    const [p] = frameBoxes(view(['A', 'P', 'B'], pages('P')), three, { width: 1001, height: 601 }, true)
    for (const v of [p!.left, p!.top, p!.width, p!.height]) expect(Number.isInteger(v)).toBe(true)
  })
})
