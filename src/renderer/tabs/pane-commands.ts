// The split view's commands (D10 chords and the palette; ids in main/commands/command-registry.ts),
// as handlers over a small context, so the rules (what a chord does in a zoomed group, with the keys
// off, at the group's edge) are unit-tested without a window. TabsPane gives the context.
import type { GroupsReply } from '../../shared/ipc'
import { GROUP_CAPS, neighbour, type GroupRefusalReason, type PaneEdge, type PlaceIntent } from '../../shared/tab-groups'
import type { PaneView } from '../state/groups-state'
import type { TabsAction, TabsState } from '../state/tabs-store'
import { equalizeSplits, nudgePane } from './pane-layout'

/** How far one resize chord moves a divider, as a share of its split. */
export const RESIZE_STEP = 0.05

export interface PaneCommandContext {
  state(): TabsState
  /** What this view shows now (paneView with the automatic zoom applied). */
  view(): PaneView
  dispatch(action: TabsAction): void
  place(intent: PlaceIntent): Promise<GroupsReply>
  remove(tabId: string): Promise<GroupsReply>
  dissolve(groupId: string): Promise<GroupsReply>
  resize(groupId: string, splitId: string, sizes: number[]): Promise<GroupsReply>
  /** This view's own edit of `tabId` is on the way (selectionAfterSnapshot's intent). */
  intend(tabId: string, intent: 'leave' | 'stay'): void
  /** Split right / down: the New tab menu at the new pane (D13). */
  openSplit(edge: 'right' | 'down'): void
  /** Show Tab Beside…: a tab picker; the pick goes beside the focused pane. */
  openBeside(edge: 'right' | 'down'): void
  /** The smallest share a pane may get along `axis` in this view (D5: 20x5 cells, 10%). */
  minShare(axis: 'row' | 'column'): number
  /** Tell the person why nothing happened (the strip's error line). */
  report(message: string): void
}

const ARROWS: ReadonlyArray<[string, PaneEdge]> = [
  ['Left', 'left'],
  ['Right', 'right'],
  ['Up', 'up'],
  ['Down', 'down']
]

/** What a refusal from main means to the person. */
export function refusalText(reason: GroupRefusalReason): string {
  switch (reason) {
    case 'full':
      return `A group holds at most ${GROUP_CAPS.maxPanes} panes.`
    case 'too-deep':
      return `Panes nest at most ${GROUP_CAPS.maxDepth} splits deep.`
    case 'too-many-groups':
      return `A project holds at most ${GROUP_CAPS.maxGroups} split groups.`
    case 'unknown-tab':
    case 'unknown-group':
    case 'unknown-split':
      return 'That tab or group is gone (changed in another view?).'
    case 'bad-name':
      return 'That name cannot be used (1-60 characters, no control characters).'
    default:
      return 'The panes could not be changed.'
  }
}

/** Every pane command's handler. */
export function paneCommandHandlers(ctx: PaneCommandContext): Record<string, () => void> {
  const done = (p: Promise<GroupsReply>): void => {
    p.then(
      (r) => {
        if (!r.ok) ctx.report(refusalText(r.reason))
      },
      (err: unknown) => ctx.report(err instanceof Error ? err.message : String(err))
    )
  }
  const handlers: Record<string, () => void> = {
    'pane.splitRight': () => ctx.openSplit('right'),
    'pane.splitDown': () => ctx.openSplit('down'),
    'pane.showBesideRight': () => ctx.openBeside('right'),
    'pane.showBesideDown': () => ctx.openBeside('down'),
    'pane.moveOut': () => {
      const { activeId } = ctx.state()
      if (activeId === null || !ctx.view().group) return
      ctx.intend(activeId, 'leave')
      done(ctx.remove(activeId))
    },
    'pane.zoom': () => {
      const { activeId } = ctx.state()
      const view = ctx.view()
      if (activeId === null || !view.group) return
      if (view.auto) {
        ctx.report('This view is too small to show these panes side by side; it shows the focused one.')
        return
      }
      ctx.dispatch({ type: 'zoom', groupId: view.group.id, tabId: view.zoomTab === undefined ? activeId : null })
    },
    'pane.equalize': () => {
      const group = ctx.view().group
      if (!group) return
      for (const { splitId, sizes } of equalizeSplits(group.root)) done(ctx.resize(group.id, splitId, sizes))
    },
    'pane.ungroup': () => {
      const group = ctx.view().group
      if (group) done(ctx.dissolve(group.id))
    }
  }
  // D23 R1: while the keys are off (D18), activeId names a pane the person did not pick and the strip
  // shows nothing selected, so a command acting on "the focused pane" does nothing: a ⌘⇧X or a split
  // meant for the pane that left must not land on the one that took its space (and move-out would
  // even hand the keys to a third). Focus chords are the way back; Equalize and Ungroup act on the
  // group the view shows, which the person sees.
  const onFocused = (run: () => void) => (): void => {
    if (!ctx.state().keysOff) run()
  }
  for (const name of ['pane.splitRight', 'pane.splitDown', 'pane.showBesideRight', 'pane.showBesideDown', 'pane.moveOut', 'pane.zoom']) {
    handlers[name] = onFocused(handlers[name]!)
  }
  for (const [name, dir] of ARROWS) {
    // Focus: the spatial neighbour, no wrap. A chord also turns the keys back on after D3 took them
    // off (staying on the same pane at the group's edge), and unzooms first: the person is moving
    // between panes, which a zoom hides.
    handlers[`pane.focus${name}`] = () => {
      const s = ctx.state()
      const view = ctx.view()
      if (s.activeId === null) return
      if (!view.group) {
        if (s.keysOff) ctx.dispatch({ type: 'keysOn' })
        return
      }
      if (view.zoomTab !== undefined && !view.auto) ctx.dispatch({ type: 'zoom', groupId: view.group.id, tabId: null })
      const target = neighbour(view.group.root, s.activeId, dir)
      if (target !== undefined) ctx.dispatch({ type: 'selected', tabId: target })
      else if (s.keysOff) ctx.dispatch({ type: 'keysOn' })
    }
    handlers[`pane.resize${name}`] = onFocused(() => {
      const s = ctx.state()
      const view = ctx.view()
      if (s.activeId === null || !view.group || view.zoomTab !== undefined) return
      const axis = dir === 'left' || dir === 'right' ? 'row' : 'column'
      const next = nudgePane(view.group.root, s.activeId, dir, RESIZE_STEP, ctx.minShare(axis))
      if (next) done(ctx.resize(view.group.id, next.splitId, next.sizes))
    })
    // Move Pane: the focused pane goes to the far side of its neighbour that way (a swap for two).
    handlers[`pane.move${name}`] = onFocused(() => {
      const s = ctx.state()
      const view = ctx.view()
      if (s.activeId === null || !view.group) return
      const target = neighbour(view.group.root, s.activeId, dir)
      if (target === undefined) return
      ctx.intend(s.activeId, 'stay')
      done(ctx.place({ tabId: s.activeId, at: target, edge: dir }))
    })
  }
  return handlers
}
