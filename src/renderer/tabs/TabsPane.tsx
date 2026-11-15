import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CccCommandView, ProjectSummary, TabCommandMenu, TabInfo } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
import type { FlagPatch } from '../../shared/tab-flag'
import type { CommandInfo, CommandsView } from '../../shared/ipc'
import { CommandPalette } from '../commands/CommandPalette'
import { commandAllowed } from '../commands/command-gate'
import {
  chordOf,
  commandForEvent,
  pluginCommandHandlers,
  registerHandlers,
  runCommand,
  runnableCommands,
  setCommands,
  setForwardedRunner,
  tabCommandHandlers
} from '../commands/keybindings'
import { ipcErrorMessage } from '../ipc-error'
import { discussTabsOf } from '../overlays/discuss-tabs'
import { OverlayStack } from '../overlays/OverlayStack'
import { SettingsOverlay } from '../settings/SettingsOverlay'
import { OPEN_PLUGIN_SETTINGS_EVENT, targetOf, type SettingsTarget } from '../settings/settings-target'
import { currentShellChrome, isServerView, isWebShell, takeLoadTab, takeLoadTake } from '../shell-kind'
import { initialTabsState, tabsReducer } from '../state/tabs-store'
import { ignoresMainSelect, paneView, type PaneView } from '../state/groups-state'
import { usePrefs } from '../prefs/prefs-store'
import type { GroupsReply } from '../../shared/ipc'
import { groupOf, isPaneKind, leavesOf, rectsOf, type GroupsSnapshot, type PaneEdge, type TabGroup } from '../../shared/tab-groups'
import { autoZoomed, cellEstimate, dragMinShare, edgePreview, edgeZone, equalizeSplits, splitFits, type Size } from './pane-layout'
import { paneAtPoint } from './SplitArea'
import { activeTabHandlers, inGroupHandlers, paneCommandHandlers, refusalText, TOO_SMALL_TO_SPLIT, type NewTabKind } from './pane-commands'
import { SplitArea, type PaneDrop } from './SplitArea'
import { lastSplitChoice, NewPaneMenu, rememberSplitChoice, type NewPaneChoice, type SplitMenu } from './NewPaneMenu'
import { tabLabel } from './tab-label'
import { TopStrip } from '../status/TopStrip'
import { useSessions } from '../status/use-sessions'
import { isSeeThrough } from '../theme/see-through'
import { UpdateNotice } from '../updates/UpdateNotice'
import { useLayout } from '../zones/use-layout'
import { useShellLayer } from '../zones/use-shell-layer'
import { Zones } from '../zones/Zones'
import { closeAnswer, closeGroupQuestion, closeMayAsk, closeQuestion, tabIsRunning, unsavedQuestion, type CloseQuestion } from './close-confirm'
import { groupTitle } from './strip-groups'
import { UnlistedCloseAsks } from './close-ask-wait'
import { CloseTabApproval, CloseTabDialog } from './CloseTabDialog'
import { CccOfferDialog } from './CccOfferDialog'
import { PageTabDiscussDialog } from './PageTabDiscussDialog'
import { DiscussCooldown, discussMayOpen } from './page-tab-discuss-model'
import { setPageTabDiscussHandler } from './PageTabArea'
import { TabBar } from './TabBar'
import { TabSwitcher } from './TabSwitcher'
import {
  heldModifiers,
  openSwitcher,
  released,
  SHOW_DELAY_MS,
  step,
  SWITCH_NEXT,
  SWITCH_PREV,
  touchRecent,
  type SwitcherState
} from './tab-switcher'
import { SessionRegistry, tabIo } from './terminal-session'
import { checkFrameFocus, pageFrames, setFrameFocusHandler } from './PageTabArea'
import { chordTarget } from './frame-focus'

/**
 * `tabs.list` is the desktop's re-attach point after a page load and resets PTY flow control in
 * main (or resyncs every terminal with a snapshot while web access is on), so it must run once per
 * page load and never to refresh the list (with xterm saturated that would resume a paused PTY).
 * The promise is kept at module level so a React StrictMode remount in dev reuses the one answer
 * instead of asking twice.
 *
 * The web shell asks on every mount: main answers a remote view with the plain list and touches no
 * terminal (router.ts `tabs.list`; the view's terminals come as term.* frames once it selects a
 * tab), and a reconnect remounts the shell, which must not be drawn from the first socket's list.
 */
let attached: Promise<TabInfo[]> | undefined
function attachTabs(): Promise<TabInfo[]> {
  if (isWebShell()) return window.cockpit.invoke('tabs.list')
  attached ??= window.cockpit.invoke('tabs.list')
  return attached
}

/** KeyboardEvent.key of the modifiers: not "held keys" the switcher swallows after it ends. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

/**
 * macOS project windows draw their own title bar (main hides the native one there:
 * main/windows/window-chrome.ts keys off the same platform); the web shell draws no window chrome
 * at all (shell-kind.ts). Read at render, not at module load: the web entry marks the shell after
 * its imports (this module among them) have run. Neither changes for the page's life.
 */

/**
 * A plugin close waiting for the outcome (`sessions.closeAsk`). `declined`: this view could not ask
 * (another dialog, a screen or an overlay over it, or its close failed), which main counts only once
 * every view of the window declined (close-asks.ts): a person's Cancel is not a decline.
 */
/** `discard`: the person was asked (the close dialog) and chose Close. */
type CloseDone = (closed: boolean, declined?: boolean, discard?: boolean) => void

/** The dialog went: answer the plugin close waiting on it (`confirmDone`), if one is, once. */
function settleClose(confirmDone: { current: CloseDone | null }, closed: boolean, declined = false, discard = false): void {
  const done = confirmDone.current
  confirmDone.current = null
  done?.(closed, declined, discard)
}

