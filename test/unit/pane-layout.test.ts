import { describe, expect, it } from 'vitest'
import {
  cellEstimate,
  dragMinShare,
  edgePreview,
  edgeZone,
  equalizeSplits,
  holdsCells,
  moveDivider,
  needsAutoZoom,
  nudgePane,
  splitFits,
  successorInGroup,
  tookItsSpace
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
    // 20 cols need 160px + 18px padding; 5 rows need 80px + 16px padding (+22 header).
    expect(holdsCells({ w: 178, h: 96 }, cell, { cols: 20, rows: 5 }, false)).toBe(true)
    expect(holdsCells({ w: 177, h: 96 }, cell, { cols: 20, rows: 5 }, false)).toBe(false)
    expect(holdsCells({ w: 178, h: 96 }, cell, { cols: 20, rows: 5 }, true)).toBe(false)
    expect(holdsCells({ w: 178, h: 118 }, cell, { cols: 20, rows: 5 }, true)).toBe(true)
  })

  it('auto-zooms a narrow view only (D5)', () => {
    // A: half the width; B and C: half of half the height.
    expect(needsAutoZoom(tree, { width: 1400, height: 800 }, cell)).toBe(false)
    // A phone: 400px wide gives A 200px, under 40 columns.
    expect(needsAutoZoom(tree, { width: 400, height: 800 }, cell)).toBe(true)
    // Short: B and C get 150px each, under 10 rows with the header.
    expect(needsAutoZoom(tree, { width: 1400, height: 300 }, cell)).toBe(true)
    // Not measured yet: nothing zooms.
    expect(needsAutoZoom(tree, { width: 0, height: 0 }, cell)).toBe(false)
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

  it('keeps a dragged divider off the pane minimum', () => {
    // 20 cols of 8px + 18 padding = 178px of a 1000px split.
    expect(dragMinShare(1000, 'row', cell)).toBeCloseTo(0.178)
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
