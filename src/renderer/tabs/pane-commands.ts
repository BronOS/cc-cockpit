// The split view's commands (D10 chords and the palette; ids in main/commands/command-registry.ts),
// as handlers over a small context, so the rules (what a chord does in a zoomed group, with the keys
// off, at the group's edge) are unit-tested without a window. TabsPane gives the context.
import type { CommandsView, GroupsReply } from '../../shared/ipc'
import { parseInGroupCommandId, parseTabCommandId } from '../../shared/tab-commands'
import { TOGGLE_FLAG_COMMAND } from '../../shared/tab-flag'
import { chordFromEvent, splitChord, type KeyEventLike } from '../../shared/keys'
import type { CommandContext, CommandHandler } from '../commands/keybindings'
import { GROUP_CAPS, groupOf, leavesOf, neighbour, type GroupRefusalReason, type PaneEdge, type PlaceIntent } from '../../shared/tab-groups'
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
  /** Split right / down of `tabId`: the New tab menu at the new pane (D13). */
  openSplit(tabId: string, edge: 'right' | 'down'): void
  /** Show Tab Beside…: a tab picker; the pick goes beside `tabId`. */
  openBeside(tabId: string, edge: 'right' | 'down'): void
  /** The smallest share a pane may get along `axis` in this view (D5: 20x5 cells, 10%). */
  minShare(axis: 'row' | 'column'): number
  /** Tell the person why nothing happened (the strip's error line). */
  report(message: string): void
}

/** What the active tab's own commands act through (TabsPane's actions). */
export interface ActiveTabContext {
  state(): TabsState
  close(tabId: string): void
  toggleFlag(tabId: string): void
}

/**
 * Close Tab (Cmd+W) and the flag chord, for the focused pane: the tab a chord typed in a page frame
 * names (`run.tabId`, design-split-pages.md §4), else the view's `activeId`. Cmd+W in the file pane
 * beside Claude closes the file, never the Claude pane the state still calls active (the shell's
 * pick of the file reaches the state only at the next render, the chord runs now). D23 R1: while the
 * keys are off (D18) the active tab is one the person did not pick and the strip shows none
 * selected; neither acts on it.
 */
export function activeTabHandlers(ctx: ActiveTabContext): Record<string, CommandHandler> {
  const onTab =
    (act: (tabId: string) => void) =>
    (run?: CommandContext): void => {
      const s = ctx.state()
      const id = run?.tabId ?? s.activeId
      if (id && !s.keysOff) act(id)
    }
  return { 'tab.close': onTab(ctx.close), [TOGGLE_FLAG_COMMAND]: onTab(ctx.toggleFlag) }
}

/** The key of a key event without its modifiers, spelled as a chord names it (`left`, `h`), or null for a lone modifier. */
function keyOfEvent(e: KeyEventLike): string | null {
  const chord = chordFromEvent(e)
  return chord === null ? null : (splitChord(chord)?.key ?? null)
}

/**
 * The keys of pane chords that came from outside the shell's document (main's `commands.trigger`
 * from a page tab's frame or a webview panel, the web shell's forwarded chords), held so their
 * auto-repeat is swallowed (the external review's MAJOR). The shell's own keydown path holds the
 * chord's `code` until its keyup (TabsPane `swallow`); a forwarded chord has no event here, only its
 * canonical text, so this holds its key: Ctrl+Alt+Left held in a file pane moves the keys to the
 * terminal, the person lets go of Ctrl and Alt first, and the arrow's repeats now reach the shell's
 * document, where without this they would go into the terminal (a Claude prompt's cursor, its
 * choices). Only repeats are swallowed: the keyup may have gone to the frame, never to the shell, so a
 * fresh press of the key (no repeat) ends the hold and is the person's, as is a keyup or a window blur.
 */
export class HeldChordKeys {
  private readonly keys = new Set<string>()

  /** A pane chord forwarded to the shell ran: hold its key (`ctrl+alt+left` holds `left`). */
  hold(chord: string): void {
    const key = splitChord(chord)?.key
    if (key) this.keys.add(key)
  }