/** The project window's terminal tabs: tab bar plus one mounted terminal per tab. */
export function TabsPane(props: { project?: ProjectSummary; fullScreen?: boolean }): React.JSX.Element {
  const [chrome] = useState(currentShellChrome)
  const inPageTitleBar = chrome.titleBar
  // macOS hides the traffic lights in full screen; main tells the page when that changes (the
  // initial value comes with window.info, for a window restored in full screen). Both are the
  // desktop window's, so the web shell ignores them (its `window.state` never fires anyway).
  const [fullScreen, setFullScreen] = useState(chrome.fullScreen && props.fullScreen === true)
  useEffect(() => {
    if (!chrome.fullScreen) return undefined
    return window.cockpit.on('window.state', (s) => setFullScreen(s.fullScreen))
  }, [chrome])
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState)
  // The split view (SplitArea): the terminal area's size and about one cell of the terminal font,
  // for D5's automatic zoom and minimums; what this view shows of its selection.
  const [area, setArea] = useState<Size>({ width: 0, height: 0 })
  const { terminalFont } = usePrefs()
  const cell = useMemo(() => cellEstimate(terminalFont), [terminalFont])
  // A see-through window's tab terminals let its glass through; overlays keep their own registry,
  // opaque (OverlayStack).
  const [sessions] = useState(() => new SessionRegistry(tabIo, { seeThrough: isSeeThrough() }))
  // The 20x5 minimum (a split, a divider's stop) and D5's automatic zoom count the cells the pty will
  // really get (qa run 1 Q4): xterm's measured cell when a terminal has one at the set font, else the
  // estimate. One cell for all of them (D26 N1): with the estimate here and the measured cell at the
  // stop, a pane dragged to the stop read as under 20x5 and auto-zoomed on release.
  const cellNow = useCallback((): Size => sessions.cellSize() ?? cell, [sessions, cell])
  // Read when the view is worked out (a snapshot, a selection, the area or the font changing), so a
  // drag's release judges the new sizes with the same cell its stop used.
  const autoZoom = useCallback((g: TabGroup): boolean => autoZoomed(g.root, area, cellNow()), [area, cellNow])
  const view = useMemo(() => paneView(state.groups, state.activeId, state.zoomed, autoZoom), [state.groups, state.activeId, state.zoomed, autoZoom])
  const viewRef = useRef<PaneView>(view)
  const autoZoomRef = useRef(autoZoom)
  // This view's own group edits on the way, by tab (selectionAfterSnapshot): a close or move out the
  // person made here ('leave'), or a placement of a tab they keep looking at ('stay'). Read when a
  // snapshot comes; an entry goes once its edit's reply is in (main sends the snapshot first).
  const intents = useRef(new Map<string, 'leave' | 'stay'>())
  // The window's zone layout, here rather than in Zones: the top bar draws the app's slot frames
  // (`appSlots`) that come with the same view.
  const layout = useLayout(props.project?.id)
  const [error, setError] = useState<string | null>(null)
  // The user entries of the [+] menu, read each time the menu opens (Settings may have changed them).
  const [menuCommands, setMenuCommands] = useState<TabCommandMenu | null>(null)
  const { own } = useSessions()
  // Discuss with Claude's targets on an overlay's toolbar (OverlayStack).
  const discussTabs = useMemo(() => discussTabsOf(state.tabs, own), [state.tabs, own])
  const [paletteCommands, setPaletteCommands] = useState<CommandInfo[] | null>(null)
  // The settings screen (Cmd+,): a core overlay drawn by the renderer itself (SettingsOverlay).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Set by a panel's gear (design-next §5.3): the page and plugin the screen opens at; null: where it opens by default.
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null)
  // Tabs main closed (`tabs.removed`). A restart reply that lands after it must not touch the
  // tab's terminal: sessions.get would create a new one for a tab that is gone.
  const removed = useRef(new Set<string>())
  // Command handlers are registered once but must see the current tab state.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
    viewRef.current = view
    autoZoomRef.current = autoZoom
  }, [state, view, autoZoom])
  // "Close <tab>?" (close-confirm.ts): the question shown, null when no dialog is up.
  const [confirm, setConfirm] = useState<CloseQuestion | null>(null)
  // The start-up "Install the ccc command?" (main decides once per launch, ccc-offer.ts): the link's
  // view while the dialog is up, null otherwise.
  const [cccOffer, setCccOffer] = useState<CccCommandView | null>(null)
  // Read by the key handler and focusActive like confirmFor: modal, no command runs meanwhile.
  const offerShown = useRef(false)
  useEffect(() => {
    offerShown.current = cccOffer !== null
  }, [cccOffer])
  // Ask Claude's question box over a page tab (design-editor.md §4): the tab it asks about, null when
  // no box is up. Modal like the ccc offer (the key handler and focusActive read the ref).
  // `preferred`: the Claude tab this view showed last when the box opened (it sends there by default).
  const [discussFor, setDiscussFor] = useState<{ tabId: string; preferred?: string } | null>(null)
  // The tab the box asks about; it closing (here or in another view) takes the box down with it.
  const discussTab = discussFor === null ? undefined : state.tabs.find((t) => t.id === discussFor.tabId)
  const discussOpen = discussTab !== undefined
  const discussShown = useRef(false)
  useEffect(() => {
    discussShown.current = discussOpen
  }, [discussOpen])
  // The Claude tab this view showed last: the box sends there unless the person picks another.
  const lastClaude = useRef<string | undefined>(undefined)
  useEffect(() => {
    const active = state.tabs.find((t) => t.id === state.activeId)
    if (active?.kind === 'claude') lastClaude.current = active.id
  }, [state.activeId, state.tabs])
  useEffect(() => {
    let cancelled = false
    window.cockpit.invoke('ccc.offer').then(
      (view) => { if (!cancelled && view) setCccOffer(view) },
      () => undefined
    )
    return () => { cancelled = true }
  }, [])
  // The window key handler is registered once; it reads the palette's state through this ref.
  const paletteOpen = useRef(false)
  // Whether an overlay covers the window (OverlayStack reports it); read by the key handler.
  const overlayOpen = useRef(false)
  // Likewise for the settings screen, which the key handler also treats as modal. Also set by
  // openSettings/closeSettings themselves, not only after the render: a focus frame queued just
  // before (the palette closing as it runs "Open Settings") reads it when the frame fires.
  const settingsShown = useRef(false)
  const settingsRoot = useRef<HTMLDivElement>(null)
  // The tab whose close dialog is up, else null: modal like the settings screen (the key handler
  // and focusActive read it), and set before the render for the same reason as settingsShown.
  const confirmFor = useRef<string | null>(null)
  // A plugin's ctx.sessions.close waiting on the dialog that is up (`sessions.closeAsk`): told
  // whether the tab closed once the dialog goes, however it goes. Null for the person's own close.
  const confirmDone = useRef<CloseDone | null>(null)
  // The plugin close ask (request id) the dialog that is up answers, with confirmDone; null for the
  // person's own close. `sessions.closeSettled` for it (another view answered first) takes it down.
  const confirmAsk = useRef<string | null>(null)
  // Plugin close asks this view has not answered yet and main has not settled (shared asks: every
  // view of the window is asked, the first answer wins). A repeat of one (the web bridge hands a
  // late subscriber the asks still pending) is ignored, and one settled meanwhile is not acted on.
  const liveAsks = useRef(new Set<string>())
  // Plugin close asks that came before this view's tab list (a view joining mid-ask), asked once it
  // is in; `runAsk` is the closeAsk listener's runner they are handed to.
  const asksBeforeList = useRef<Array<{ requestId: string; tabId: string }>>([])
  const runAsk = useRef<((requestId: string, tabId: string, mayWait: boolean) => void) | null>(null)
  // Live asks for a tab the strip does not show yet (a plugin's open then close: its `tabs.added`
  // is not committed yet), asked once it is (close-ask-wait.ts).
  const unlistedAsks = useRef<UnlistedCloseAsks | null>(null)
  // The window's own Claude statuses, for the dialog's "Claude is working" (read when it opens).
  const ownRef = useRef(own)
  // The Ctrl+Tab switcher (tab-switcher.ts): open while non-null, mirrored in a ref for the window
  // key handlers, which are registered once. `recent` is the tab ids by last activation, the
  // active one first; kept in a ref, it changes on every switch and nothing renders from it.
  const [switcher, setSwitcherState] = useState<SwitcherState | null>(null)
  const switcherRef = useRef<SwitcherState | null>(null)
  const showTimer = useRef<number | undefined>(undefined)
  const recent = useRef<string[]>([])
  // Set while the window key handler runs a command: a switch chord typed here is held, so the
  // release picks. From anywhere else (the palette, a web panel's page) there is no hold to wait
  // for, and the switcher opens shown and waits for a click, Enter or Esc.
  const fromKey = useRef(false)
  // Non-modifier keys pressed while the switcher is open and not yet released (KeyboardEvent.code).
  // When the switcher ends they move to `swallow`, whose keydowns (auto-repeats of a held Enter,
  // Esc, or Tab after Ctrl went up first) are dropped until the key comes up: they would land in
  // the terminal that just got the focus, where a repeated Enter could answer a Claude prompt.
  const heldKeys = useRef(new Set<string>())
  const swallow = useRef(new Set<string>())
  useEffect(() => {
    if (state.activeId) recent.current = touchRecent(recent.current, state.activeId)
  }, [state.activeId])

  useEffect(() => {
    // Subscribe before asking for the list so no output or exit falls between the two. Output of
    // a tab whose view is not mounted yet is parsed by its session all the same.
    const offData = window.cockpit.on('tabs.data', ({ tabId, data, reset, cols, rows, local }) => {
      // `cols`/`rows`: the pty's size at this point of the stream (a size item or a snapshot's);
      // `local`: this view sizes the pty, so it fits its pane itself (TerminalSession.write).
      const size = typeof cols === 'number' && typeof rows === 'number' ? { cols, rows } : undefined
      sessions.write(tabId, data, reset === true, size, local === true)
    })
    // Main asks this (desktop) page for a tab's screen to seed web access's copy of it; in order
    // with the output above, so the answer is as of exactly what main had sent (desktop only: a
    // browser is never asked, `tabs.screenAsk` is a `no` channel).
    const offScreenAsk = window.cockpit.on('tabs.screenAsk', ({ tabId, id, scrollback }) => {
      sessions.answerScreen(tabId, id, scrollback)
    })
    // Who typed last (TerminalView shows it when that was another view).
    const offTyped = window.cockpit.on('tabs.typed', ({ tabId, viewId, device }) => {
      dispatch({ type: 'typed', tabId, typedBy: viewId === null || device === null ? null : { viewId, device } })
    })
    const offExit = window.cockpit.on('tabs.exit', ({ tabId, code, signal, gen }) => {
      dispatch({ type: 'exited', tabId, exit: { code, signal }, gen })
    })
    // main closed a tab whose process exited cleanly (the `tabExit` setting): as the user's Close.
    const offRemoved = window.cockpit.on('tabs.removed', ({ tabId, gen }) => {
      removed.current.add(tabId)
      // Its process ended cleanly while its close dialog was up: nothing is left to ask about.
      if (confirmFor.current === tabId) {
        confirmFor.current = null
        setConfirm(null)
        // The tab is gone, which is what a plugin's close asked for.
        settleClose(confirmDone, true)
      }
      sessions.dispose(tabId)
      dispatch({ type: 'removed', tabId, gen })
    })
    // A plugin focused this window's tab (ctx.sessions.focus, e.g. the cockpit.sessions strip of
    // any window): main already focused the window; only the selection is ours.
    const offSelect = window.cockpit.on('tabs.select', ({ tabId }) => {
      if (ignoresMainSelect(stateRef.current.keysOff, viewRef.current.visible, tabId)) return
      dispatch({ type: 'selected', tabId })
    })
    // A tab main started on its own (a plugin's ctx.sessions.open). One that arrives before the
    // list answered may or may not be in it (main takes the list after it awaits the restore):
    // 'loaded' merges by id and generation, so it is neither duplicated nor dropped.
    const offAdded = window.cockpit.on('tabs.added', (tab) => {
      dispatch({ type: 'announced', tab })
    })
    // Another view of the window moved a tab: main's clamped index (the reducer clamps again
    // against this strip, which may not hold a tab main just started).
    const offMoved = window.cockpit.on('tabs.moved', ({ tabId, toIndex }) => {
      dispatch({ type: 'moved', tabId, toIndex })
    })
    // The project's split groups (main/tabs/tab-groups.ts is their one writer): every change from any
    // view, a plugin or a closing tab comes as a whole snapshot; the reducer drops an older seq.
    const applyGroups = (snapshot: GroupsSnapshot): void => {
      dispatch({ type: 'groups', snapshot, intent: Object.fromEntries(intents.current) })
    }
    const offGroups = window.cockpit.on('groups.changed', applyGroups)
    attachTabs()
      .then((tabs) => {
        dispatch({ type: 'loaded', tabs })
        // The web shell opened with `?tab=` (a session chip of another project, server mode's
        // `project.goto`): that tab, once the list holds it. Batched with 'loaded', so the first
        // selection reported and the load take are already that tab's; an id not in the list
        // changes nothing (the reducer ignores it).
        const wanted = takeLoadTab()
        if (wanted !== undefined) dispatch({ type: 'selected', tabId: wanted })
        // After the list: main restores the groups before it answers it (restore remaps the ids).
        return window.cockpit.invoke('groups.get').then(applyGroups, (err: unknown) => {
          console.warn('reading the split groups failed', err)
        })
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
    return () => {
      offData()
      offScreenAsk()
      offTyped()
      offExit()
      offRemoved()
      offSelect()
      offAdded()
      offMoved()
      offGroups()
      sessions.disposeAll()
    }
  }, [sessions])

  // main keeps the selection for plugins (SessionInfo.active: "the tab the person is looking
  // at"); every way it changes (a click, a key, a close, main's tabs.select, the first list) ends
  // in activeId, so this one effect reports them all. A failure is only logged: the selection here
  // is unaffected, and a plugin then sees the previous tab as active until the next change.
  useEffect(() => {
    // D18: while a change elsewhere left this view with no focused pane, it reports nothing; the
    // person's click, strip click or chord turns the keys on, and the selection is reported then.
    if (state.activeId === null || state.keysOff) return
    // Browser shell, first load only (armLoadTake): the active terminal takes the size once, as a
    // click would; a tab without a terminal yet is skipped, never taken later for another tab.
    if (takeLoadTake()) sessions.takeOnLoad(state.activeId)
    // A take waiting on another tab (a selection whose terminal had not attached) is dropped, so
    // a programmatic change after it (a close, main's tabs.select) never takes for that tab. The
    // panes the selection shows keep theirs (a split group selected takes for every pane, D2).
    sessions.activeChanged(viewRef.current.visible.includes(state.activeId) ? viewRef.current.visible : state.activeId)
    window.cockpit.invoke('tabs.selected', { tabId: state.activeId }).catch((err: unknown) => {
      console.warn('reporting the selected tab failed', err)
    })
  }, [state.activeId, state.keysOff, sessions])

  // Whether this view is on screen (a minimized window, a background browser tab): main lets only
  // a visible view size a tab's pty (main/tabs/terminal-sizes.ts). Told on mount (a page loading
  // hidden) and on every change.
  useEffect(() => {
    const report = (): void => {
      window.cockpit.invoke('tabs.visibility', { visible: document.visibilityState !== 'hidden' }).catch((err: unknown) => {
        console.warn('reporting the visibility failed', err)
      })
    }
    report()
    document.addEventListener('visibilitychange', report)
    return () => document.removeEventListener('visibilitychange', report)
  }, [])

  const run = (action: Promise<unknown>): void => {
    setError(null)
    action.catch((err: unknown) => setError(ipcErrorMessage(err)))
  }

  /**
   * The person selected `tabId` in this view (a tab bar click, the switcher, a tab shortcut): its
   * terminal takes the pty's size here, as a click in the pane would (TerminalSession.takeOnSelect;
   * nothing is sent while this view sizes it, web access off always). Every programmatic selection
   * (restore, main's tabs.select, a close) dispatches `selected` or `added` directly instead. A
   * Sessions panel click is one of those: it reaches this page as main's tabs.select, from a
   * plugin's ctx.sessions.focus, and nothing there tells a person's click from a plugin's call.
   */
  const pickTab = useCallback(
    (tabId: string): void => {
      // D2: selecting a group takes for every pane it will show (a pane its zoom hides takes nothing).
      const s = stateRef.current
      const g = groupOf(s.groups, tabId)
      const z = g ? s.zoomed[g.id] : undefined
      const zoomed = { ...s.zoomed }
      if (g && z !== undefined && z !== tabId) delete zoomed[g.id]
      const shown = paneView(s.groups, tabId, zoomed, autoZoomRef.current).visible
      sessions.takeOnSelect(tabId, shown)
      dispatch({ type: 'selected', tabId })
    },
    [sessions]
  )
  /** A tab this view's person made (the + menu, a new-tab command): added, selected and taken. */
  const addPicked = (tab: TabInfo): void => {
    sessions.takeOnSelect(tab.id)
    dispatch({ type: 'added', tab })
  }

  const create = (kind: 'claude' | 'shell'): void =>
    run(
      window.cockpit.invoke('tabs.create', { kind }).then((tab) => {
        // Never null for Claude or Shell (only a command entry opens as an overlay).
        if (tab) addPicked(tab)
      })
    )

  // A user entry: by level and id only, main looks the command up in its own settings. null: the
  // entry opens as an overlay, which arrives through `overlays.updated` like any other.
  const createCommand = (level: TabCommandLevel, entryId: string): void =>
    run(
      window.cockpit.invoke('tabs.create', { kind: 'command', level, entryId }).then((tab) => {
        if (tab) addPicked(tab)
      })
    )

  const loadMenuCommands = (): void => {
    window.cockpit
      .invoke('tabs.commands')
      .then(setMenuCommands)
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
  }

  // The close itself, with no question: what a confirmed or unguarded close ends in. `done` is a
  // plugin's close waiting for the outcome.
  // A plugin's close that fails is told so (declined: with several views of the window, another
  // view closing the tab first is the usual reason) and shows the error too, as the confirm path does.
  // `discard`: the person was asked and chose Close. Without it main leaves a page tab that some
  // view reported dirty open (`{ unsaved: true }`: this view's copy of the dirty lagged), and the
  // question is asked now.
  const close = (tabId: string, done?: CloseDone, discard = false): void => {
    // The person's own close (no plugin waiting on it): D3 moves the focus to the pane that took
    // its space, whichever comes first, main's snapshot or this reply.
    const own = done === undefined
    if (own) intents.current.set(tabId, 'leave')
    run(
      window.cockpit.invoke('tabs.close', discard ? { tabId, discard: true } : { tabId }).then(
        (res) => {
          if (res && res.unsaved === true) {
            // Not closed: no pane took its space, so the focus intent goes with the refusal.
            intents.current.delete(tabId)
            askUnsaved(tabId, done)
            return
          }
          sessions.dispose(tabId)
          dispatch({ type: 'closed', tabId, own })
          intents.current.delete(tabId)
          done?.(true)
        },
        (err: unknown) => {
          intents.current.delete(tabId)
          if (!done) throw err
          console.warn('a plugin close failed', err)
          done(false, true)
          setError(ipcErrorMessage(err))
        }
      )
    )
  }

  const restart = (tabId: string): void =>
    run(
      window.cockpit.invoke('tabs.restart', { tabId }).then((tab) => {
        if (removed.current.has(tabId)) return
        // Main respawned the PTY (at the tab's last size); send ours again, applied if we size it.
        sessions.get(tabId).resetSize()
        dispatch({ type: 'restarted', tab })
      })
    )

  const cancelQueued = (tabId: string, itemId: string): void =>
    run(window.cockpit.invoke('sessions.cancelQueued', { tabId, itemId }))

  // ---- Split view (design.md §1; SplitArea, pane-commands.ts) ----
  // Group edits are small intents main checks and applies; the result comes back to every view as
  // `groups.changed`, so nothing here changes the page's groups on a reply.
  /** A group edit's reply: a refusal is told to the person; an intent ends with its reply. */
  const groupEdit = useCallback((p: Promise<GroupsReply>, tabId?: string): Promise<GroupsReply> => {
    setError(null)
    const out = p.then(
      (r) => {
        if (!r.ok) setError(refusalText(r.reason))
        return r
      },
      (err: unknown) => {
        setError(ipcErrorMessage(err))
        return { ok: false as const, reason: 'unknown-tab' as const }
      }
    )
    if (tabId !== undefined) void out.finally(() => intents.current.delete(tabId))
    return out
  }, [])
  /**
   * Put `tabId` at `edge` of `at`'s pane. `select`: then show it there, focused (a drag, the tab
   * menu's Show beside: the person moved that tab to look at it); else the focus stays on the anchor
   * (the palette's Show Tab Beside…, run from the pane the person works in).
   */
  const placeTab = useCallback(
    (tabId: string, at: string, edge: PaneEdge, select: boolean): void => {
      intents.current.set(tabId, 'stay')
      void groupEdit(window.cockpit.invoke('groups.place', { tabId, at, edge }), tabId).then((r) => {
        if (r.ok && select) pickTab(tabId)
      })
    },
    [groupEdit, pickTab]
  )
  /** The strip's label of a tab, for the drop preview ("Right of npm dev"). */
  const labelOf = (tabId: string): string => {
    const t = state.tabs.find((x) => x.id === tabId)
    return t ? tabLabel(t, own.get(tabId)?.title, own.get(tabId)?.name) : 'this pane'
  }
  // Pane mode of a strip drag (TabBar): the edge zone under the pointer, previewed in the area.
  const [paneDrop, setPaneDrop] = useState<PaneDrop | null>(null)
  const paneDropRef = useRef<PaneDrop | null>(null)
  const dragToPane = (tabId: string, point: { x: number; y: number } | null): void => {
    let next: PaneDrop | null = null
    if (point && isPaneKind(stateRef.current.tabs.find((t) => t.id === tabId)?.kind)) {
      const hit = paneAtPoint(document.querySelector<HTMLElement>('[data-split-area]'), point.x, point.y)
      const edge = hit && hit.tabId !== tabId ? edgeZone(hit.rect, point) : null
      if (hit && edge) next = { at: hit.tabId, edge, label: labelOf(hit.tabId) }
    }
    paneDropRef.current = next
    setPaneDrop((d) => (d?.at === next?.at && d?.edge === next?.edge ? d : next))
  }
  const dropOnPane = (tabId: string): void => {
    const d = paneDropRef.current
    paneDropRef.current = null
    setPaneDrop(null)
    if (d) placeTab(tabId, d.at, d.edge, true)
  }
  /** The handle's click: the group, at this view's last focused pane there (else its first). */
  const selectGroup = (groupId: string): void => {
    const g = state.groups.find((x) => x.id === groupId)
    if (!g) return
    const leaves = leavesOf(g.root)
    const last = state.lastFocus[groupId]
    const target = last !== undefined && leaves.includes(last) ? last : leaves.find((t) => state.tabs.some((x) => x.id === t))
    if (target) pickTab(target)
  }
  /** Ungroup, the person's own: the pane they are in stays selected, with its keys. */
  const ungroup = (groupId: string): Promise<GroupsReply> => {
    const active = stateRef.current.activeId
    if (active !== null) intents.current.set(active, 'stay')
    return groupEdit(window.cockpit.invoke('groups.dissolve', { groupId }), active ?? undefined)
  }
  const equalizeGroup = (groupId: string): void => {
    const g = state.groups.find((x) => x.id === groupId)
    if (!g) return
    for (const { splitId, sizes } of equalizeSplits(g.root)) void groupEdit(window.cockpit.invoke('groups.resize', { groupId, splitId, sizes }))
  }
  /**
   * The handle was dragged along the strip (D9, D17): `block` moves the whole group; `toIndex` counts
   * the other tabs only. The strip changes when main's snapshot comes (its order is the one order).
   */
  const moveGroup = (groupId: string, toIndex: number): void => {
    const g = state.groups.find((x) => x.id === groupId)
    const first = g ? state.tabs.find((t) => leavesOf(g.root).includes(t.id)) : undefined
    if (first) run(window.cockpit.invoke('tabs.reorder', { tabId: first.id, toIndex, block: true }))
  }
  /**
   * A member dragged out of its segment (D9, D17): a plain reorder, which main turns into leaving the
   * group there. Marked as the person's own move out, so this view's focus follows D3's own rule.
   */
  const detach = (tabId: string, toIndex: number): void => {
    intents.current.set(tabId, 'leave')
    run(
      window.cockpit.invoke('tabs.reorder', { tabId, toIndex }).finally(() => {
        intents.current.delete(tabId)
      })
    )
  }
  /** Close all (the handle's menu): one question listing the running members, then each closes. */
  const closeGroup = (groupId: string): void => {
    const g = state.groups.find((x) => x.id === groupId)
    if (!g || confirmFor.current !== null) return
    const members = leavesOf(g.root).flatMap((id) => state.tabs.find((t) => t.id === id) ?? [])
    const closeAll = (): void => {
      for (const t of members) if (stateRef.current.tabs.some((x) => x.id === t.id)) close(t.id)
    }
    // Nothing running and nothing unsaved (here or as main knows it): close at once. An unsaved
    // member makes the question whatever the setting says (closeGroupQuestion).
    const dirtyHere = (id: string): boolean => pageFrames().isDirty(id)
    if (!members.some((t) => tabIsRunning(t) || (t.kind === 'page' && (t.dirty === true || dirtyHere(t.id))))) {
      closeAll()
      return
    }
    window.cockpit
      .invoke('settings.confirmTabClose')
      .catch(() => true)
      .then((enabled) => {
        if (confirmFor.current !== null || settingsShown.current || overlayOpen.current) return
        const question = closeGroupQuestion(groupId, groupTitle(g), members, (id) => ownRef.current.get(id)?.status, enabled, dirtyHere)
        if (!question) {
          closeAll()
          return
        }
        confirmFor.current = `group:${groupId}`
        confirmDone.current = null
        confirmAsk.current = null
        setConfirm(question)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
  }
  /** A pane's rect in pixels in this view: from the layout, so a tab not on screen has one too. */
  const paneSize = useCallback(
    (tabId: string): { w: number; h: number } => {
      const g = groupOf(stateRef.current.groups, tabId)
      if (!g) return { w: area.width, h: area.height }
      const r = rectsOf(g.root).panes.find((p) => p.tab === tabId)
      return r ? { w: r.w * area.width, h: r.h * area.height } : { w: area.width, h: area.height }
    },
    [area]
  )
  /** Why a split of `tabId` on `edge` cannot be made here, or undefined (D5: the menu disables it with this). */
  const splitBlocked = useCallback(
    (tabId: string, edge: PaneEdge): string | undefined => {
      if (area.width === 0) return undefined
      return splitFits(paneSize(tabId), edge, cellNow()) ? undefined : TOO_SMALL_TO_SPLIT
    },
    [area, cellNow, paneSize]
  )
  // Split right / down: the New tab menu at the new pane's place (D13), with a preview of it.
  const [splitMenu, setSplitMenu] = useState<SplitMenu | null>(null)
  const openSplit = useCallback(
    (anchor: string, edge: 'right' | 'down'): void => {
      const blocked = splitBlocked(anchor, edge)
      if (blocked) {
        setError(blocked)
        return
      }
      if (stateRef.current.activeId !== anchor) pickTab(anchor)
      loadMenuCommands()
      // The menu sits in the middle of where the new pane will be.
      const host = document.querySelector<HTMLElement>('[data-split-area]')?.getBoundingClientRect()
      const g = groupOf(stateRef.current.groups, anchor)
      const r = (g && rectsOf(g.root).panes.find((p) => p.tab === anchor)) || { x: 0, y: 0, w: 1, h: 1 }
      const pre = edgePreview(r, edge)
      const x = (host?.left ?? 0) + (pre.x + pre.w / 2) * (host?.width ?? 0) - 90
      const y = (host?.top ?? 0) + (pre.y + pre.h / 2) * (host?.height ?? 0) - 60
      setSplitMenu({ anchor, edge, x: Math.max(8, x), y: Math.max(8, y) })
    },
    [splitBlocked, pickTab]
  )
  const createInPane = (menu: SplitMenu, choice: NewPaneChoice): void => {
    rememberSplitChoice(props.project?.id, choice)
    setSplitMenu(null)
    const beside = { tabId: menu.anchor, edge: menu.edge }
    const req = choice.kind === 'command' ? { kind: 'command' as const, level: choice.level, entryId: choice.entryId, beside } : { kind: choice.kind, beside }
    run(
      window.cockpit.invoke('tabs.create', req).then((tab) => {
        // null: a command entry that opens as an overlay after all (main decides); nothing to place.
        if (tab) addPicked(tab)
      })
    )
  }
  // New tab in Group (design-split-pages.md §4): the tab opens beside the focused pane with no menu,
  // placed by main in the same step as the menu choice of Split Right / Down; plain with no `beside`.
  const createBeside = (what: NewTabKind, beside?: { tabId: string; edge: 'right' | 'down' }): void =>
    run(
      window.cockpit.invoke('tabs.create', beside ? { ...what, beside } : what).then((tab) => {
        // null: a command entry that opens as an overlay after all (main decides); nothing to place.
        if (tab) addPicked(tab)
      })
    )
  // Show Tab Beside… (palette): pick a tab; it goes beside the focused pane.
  const [besidePick, setBesidePick] = useState<{ edge: 'right' | 'down' } | null>(null)
  const besideItems = useMemo((): CommandInfo[] => {
    if (!besidePick) return []
    return state.tabs
      .filter((t) => t.id !== state.activeId && isPaneKind(t.kind))
      .map((t) => ({ id: t.id, title: tabLabel(t, own.get(t.id)?.title, own.get(t.id)?.name), source: 'core' as const }))
  }, [besidePick, state.tabs, state.activeId, own])

  // The strip's "+": main shows the project picker, or focuses the one already open.
  // The web shell has no host picker to show (`projects.showPicker` is `no`-class): its "+" goes to
  // the web picker, the list of the project windows open on the desktop (web/picker.tsx).
  const openProject = (): void => {
    if (isWebShell()) location.assign('/')
    else run(window.cockpit.invoke('projects.showPicker'))
  }

  // A drag on the strip, or the tab menu's Move left / right. The local order changes only once
  // main accepted it, so the strip never shows an order main doesn't have.
  const reorder = (tabId: string, toIndex: number): void =>
    run(
      window.cockpit.invoke('tabs.reorder', { tabId, toIndex }).then(() => {
        dispatch({ type: 'moved', tabId, toIndex })
      })
    )

  // The tab menu's Rename. main checks the name; the new one reaches the strip with the next
  // sessions snapshot, so nothing changes here.
  const rename = (tabId: string, name: string | null): void =>
    run(window.cockpit.invoke('tabs.rename', { tabId, name }))

  // The person's flag (tab menu, Toggle Tab Flag command). main checks the patch and answers the flag as
  // it stored it (note cleaned, colour filled in), which is what the strip then shows.
  const flag = (tabId: string, patch: FlagPatch | null): void =>
    run(
      window.cockpit.invoke('tabs.flag', { tabId, flag: patch }).then((stored) => {
        dispatch({ type: 'flagged', tabId, flag: stored })
      })
    )
  const toggleFlag = (tabId: string): void =>
    run(
      window.cockpit.invoke('tabs.toggleFlag', { tabId }).then((stored) => {
        dispatch({ type: 'flagged', tabId, flag: stored })
      })
    )

  const move = (tabId: string, delta: -1 | 1): void => {
    const from = state.tabs.findIndex((t) => t.id === tabId)
    if (from < 0) return
    reorder(tabId, Math.max(0, Math.min(state.tabs.length - 1, from + delta)))
  }

  // main refused a close for unsaved changes this view did not know of yet: the page tab's question,
  // unless something else is up over the window (then dropped, as requestClose drops it).
  const askUnsaved = (tabId: string, done?: CloseDone): void => {
    const tab = stateRef.current.tabs.find((t) => t.id === tabId)
    if (!tab || confirmFor.current !== null || settingsShown.current || overlayOpen.current) {
      done?.(false, true)
      return
    }
    confirmFor.current = tabId
    confirmDone.current = done ?? null
    confirmAsk.current = null
    setConfirm(unsavedQuestion(tab))
  }

  // Every close the USER starts (×, the tab menu, Close Tab by key or palette, the exited banner)
  // comes here; main's own closes (a clean exit, a plugin) never do. A tab with nothing running
  // closes at once; for a running one the setting is read from main at each close (a change made in
  // another window applies too), and a failed read asks, the safe side.
  //
  // A plugin's ctx.sessions.close comes here too (`sessions.closeAsk`), so it can never close a
  // running tab the person would have been asked about: `done` hears whether the tab closed, false
  // for every way the request is dropped or cancelled.
  //
  // `askId`: the plugin close ask this answers (shared with the window's other views); dropped
  // without an answer once main settled it, since another view answered first. For an ask this view
  // never closes the tab: its Close is only the answer (`done(true)`), and main closes the tab once
  // that answer wins (close-asks.ts), so a Close racing another view's Cancel cannot kill the process.
  const requestClose = (tabId: string, done?: CloseDone, askId?: string): void => {
    if (confirmFor.current !== null) {
      done?.(false, true)
      return
    }
    const finish = (): void => {
      if (askId === undefined) close(tabId, done)
      else done?.(true)
    }
    const tab = stateRef.current.tabs.find((t) => t.id === tabId)
    // An ask for a tab this view does not hold is declined, never answered Close: "not here" is not
    // "not running". It comes here only once waiting cannot help: replayed before the list (asked
    // after it, the tab is gone), or a live ask whose tab never reached the strip (close-ask-wait.ts).
    if (!tab && askId !== undefined) {
      done?.(false, true)
      return
    }
    // This view's own page said it is dirty (page-frames.ts): main's TabInfo.dirty for it may not be
    // back yet (typed, then closed at once), and a close that did not ask would drop the text.
    const dirtyHere = (id: string): boolean => pageFrames().isDirty(id)
    if (!tab || !closeMayAsk(tab, tab.kind === 'page' && dirtyHere(tabId))) {
      finish()
      return
    }
    window.cockpit
      .invoke('settings.confirmTabClose')
      .catch(() => true)
      .then((enabled) => {
        // Another view answered the ask during the round trip: nothing is left to do here.
        if (askId !== undefined && !liveAsks.current.has(askId)) return
        // What changed during the round trip: a screen or overlay opened over the window (the
        // request is dropped rather than asked under it), another dialog opened, the tab went or
        // its process ended (read again: an exited tab no longer asks).
        if (confirmFor.current !== null || settingsShown.current || overlayOpen.current) {
          done?.(false, true)
          return
        }
        const now = stateRef.current.tabs.find((t) => t.id === tabId)
        if (!now) {
          // Declined, not answered: with several views another one may be about to confirm.
          done?.(false, true)
          return
        }
        const question = closeQuestion(now, ownRef.current.get(tabId)?.status, enabled, now.kind === 'page' && dirtyHere(tabId))
        if (!question) {
          finish()
          return
        }
        // Set before the render, as settingsShown is: a focus frame queued just before (the palette
        // closing as it runs Close Tab) must find the dialog up and leave the terminal alone.
        confirmFor.current = tabId
        confirmDone.current = done ?? null
        confirmAsk.current = askId ?? null
        setConfirm(question)
      })
      .catch((err: unknown) => {
        done?.(false, true)
        setError(ipcErrorMessage(err))
      })
  }

  // Commands (Task 11). Main resolves the key table; the handlers below act through the same tab
  // IPC as the buttons, so the router's project scoping applies to keys and palette alike.
  // main closed a tab on this view's winning Close answer (close-asks.ts): drop it as `close` does.
  const dropClosed = (tabId: string): void => {
    sessions.dispose(tabId)
    dispatch({ type: 'closed', tabId })
  }
  const actions = useRef({ create, createCommand, createBeside, paneSize, splitBlocked, close: requestClose, closeNow: close, toggleFlag, dropClosed })
  useEffect(() => {
    ownRef.current = own
    actions.current = { create, createCommand, createBeside, paneSize, splitBlocked, close: requestClose, closeNow: close, toggleFlag, dropClosed }
    paletteOpen.current = paletteCommands !== null || besidePick !== null || splitMenu !== null
    settingsShown.current = settingsOpen
  })
  // A plugin's ctx.sessions.close (main's `sessions.closeAsk`): the person's own close path, the
  // dialog included, and main hears the outcome. A failed answer only logs: main's wait ends anyway.
  // Every view of the window is asked and the first answer wins (close-asks.ts); main's
  // `sessions.closeSettled` then takes this view's dialog down, unanswered, if it is still up.
  //
  // A view that joins or reconnects mid-ask gets the ask replayed before its `tabs.list` reply: the
  // ask waits for the list (`asksBeforeList`), so it is asked about the tab as it really is. A live
  // ask (`mayWait`) for a tab not in the strip yet waits for it instead (`unlistedAsks`): a plugin's
  // close right after its open must close the tab, as it did before the asks were shared.
  useEffect(() => {
    const live = liveAsks.current
    const waiting = asksBeforeList.current
    const unlisted = new UnlistedCloseAsks((requestId, tabId) => run(requestId, tabId, false))
    unlistedAsks.current = unlisted
    const run = (requestId: string, tabId: string, mayWait: boolean): void => {
      // Settled while it waited for the list or the tab.
      if (!live.has(requestId)) return
      if (mayWait && !stateRef.current.tabs.some((t) => t.id === tabId)) {
        unlisted.park(requestId, tabId)
        return
      }
      actions.current.close(
        tabId,
        (closed, declined, discard) => {
          // Settled meanwhile (another view answered): main would ignore this answer anyway.
          if (!live.delete(requestId)) return
          // Without `discard` (no dialog was shown here) main still refuses a page tab it holds unsaved.
          const answer = declined === true ? { requestId, closed, declined: true } : discard === true ? { requestId, closed, discard: true } : { requestId, closed }
          window.cockpit.invoke('sessions.closeAnswer', answer).then(
            (accepted) => {
              // main closed the tab on this Close (it won the ask): drop it here too.
              if (closed && declined !== true && accepted) actions.current.dropClosed(tabId)
            },
            (err: unknown) => {
              console.warn('answering a plugin close failed', err)
            }
          )
        },
        requestId
      )
    }
    runAsk.current = run
    const offAsk = window.cockpit.on('sessions.closeAsk', ({ requestId, tabId }) => {
      if (live.has(requestId)) return
      live.add(requestId)
      if (stateRef.current.listed) run(requestId, tabId, true)
      else waiting.push({ requestId, tabId })
    })
    const offSettled = window.cockpit.on('sessions.closeSettled', ({ requestId }) => {
      live.delete(requestId)
      if (confirmAsk.current !== requestId || confirmDone.current === null) return
      confirmAsk.current = null
      confirmDone.current = null
      confirmFor.current = null
      setConfirm(null)
    })
    return () => {
      offAsk()
      offSettled()
      live.clear()
      waiting.length = 0
      unlisted.clear()
      unlistedAsks.current = null
      runAsk.current = null
    }
  }, [])
  // The tab list came: the asks that arrived before it are asked now, oldest first.
  useEffect(() => {
    if (!state.listed) return
    const waiting = asksBeforeList.current.splice(0)
    for (const { requestId, tabId } of waiting) runAsk.current?.(requestId, tabId, false)
  }, [state.listed])
  // A tab reached the strip: the live asks waiting for it are asked now (stateRef is current: its
  // effect runs first in the same commit).
  useEffect(() => {
    unlistedAsks.current?.tabsChanged((tabId) => state.tabs.some((t) => t.id === tabId))
  }, [state.tabs])
  /**
   * Give the keyboard back to what the user was in once a palette or overlay goes: the settings
   * screen while it is shown, else the active terminal. Decided when the frame fires, never when
   * it is queued: "Open Settings" in the palette closes the palette (queuing this) before it opens
   * the settings screen, and focusing the terminal then would send the user's next keys (y, Enter)
   * to a Claude session hidden under the screen, where they could answer a permission prompt.
   * Likewise a palette or overlay that opened in between keeps the focus: the frame queued as the
   * settings screen closed (Esc) would otherwise blur a palette opened right after, closing it.
   */
  const focusActive = useCallback((): void => {
    // The close dialog keeps the focus on its own buttons until it is answered.
    if (paletteOpen.current || overlayOpen.current || confirmFor.current !== null || offerShown.current || discussShown.current) return
    if (settingsShown.current) {
      settingsRoot.current?.focus()
      return
    }
    // D3: the keys are off until the person clicks a pane or uses a chord.
    if (stateRef.current.keysOff) return
    const id = stateRef.current.activeId
    if (!id) return
    // A page tab has no terminal (sessions.get would make one): its frame takes the focus.
    if (stateRef.current.tabs.find((t) => t.id === id)?.kind === 'page') pageFrames().focus(id)
    else sessions.get(id).focus()
  }, [sessions])
  // The split menu went unpicked (Escape, a click elsewhere): the keyboard goes back to the pane.
  const closeSplitMenu = (): void => {
    setSplitMenu(null)
    requestAnimationFrame(focusActive)
  }
  // The tab menu and its editors took the keyboard; give it back once they are gone. In a frame,
  // like every other give-back here: an item's action (Close's dialog) may raise a modal first.
  const refocusAfterMenu = useCallback((): void => {
    requestAnimationFrame(focusActive)
  }, [focusActive])
  const setSwitcher = useCallback((next: SwitcherState | null): void => {
    switcherRef.current = next
    setSwitcherState(next)
  }, [])
  /** Close the switcher, selecting `pick` when given (a release, Enter, a click) or nothing (Esc, blur). */
  const endSwitcher = useCallback(
    (pick: string | undefined): void => {
      window.clearTimeout(showTimer.current)
      if (!switcherRef.current) return
      swallow.current = new Set(heldKeys.current)
      heldKeys.current.clear()
      setSwitcher(null)
      if (pick) pickTab(pick)
      requestAnimationFrame(focusActive)
    },
    [focusActive, setSwitcher, pickTab]
  )
  /**
   * A switch chord: open the switcher one step from the current tab, or step it when it is open.
   * `sticky` for a chord typed into a web panel's page, whose release this page may never see.
   */
  const switchTabs = useCallback(
    (dir: 1 | -1, sticky: boolean): void => {
      const open = switcherRef.current
      if (open) {
        setSwitcher({ ...open, index: step(open.index, open.order.length, dir) })
        return
      }
      const s = stateRef.current
      const order = s.activeId ? touchRecent(recent.current, s.activeId) : recent.current
      const mods = heldModifiers(chordOf(dir === 1 ? SWITCH_NEXT : SWITCH_PREV))
      const next = openSwitcher(s.tabs, order, dir, mods, sticky)
      if (!next) return
      setSwitcher(next)
      if (!next.shown) {
        showTimer.current = window.setTimeout(() => {
          const cur = switcherRef.current
          if (cur && !cur.shown) setSwitcher({ ...cur, shown: true })
        }, SHOW_DELAY_MS)
      }
    },
    [setSwitcher]
  )
  // A modal that came up on its own while switching (a close question whose setting read was still
  // on the way, the ccc offer, the settings screen): the switcher goes, or its keys would answer
  // the modal's buttons and a release would switch tabs behind it.
  useEffect(() => {
    if (confirm !== null || cccOffer !== null || discussOpen || settingsOpen) endSwitcher(undefined)
  }, [confirm, cccOffer, discussOpen, settingsOpen, endSwitcher])
  // A tab closed or added while the switcher is open: keep the list to the tabs that exist, the
  // highlight on the same tab where it can be, and give up when nothing is left to switch to.
  useEffect(() => {
    const open = switcherRef.current
    if (!open) return
    const ids = new Set(state.tabs.map((t) => t.id))
    const order = open.order.filter((id) => ids.has(id))
    if (order.length === open.order.length) return
    if (order.length < 2) {
      endSwitcher(undefined)
      return
    }
    const at = order.indexOf(open.order[open.index] ?? '')
    setSwitcher({ ...open, order, index: at >= 0 ? at : Math.min(open.index, order.length - 1) })
  }, [state.tabs, endSwitcher, setSwitcher])
  const closePalette = useCallback((): void => {
    setPaletteCommands(null)
    // The palette took the focus; give it back to the terminal the user was in.
    requestAnimationFrame(focusActive)
  }, [focusActive])
  const openSettings = useCallback((): void => {
    settingsShown.current = true
    setPaletteCommands(null)
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback((): void => {
    settingsShown.current = false
    setSettingsOpen(false)
    setSettingsTarget(null)
    requestAnimationFrame(focusActive)
  }, [focusActive])
  // A panel's gear: Settings at that plugin. Nothing else can be on top (the zones are inert while
  // the screen shows), so a request while it is already open is ignored.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const target = targetOf(e)
      if (!target || settingsShown.current) return
      setSettingsTarget(target)
      openSettings()
    }
    window.addEventListener(OPEN_PLUGIN_SETTINGS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PLUGIN_SETTINGS_EVENT, onOpen)
  }, [openSettings])
  // The one toggle behind both the app.openSettings command and the top strip's gear.
  const toggleSettings = useCallback((): void => {
    if (settingsShown.current) closeSettings()
    else openSettings()
  }, [closeSettings, openSettings])
  // Whether an overlay covers the window, as state: what is under it is made inert (see the JSX).
  const [covered, setCovered] = useState(false)
  const overlaysChanged = useCallback((count: number): void => {
    overlayOpen.current = count > 0
    // An overlay (opened by the CLI or a plugin) covers everything, the palette included: close
    // it rather than leave it under the overlay, where it would still hold Esc and the focus.
    if (count > 0) setPaletteCommands(null)
    // And the tab switcher, which would otherwise pick a tab under the overlay on release.
    if (count > 0) endSwitcher(undefined)
    // Likewise the close dialog: dismissed as a Cancel (the tab stays), never answered blind. For
    // a plugin's close it is a decline, not the person's Cancel (close-asks.ts).
    if (count > 0) {
      confirmFor.current = null
      setConfirm(null)
      settleClose(confirmDone, false, true)
    }
    setCovered(count > 0)
  }, [endSwitcher])
  /** The answer to Close all: every member still here closes, as the person's own closes. */
  const answerGroupClose = (q: CloseQuestion, choice: 'close' | 'cancel', dontAskAgain: boolean): void => {
    const { close: doClose, stopAsking } = closeAnswer(choice, dontAskAgain)
    confirmFor.current = null
    setConfirm(null)
    if (stopAsking) {
      window.cockpit.invoke('settings.confirmTabCloseSet', { value: false }).catch((err: unknown) => setError(ipcErrorMessage(err)))
    }
    if (!doClose || !q.group) return
    // `discard` for exactly the unsaved members the question listed; the rest close plainly, so one
    // main still holds unsaved (dirty in another view) is refused and asked about alone.
    const discard = new Set(q.group.unsaved)
    for (const id of q.group.tabIds) if (stateRef.current.tabs.some((t) => t.id === id)) actions.current.closeNow(id, undefined, discard.has(id))
  }
  const answerClose = useCallback(
    (tabId: string, choice: 'close' | 'cancel', dontAskAgain: boolean): void => {
      const { close: doClose, stopAsking } = closeAnswer(choice, dontAskAgain)
      confirmFor.current = null
      setConfirm(null)
      if (stopAsking) {
        window.cockpit
          .invoke('settings.confirmTabCloseSet', { value: false })
          .catch((err: unknown) => setError(ipcErrorMessage(err)))
      }
      const ask = confirmAsk.current
      confirmAsk.current = null
      // A plugin's ask: Close is only this view's answer, main closes the tab if it wins (close-asks.ts).
      // `discard`: asked and answered Close, so main closes it even with unsaved changes (as below).
      if (doClose && ask !== null) settleClose(confirmDone, true, false, true)
      else if (doClose) {
        const done = confirmDone.current ?? undefined
        confirmDone.current = null
        // Asked and answered Close: main closes it even with unsaved changes (`discard`).
        actions.current.closeNow(tabId, done, true)
      } else settleClose(confirmDone, false)
    },
    []
  )
  // The close dialog went (answered, its tab gone, an overlay over it) and took the focus with it:
  // give it back from an effect, after the commit that lifted `inert` (as for overlays below).
  const wasConfirming = useRef(false)
  useEffect(() => {
    if (wasConfirming.current && confirm === null) requestAnimationFrame(focusActive)
    wasConfirming.current = confirm !== null
  }, [confirm, focusActive])
  const wasDiscussing = useRef(false)
  useEffect(() => {
    if (wasDiscussing.current && !discussOpen) requestAnimationFrame(focusActive)
    wasDiscussing.current = discussOpen
  }, [discussOpen, focusActive])
  // The shown page tab's page asked for Ask Claude (page-frames.ts takes it only from the frame on
  // screen with the keyboard). Not over another modal, only for the tab this view shows now, and not
  // right after the person cancelled that tab's box (a page asking on every focus would reopen it as
  // the frame gets the keyboard back, and its backdrop would lock the window).
  const discussCooldown = useRef(new DiscussCooldown())
  useEffect(
    () =>
      setPageTabDiscussHandler((tabId) => {
        const modalUp =
          paletteOpen.current || overlayOpen.current || settingsShown.current || confirmFor.current !== null || offerShown.current || discussShown.current
        // `activeId: tabId`: PageTabArea asks only after checkFrameFocus found this tab's visible frame
        // holding the keyboard and picked its pane (the second of two files the person clicked into);
        // that selection reaches stateRef at the next effect, so the stale activeId (the first file)
        // must not refuse it. With the keys off the check blurs the frame and never asks.
        if (!discussMayOpen(tabId, { modalUp, switcherUp: switcherRef.current !== null, activeId: tabId }, discussCooldown.current)) return
        discussShown.current = true
        setDiscussFor(lastClaude.current === undefined ? { tabId } : { tabId, preferred: lastClaude.current })
      }),
    []
  )
  // A frame took the keyboard (design-split-pages.md §4, checkFrameFocus): with the person's evidence
  // its pane is picked as their own act (the outline and `tabs.selected` follow, D18's keys on);
  // without, the frame is blurred and the keyboard goes to nothing, never "back to the focused pane"
  // (often a Claude terminal) nor to where the person typed last (frame-focus.ts). `pick` is only
  // ever called with the tab of a frame holding the keyboard, a page tab, never a terminal.
  useEffect(
    () =>
      setFrameFocusHandler({
        activeId: () => (stateRef.current.keysOff ? null : stateRef.current.activeId),
        pick: (tabId) => dispatch({ type: 'selected', tabId })
      }),
    []
  )
  const wasOffering = useRef(false)
  useEffect(() => {
    if (wasOffering.current && cccOffer === null) requestAnimationFrame(focusActive)
    wasOffering.current = cccOffer !== null
  }, [cccOffer, focusActive])
  // The last overlay went and took the focused element with it (focus is on body, where Esc
  // reaches nothing): the keyboard goes back to the settings screen when it is under it (a cli
  // login runs over it), else to the tab the user was in. Queued from an effect, after the commit
  // that lifted `inert` from them: focus() on an inert element does nothing, and queued straight
  // from overlaysChanged the frame could fire before React re-rendered.
  const wasCovered = useRef(false)
  useEffect(() => {
    if (wasCovered.current && !covered) requestAnimationFrame(focusActive)
    wasCovered.current = covered
  }, [covered, focusActive])
  // Each of these is drawn by this page above the zones, where a webview panel's native view would
  // paint over it: the views hide while any is up (shell-layers.ts). An overlay main also hides
  // them for on its own (it knows the stack first); the palette and the dialogs only this page sees.
  useShellLayer(
    settingsOpen ||
      covered ||
      confirm !== null ||
      cccOffer !== null ||
      discussOpen ||
      paletteCommands !== null ||
      besidePick !== null ||
      splitMenu !== null ||
      switcher?.shown === true
  )
  // Cmd+Shift+W closes the top core overlay, and with only the settings screen open that is the
  // screen. An overlay opened over it claims the chord on top of this; the handler stack in
  // keybindings.ts gives it back here when that overlay goes.
  useEffect(() => {
    if (!settingsOpen) return
    return registerHandlers({ 'overlay.closeTop': closeSettings })
  }, [settingsOpen, closeSettings])

  useEffect(() => {
    const select = (n: number) => (): void => {
      const tab = stateRef.current.tabs[n - 1]
      if (tab) pickTab(tab.id)
    }
    const selects: Record<string, () => void> = {}
    for (let n = 1; n <= 9; n++) selects[`tab.select.${n}`] = select(n)
    const off = registerHandlers({
      ...selects,
      [SWITCH_NEXT]: () => switchTabs(1, !fromKey.current),
      [SWITCH_PREV]: () => switchTabs(-1, !fromKey.current),
      'tab.newClaude': () => actions.current.create('claude'),
      'tab.newShell': () => actions.current.create('shell'),
      // Close Tab and the flag chord, for the frame's tab when a frame's chord names one (D23 R1 keys off).
      ...activeTabHandlers({
        state: () => stateRef.current,
        close: (id) => actions.current.close(id),
        toggleFlag: (id) => actions.current.toggleFlag(id)
      }),
      'palette.open': () => {
        setPaletteCommands((open) => (open ? null : runnableCommands()))
      },
      'app.openSettings': toggleSettings,
      'app.openFolder': () => {
        window.cockpit.invoke('projects.openFolder').catch(() => {})
      }
    })
    const allowed = (id: string): boolean =>
      commandAllowed(id, {
        confirming: confirmFor.current !== null || offerShown.current || discussShown.current,
        paletteOpen: paletteOpen.current,
        overlayOpen: overlayOpen.current,
        settingsShown: settingsShown.current
      })
    // Capture phase on window: a bound chord is taken before the focused element (xterm's hidden
    // textarea included) sees it; an unbound key is not touched and goes to the terminal as usual.
    const onKey = (e: KeyboardEvent): void => {
      // While the switcher is open every key is its own: none may reach the terminal under it (an
      // Enter meant to pick a tab must not answer a Claude prompt), nor fire another command.
      if (swallow.current.has(e.code)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const open = switcherRef.current
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        if (!MODIFIER_KEYS.has(e.key)) heldKeys.current.add(e.code)
        const id = commandForEvent(e)
        if (id === SWITCH_NEXT || id === SWITCH_PREV) switchTabs(id === SWITCH_NEXT ? 1 : -1, false)
        else if (e.key === 'Escape') endSwitcher(undefined)
        else if (e.key === 'Enter') endSwitcher(open.order[open.index])
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          setSwitcher({ ...open, index: step(open.index, open.order.length, e.key === 'ArrowDown' ? 1 : -1) })
        }
        return
      }
      if (e.isComposing || e.defaultPrevented) return
      const id = commandForEvent(e)
      if (!id) return
      // Esc belongs to the palette while it is open (its field closes it); taking it here for
      // "pop the top overlay" would leave the palette stuck open. Likewise the close dialog's.
      if ((paletteOpen.current || confirmFor.current !== null || offerShown.current || discussShown.current) && id === 'overlay.pop') return
      e.preventDefault()
      e.stopPropagation()
      // Holding Cmd+T must not open a tab per repeat. A held Ctrl+Tab steps through the tabs, as
      // in a browser.
      if (allowed(id) && (!e.repeat || id === SWITCH_NEXT || id === SWITCH_PREV)) {
        fromKey.current = true
        try {
          runCommand(id)
        } finally {
          fromKey.current = false
        }
        // The chord that opened the switcher is down too: its Tab may outlast the Ctrl.
        if (switcherRef.current) heldKeys.current.add(e.code)
        // A pane chord may have moved the keys to another terminal: the chord's key, held on
        // (an arrow auto-repeating after Ctrl and Alt came up), must not reach it.
        if (id.startsWith('pane.')) swallow.current.add(e.code)
      }
    }
    window.addEventListener('keydown', onKey, true)
    // Letting go of the chord's modifier picks the highlighted tab (a keyup reports the state
    // after the release). A switcher the user took to with the mouse waits for a click instead.
    const onKeyUp = (e: KeyboardEvent): void => {
      heldKeys.current.delete(e.code)
      swallow.current.delete(e.code)
      const open = switcherRef.current
      if (open && !open.sticky && released(open.mods, e)) endSwitcher(open.order[open.index])
    }
    window.addEventListener('keyup', onKeyUp, true)
    // The window lost the keyboard mid-switch (Alt+Tab to another app): the release will never
    // come here, so nothing is picked.
    const onBlur = (): void => {
      endSwitcher(undefined)
      // No keyup reaches a window without the keyboard: nothing is held any more.
      swallow.current.clear()
    }
    window.addEventListener('blur', onBlur)
    // A chord typed into a webview panel's page or a page tab's frame, resolved by main (auto-repeats
    // never come). main names no tab, so the shell reads which frame has the keyboard now
    // (checkFrameFocus, design-split-pages.md §4): a page frame of a visible pane holding it is the
    // chord's target, picked as the focused pane when it was not; one holding it with no evidence of
    // the person is blurred and the chord dropped (frame-focus.ts chordTarget). A webview panel's page
    // holds the keyboard outside the shell's document (`document.hasFocus()` false): no frame, no target.
    const offTrigger = window.cockpit.on('commands.trigger', ({ id }) => {
      // Not fromKey: a switch chord from a web panel's page opens the switcher sticky, since the
      // modifier may be up before the chord got here.
      if (typeof id !== 'string' || !allowed(id)) return
      const target = chordTarget(checkFrameFocus())
      if (target) runCommand(id, target)
    })
    // The web shell's page tabs forward the app's chords themselves (page-frames.ts, PageTabArea.tsx:
    // already checked to come from the frame with the keyboard, which names its tab): the same gate.
    const offForwarded = setForwardedRunner((id, ctx) => {
      if (allowed(id)) runCommand(id, ctx)
    })
    // Plugin commands run in this window's plugin host, through main; they come and go with the
    // plugins (registered after the host activates, gone when it stops): `commands.updated`. The
    // new-tab menu entries likewise come and go as Settings edits them; theirs open a tab here.
    // Both run through runCommand, so the modal checks above (overlay, settings screen, palette,
    // close dialog) hold for them as for every other chord.
    let offPlugin = (): void => {}
    // The first `commands.list` answer and a `commands.updated` event may arrive in either order:
    // once an update was applied the list answer is an older snapshot and must not replace it
    // (its key table and plugin handlers would be stale until the next change). Also set on
    // unmount, so a late answer registers no handlers nobody will remove.
    let updated = false
    const applyCommands = (view: CommandsView): void => {
      setCommands(view)
      offPlugin()
      offPlugin = registerHandlers({
        ...pluginCommandHandlers(view, (id) => {
          window.cockpit.invoke('commands.run', { id }).catch((err: unknown) => console.warn(`command ${id} failed`, err))
        }),
        ...tabCommandHandlers(view, (level, entryId) => actions.current.createCommand(level, entryId)),
        ...inGroupHandlers(view, {
          state: () => stateRef.current,
          paneSize: (tabId) => actions.current.paneSize(tabId),
          fits: (tabId, edge) => actions.current.splitBlocked(tabId, edge) === undefined,
          create: (what, beside) => actions.current.createBeside(what, beside),
          report: setError
        })
      })
    }
    const offUpdated = window.cockpit.on('commands.updated', (view) => {
      updated = true
      applyCommands(view)
    })
    window.cockpit
      .invoke('commands.list')
      .then((view) => {
        if (!updated) applyCommands(view)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
    return () => {
      updated = true
      off()
      offTrigger()
      offForwarded()
      offUpdated()
      offPlugin()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      window.clearTimeout(showTimer.current)
    }
  }, [closeSettings, openSettings, toggleSettings, switchTabs, endSwitcher, setSwitcher, pickTab])

  // The split view's commands (D10). They read the state through refs, like the handlers above, and
  // act through the same group channels as the strip's menus.
  const paneActions = useRef({ openSplit, groupEdit, ungroup, area, cellNow })
  useEffect(() => {
    paneActions.current = { openSplit, groupEdit, ungroup, area, cellNow }
  })
  useEffect(
    () =>
      registerHandlers(
        paneCommandHandlers({
          state: () => stateRef.current,
          view: () => viewRef.current,
          dispatch,
          place: (intent) => paneActions.current.groupEdit(window.cockpit.invoke('groups.place', intent), intent.tabId),
          remove: (tabId) => paneActions.current.groupEdit(window.cockpit.invoke('groups.remove', { tabId }), tabId),
          dissolve: (groupId) => paneActions.current.ungroup(groupId),
          resize: (groupId, splitId, sizes) => paneActions.current.groupEdit(window.cockpit.invoke('groups.resize', { groupId, splitId, sizes })),
          intend: (tabId, intent) => intents.current.set(tabId, intent),
          openSplit: (tabId, edge) => paneActions.current.openSplit(tabId, edge),
          openBeside: (tabId, edge) => {
            const s = stateRef.current
            // The focused tab is the anchor; the pick lists the other tabs (every kind is a pane).
            if (!s.tabs.some((t) => t.id === tabId)) return
            if (s.tabs.filter((t) => isPaneKind(t.kind)).length > 1) setBesidePick({ edge })
          },
          minShare: (axis) => {
            const { area: a, cellNow: c } = paneActions.current
            return dragMinShare(axis === 'row' ? a.width : a.height, axis, c())
          },
          report: setError
        })
      ),
    []
  )

  return (
    // `in-page-title-bar`: full-window layers (overlays, the settings screen) start under the bar,
    // so they never sit beneath the traffic lights and the window can still be dragged by it.
    <div className={`tabs-pane${inPageTitleBar ? ' in-page-title-bar' : ''}`}>
      {/* Inert under the settings screen and under an overlay: aria-modal alone does not stop Tab
          / Shift+Tab from walking out of the screen or an html overlay into the tab strip and the
          xterm textarea, where typed keys (y, Enter) would reach a terminal the user cannot see
          and could answer a Claude permission prompt. Also under the close dialog, whose Enter
          and Esc must never land in the terminal behind it. The palette and the overlay stack stay
          outside; the settings screen itself goes inert under an overlay (a cli login runs over
          it), and OverlayStack makes every overlay but the top one inert. */}
      <TopStrip
        {...(props.project ? { project: props.project } : {})}
        titleBar={inPageTitleBar}
        fullScreen={fullScreen}
        slots={layout.appSlots}
        onOpenProject={openProject} onOpenSettings={toggleSettings} inert={settingsOpen || covered || confirm !== null || cccOffer !== null || discussOpen} />
      {chrome.updateNotice && <UpdateNotice inert={settingsOpen || covered || confirm !== null || cccOffer !== null || discussOpen} />}
      <Zones controller={layout} inert={settingsOpen || covered || confirm !== null || cccOffer !== null || discussOpen}>
        <TabBar
          tabs={state.tabs}
          // D18: with the keys off no pane is focused, and no tab shows as the selected one either.
          activeId={state.keysOff ? null : state.activeId}
          onSelect={pickTab}
          onClose={requestClose}
          onCreate={create}
          onCreateCommand={createCommand}
          commands={menuCommands}
          onMenuOpen={loadMenuCommands}
          onMove={move}
          onRename={rename}
          onFlag={flag}
          onMenuClosed={refocusAfterMenu}
          onReorder={reorder}
          sessions={own}
          onCancelQueued={cancelQueued}
          groups={state.groups}
          zoom={view.group ? { groupId: view.group.id, ...(view.zoomTab !== undefined ? { zoomTab: view.zoomTab } : {}), auto: view.auto } : undefined}
          onSelectGroup={selectGroup}
          onRenameGroup={(groupId, name) => void groupEdit(window.cockpit.invoke('groups.rename', { groupId, name }))}
          onEqualizeGroup={equalizeGroup}
          onUngroup={ungroup}
          onCloseGroup={closeGroup}
          onMoveGroup={moveGroup}
          onDetach={detach}
          onPaneDrag={dragToPane}
          onPaneDrop={dropOnPane}
          splitBlocked={splitBlocked}
          onSplit={openSplit}
          onShowBeside={(tabId, at, edge) => placeTab(tabId, at, edge, true)}
          onMoveOut={(tabId) => {
            intents.current.set(tabId, 'leave')
            void groupEdit(window.cockpit.invoke('groups.remove', { tabId }), tabId)
          }}
        />
        {error && <p role="alert" className="tabs-error">{error}</p>}
        <SplitArea
          tabs={state.tabs}
          activeId={state.activeId}
          view={view}
          keysOff={state.keysOff}
          sessions={sessions}
          details={own}
          cell={cellNow}
          onArea={setArea}
          onPanePress={(tabId) => dispatch({ type: 'selected', tabId })}
          onResize={(groupId, splitId, sizes) =>
            groupEdit(window.cockpit.invoke('groups.resize', { groupId, splitId, sizes })).then((r) => r.ok)
          }
          onRestart={restart}
          onClose={requestClose}
          drop={splitMenu ? { at: splitMenu.anchor, edge: splitMenu.edge, label: labelOf(splitMenu.anchor) } : paneDrop}
          // SplitArea renders the page tabs' PageTabArea itself: it holds the tree and a live
          // divider drag's sizes, which place the frames (design-split-pages.md §2).
          listed={state.listed}
          inert={settingsOpen || covered || confirm !== null || cccOffer !== null || discussOpen}
        />
      </Zones>
      {paletteCommands && (
        <CommandPalette
          commands={paletteCommands}
          mac={navigator.platform.toLowerCase().includes('mac')}
          onRun={(id) => runCommand(id)}
          onClose={closePalette}
        />
      )}
      {besidePick && (
        <CommandPalette
          commands={besideItems}
          mac={navigator.platform.toLowerCase().includes('mac')}
          label={besidePick.edge === 'right' ? 'Show tab beside, on the right' : 'Show tab beside, below'}
          placeholder="Type a tab name"
          onRun={(tabId) => {
            const at = stateRef.current.activeId
            if (at && !stateRef.current.keysOff) placeTab(tabId, at, besidePick.edge, false)
          }}
          onClose={() => {
            setBesidePick(null)
            requestAnimationFrame(focusActive)
          }}
        />
      )}
      {splitMenu && (
        <NewPaneMenu
          menu={splitMenu}
          commands={menuCommands}
          initial={lastSplitChoice(props.project?.id)}
          onPick={(choice) => createInPane(splitMenu, choice)}
          onClose={closeSplitMenu}
        />
      )}
      {switcher?.shown && (
        <TabSwitcher
          tabs={switcher.order.flatMap((id) => state.tabs.find((t) => t.id === id) ?? [])}
          index={switcher.index}
          sessions={own}
          onPick={(tabId) => endSwitcher(tabId)}
          onHover={(index) => {
            const open = switcherRef.current
            // Reaching for a row with the mouse: a release of Ctrl no longer picks, the click does.
            if (open) setSwitcher({ ...open, index, sticky: true })
          }}
          onCancel={() => endSwitcher(undefined)}
        />
      )}
      {confirm && (confirm.unsaved || (confirm.group && confirm.group.unsaved.length > 0)) && isServerView() && (
        <CloseTabApproval
          key={confirm.tabId}
          question={confirm}
          onAnswer={(choice) => (confirm.group ? answerGroupClose(confirm, choice, false) : answerClose(confirm.tabId, choice, false))}
        />
      )}
      {confirm && !((confirm.unsaved || (confirm.group && confirm.group.unsaved.length > 0)) && isServerView()) && (
        <CloseTabDialog
          key={confirm.tabId}
          question={confirm}
          onAnswer={(choice, dontAskAgain) =>
            confirm.group ? answerGroupClose(confirm, choice, dontAskAgain) : answerClose(confirm.tabId, choice, dontAskAgain)
          }
        />
      )}
      {cccOffer && <CccOfferDialog view={cccOffer} onDone={() => setCccOffer(null)} />}
      {discussFor !== null && discussTab && (
        <PageTabDiscussDialog
          key={discussFor.tabId}
          tab={discussTab}
          claudeTabs={discussTabs}
          {...(discussFor.preferred !== undefined ? { lastClaudeTabId: discussFor.preferred } : {})}
          onClose={(sent) => {
            if (!sent) discussCooldown.current.cancelled(discussFor.tabId)
            discussShown.current = false
            setDiscussFor(null)
          }}
        />
      )}
      {settingsOpen && <SettingsOverlay target={settingsTarget} rootRef={settingsRoot} onClose={closeSettings} inert={covered} />}
      <OverlayStack onChange={overlaysChanged} discussTabs={discussTabs} activeTabId={state.activeId} />
    </div>
  )
}