  /** Whether this keydown is an auto-repeat of a held key (swallow it); a fresh press ends the hold. */
  swallows(e: KeyEventLike & { repeat: boolean }): boolean {
    if (this.keys.size === 0) return false
    const key = keyOfEvent(e)
    if (key === null || !this.keys.has(key)) return false
    if (e.repeat) return true
    this.keys.delete(key)
    return false
  }

  /** A keyup in the shell's document: that key is no longer held. */
  released(e: KeyEventLike): void {
    if (this.keys.size === 0) return
    const key = keyOfEvent(e)
    if (key !== null) this.keys.delete(key)
  }

  /** The window lost the keyboard: no keyup will come here, nothing is held. */
  clear(): void {
    this.keys.clear()
  }
}

/** What a new-tab command opens, as `tabs.create` takes it (without `beside`). */
export type NewTabKind = { kind: 'claude' } | { kind: 'shell' } | { kind: 'command'; level: 'app' | 'project'; entryId: string }

/** The tab a new-tab command id opens: New Claude Tab, New Shell Tab, a menu entry's command; else undefined. */
export function newTabOfCommand(id: string): NewTabKind | undefined {
  if (id === 'tab.newClaude') return { kind: 'claude' }
  if (id === 'tab.newShell') return { kind: 'shell' }
  const entry = parseTabCommandId(id)
  return entry ? { kind: 'command', level: entry.level, entryId: entry.entryId } : undefined
}

/** What New tab in Group acts through (TabsPane). */
export interface InGroupContext {
  state(): TabsState
  /** The pane's rect in pixels as this view draws it (TabsPane's paneSize). */
  paneSize(tabId: string): { w: number; h: number }
  /** Whether splitting `tabId` on `edge` leaves both halves big enough here (splitFits, D5). */
  fits(tabId: string, edge: 'right' | 'down'): boolean
  /** Open the tab; with `beside`, placed there by main in the same step (Split Right / Down's menu path). */
  create(what: NewTabKind, beside?: { tabId: string; edge: 'right' | 'down' }): void
  /** Tell the person why nothing happened (the strip's error line). */
  report(message: string): void
}

/**
 * Where New tab in Group puts the new pane beside a pane of `size` (pixels): to the right when it is
 * wider than tall, since cells are about twice as tall as wide and pixels are what the person sees;
 * else below. The other edge when that one does not fit; undefined when neither does.
 */
export function inGroupEdge(size: { w: number; h: number }, fits: (edge: 'right' | 'down') => boolean): 'right' | 'down' | undefined {
  const first = size.w > size.h ? 'right' : 'down'
  const second = first === 'right' ? 'down' : 'right'
  if (fits(first)) return first
  return fits(second) ? second : undefined
}

export const TOO_SMALL_TO_SPLIT = 'Too small to split: each pane needs at least 20 columns and 5 rows.'

/**
 * The "… in Group" commands of the table (`tab.inGroup.<base>`, design-split-pages.md §4 "New tab in
 * Group"): open the base's tab beside the focused pane (the frame's tab a chord names, else
 * `activeId`) with no menu. A plain focused tab forms a new group. Refused on the strip's error line,
 * with nothing opened, when the group is full or neither edge fits (main would otherwise open the
 * tab plain). With the keys off (D18, D23 R1) nothing, like every command on the active tab. With no
 * tab at all there is nothing to be beside, so the tab opens plain, as its base would.
 * Rebuilt from each table like tabCommandHandlers, so a removed entry's derived command goes too.
 */
export function inGroupHandlers(view: CommandsView, ctx: InGroupContext): Record<string, CommandHandler> {
  const out: Record<string, CommandHandler> = {}
  for (const c of view.commands) {
    const base = parseInGroupCommandId(c.id)
    const what = base === undefined ? undefined : newTabOfCommand(base)
    if (!what) continue
    out[c.id] = (run?: CommandContext): void => {
      const s = ctx.state()
      if (s.keysOff) return
      const target = run?.tabId ?? s.activeId
      if (target === null) {
        ctx.create(what)
        return
      }
      const g = groupOf(s.groups, target)
      if (g && leavesOf(g.root).length >= GROUP_CAPS.maxPanes) {
        ctx.report(refusalText('full'))
        return
      }
      const edge = inGroupEdge(ctx.paneSize(target), (e) => ctx.fits(target, e))
      if (!edge) {
        ctx.report(TOO_SMALL_TO_SPLIT)
        return
      }
      ctx.create(what, { tabId: target, edge })
    }
  }
  return out
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
    case 'not-a-pane':
      return 'That tab cannot be a pane.'
    case 'bad-name':
      return 'That name cannot be used (1-60 characters, no control characters).'
    default:
      return 'The panes could not be changed.'
  }
}

/**
 * Every pane command's handler. Each acts on "the focused pane": the tab a chord typed in a page
 * frame names (`run.tabId`, design-split-pages.md §4; the shell picked that pane just before, but its
 * state reaches `ctx.state()` only at the next render), else the view's `activeId`.
 */
export function paneCommandHandlers(ctx: PaneCommandContext): Record<string, CommandHandler> {
  const focused = (run?: CommandContext): string | null => run?.tabId ?? ctx.state().activeId
  const done = (p: Promise<GroupsReply>): void => {
    p.then(
      (r) => {
        if (!r.ok) ctx.report(refusalText(r.reason))
      },
      (err: unknown) => ctx.report(err instanceof Error ? err.message : String(err))
    )
  }
  const split =
    (edge: 'right' | 'down', open: (tabId: string, edge: 'right' | 'down') => void) =>
    (run?: CommandContext): void => {
      const id = focused(run)
      if (id !== null) open(id, edge)
    }
  const handlers: Record<string, CommandHandler> = {
    'pane.splitRight': split('right', ctx.openSplit),
    'pane.splitDown': split('down', ctx.openSplit),
    'pane.showBesideRight': split('right', ctx.openBeside),
    'pane.showBesideDown': split('down', ctx.openBeside),
    'pane.moveOut': (run) => {
      const activeId = focused(run)
      if (activeId === null || !ctx.view().group) return
      ctx.intend(activeId, 'leave')
      done(ctx.remove(activeId))
    },
    'pane.zoom': (run) => {
      const activeId = focused(run)
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
  const onFocused = (handler: CommandHandler) => (run?: CommandContext): void => {
    if (!ctx.state().keysOff) handler(run)
  }
  for (const name of ['pane.splitRight', 'pane.splitDown', 'pane.showBesideRight', 'pane.showBesideDown', 'pane.moveOut', 'pane.zoom']) {
    handlers[name] = onFocused(handlers[name]!)
  }
  for (const [name, dir] of ARROWS) {
    // Focus: the spatial neighbour, no wrap. A chord also turns the keys back on after D3 took them
    // off (staying on the same pane at the group's edge), and unzooms first: the person is moving
    // between panes, which a zoom hides.
    handlers[`pane.focus${name}`] = (run) => {
      const s = ctx.state()
      const at = focused(run)
      const view = ctx.view()
      if (at === null) return
      if (!view.group) {
        if (s.keysOff) ctx.dispatch({ type: 'keysOn' })
        return
      }
      if (view.zoomTab !== undefined && !view.auto) ctx.dispatch({ type: 'zoom', groupId: view.group.id, tabId: null })
      const target = neighbour(view.group.root, at, dir)
      if (target !== undefined) ctx.dispatch({ type: 'selected', tabId: target })
      else if (s.keysOff) ctx.dispatch({ type: 'keysOn' })
    }
    handlers[`pane.resize${name}`] = onFocused((run) => {
      const at = focused(run)
      const view = ctx.view()
      if (at === null || !view.group || view.zoomTab !== undefined) return
      const axis = dir === 'left' || dir === 'right' ? 'row' : 'column'
      const next = nudgePane(view.group.root, at, dir, RESIZE_STEP, ctx.minShare(axis))
      if (next) done(ctx.resize(view.group.id, next.splitId, next.sizes))
    })
    // Move Pane: the focused pane goes to the far side of its neighbour that way (a swap for two).
    handlers[`pane.move${name}`] = onFocused((run) => {
      const at = focused(run)
      const view = ctx.view()
      if (at === null || !view.group) return
      const target = neighbour(view.group.root, at, dir)
      if (target === undefined) return
      ctx.intend(at, 'stay')
      done(ctx.place({ tabId: at, at: target, edge: dir }))
    })
  }
  return handlers
}
