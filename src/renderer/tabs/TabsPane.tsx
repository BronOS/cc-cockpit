import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CccCommandView, ProjectSummary, TabCommandMenu, TabInfo } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
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
  tabCommandHandlers
} from '../commands/keybindings'
import { ipcErrorMessage } from '../ipc-error'
import { OverlayStack } from '../overlays/OverlayStack'
import { SettingsOverlay } from '../settings/SettingsOverlay'
import { initialTabsState, tabsReducer } from '../state/tabs-store'
import { otherWindowsEntries } from '../status/strip-order'
import { TopStrip } from '../status/TopStrip'
import { useSessions } from '../status/use-sessions'
import { isSeeThrough } from '../theme/see-through'
import { UpdateNotice } from '../updates/UpdateNotice'
import { useLayout } from '../zones/use-layout'
import { useShellLayer } from '../zones/use-shell-layer'
import { Zones } from '../zones/Zones'
import { closeAnswer, closeQuestion, tabIsRunning, type CloseQuestion } from './close-confirm'
import { CloseTabDialog } from './CloseTabDialog'
import { CccOfferDialog } from './CccOfferDialog'
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
import { TerminalView } from './TerminalView'

/**
 * `tabs.list` is the re-attach point after a page load and resets PTY flow control in main, so it
 * must run once per page load and never to refresh the list (with xterm saturated that would
 * resume a paused PTY). The promise is kept at module level so a React StrictMode remount in dev
 * reuses the one answer instead of asking twice.
 */
let attached: Promise<TabInfo[]> | undefined
function attachTabs(): Promise<TabInfo[]> {
  attached ??= window.cockpit.invoke('tabs.list')
  return attached
}

/** KeyboardEvent.key of the modifiers: not "held keys" the switcher swallows after it ends. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

/**
 * macOS project windows draw their own title bar (main hides the native one there:
 * main/windows/window-chrome.ts keys off the same platform). Read once: the platform does not change.
 */
const inPageTitleBar = navigator.platform.toLowerCase().includes('mac')

/** The project window's terminal tabs: tab bar plus one mounted terminal per tab. */
export function TabsPane(props: { project?: ProjectSummary; fullScreen?: boolean }): React.JSX.Element {
  // macOS hides the traffic lights in full screen; main tells the page when that changes (the
  // initial value comes with window.info, for a window restored in full screen).
  const [fullScreen, setFullScreen] = useState(props.fullScreen === true)
  useEffect(() => window.cockpit.on('window.state', (s) => setFullScreen(s.fullScreen)), [])
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState)
  // The window's zone layout, here rather than in Zones: the top bar draws the app's slot frames
  // (`appSlots`) that come with the same view.
  const layout = useLayout()
  // A see-through window's tab terminals let its glass through; overlays keep their own registry,
  // opaque (OverlayStack).
  const [sessions] = useState(() => new SessionRegistry(tabIo, { seeThrough: isSeeThrough() }))
  const [error, setError] = useState<string | null>(null)
  // The user entries of the [+] menu, read each time the menu opens (Settings may have changed them).
  const [menuCommands, setMenuCommands] = useState<TabCommandMenu | null>(null)
  const { snapshot, own } = useSessions()
  const [paletteCommands, setPaletteCommands] = useState<CommandInfo[] | null>(null)
  // The settings screen (Cmd+,): a core overlay drawn by the renderer itself (SettingsOverlay).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Tabs main closed (`tabs.removed`). A restart reply that lands after it must not touch the
  // tab's terminal: sessions.get would create a new one for a tab that is gone.
  const removed = useRef(new Set<string>())
  // Command handlers are registered once but must see the current tab state.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
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
    const offData = window.cockpit.on('tabs.data', ({ tabId, data }) => {
      sessions.write(tabId, data)
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
      }
      sessions.dispose(tabId)
      dispatch({ type: 'removed', tabId, gen })
    })
    // The user clicked this window's tab in a strip (here or in another window): main already
    // focused the window; only the selection is ours.
    const offSelect = window.cockpit.on('tabs.select', ({ tabId }) => {
      dispatch({ type: 'selected', tabId })
    })
    // A tab main started on its own (a plugin's ctx.sessions.open). One that arrives before the
    // list answered may or may not be in it (main takes the list after it awaits the restore):
    // 'loaded' merges by id and generation, so it is neither duplicated nor dropped.
    const offAdded = window.cockpit.on('tabs.added', (tab) => {
      dispatch({ type: 'announced', tab })
    })
    attachTabs()
      .then((tabs) => dispatch({ type: 'loaded', tabs }))
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
    return () => {
      offData()
      offExit()
      offRemoved()
      offSelect()
      offAdded()
      sessions.disposeAll()
    }
  }, [sessions])

  // main keeps the selection for plugins (SessionInfo.active: "the tab the person is looking
  // at"); every way it changes (a click, a key, a close, main's tabs.select, the first list) ends
  // in activeId, so this one effect reports them all. A failure is only logged: the selection here
  // is unaffected, and a plugin then sees the previous tab as active until the next change.
  useEffect(() => {
    if (state.activeId === null) return
    window.cockpit.invoke('tabs.selected', { tabId: state.activeId }).catch((err: unknown) => {
      console.warn('reporting the selected tab failed', err)
    })
  }, [state.activeId])

  const run = (action: Promise<unknown>): void => {
    setError(null)
    action.catch((err: unknown) => setError(ipcErrorMessage(err)))
  }

  const create = (kind: 'claude' | 'shell'): void =>
    run(
      window.cockpit.invoke('tabs.create', { kind }).then((tab) => {
        // Never null for Claude or Shell (only a command entry opens as an overlay).
        if (tab) dispatch({ type: 'added', tab })
      })
    )

  // A user entry: by level and id only, main looks the command up in its own settings. null: the
  // entry opens as an overlay, which arrives through `overlays.updated` like any other.
  const createCommand = (level: TabCommandLevel, entryId: string): void =>
    run(
      window.cockpit.invoke('tabs.create', { kind: 'command', level, entryId }).then((tab) => {
        if (tab) dispatch({ type: 'added', tab })
      })
    )

  const loadMenuCommands = (): void => {
    window.cockpit
      .invoke('tabs.commands')
      .then(setMenuCommands)
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
  }

  // The close itself, with no question: what a confirmed or unguarded close ends in.
  const close = (tabId: string): void =>
    run(
      window.cockpit.invoke('tabs.close', { tabId }).then(() => {
        sessions.dispose(tabId)
        dispatch({ type: 'closed', tabId })
      })
    )

  const restart = (tabId: string): void =>
    run(
      window.cockpit.invoke('tabs.restart', { tabId }).then((tab) => {
        if (removed.current.has(tabId)) return
        // Main respawned the PTY at its default size; send ours again.
        sessions.get(tabId).resetSize()
        dispatch({ type: 'restarted', tab })
      })
    )

  const cancelQueued = (tabId: string, itemId: string): void =>
    run(window.cockpit.invoke('sessions.cancelQueued', { tabId, itemId }))

  const focusTab = (tabId: string): void =>
    run(window.cockpit.invoke('sessions.focus', { tabId }))

  // The strip's "+": main shows the project picker, or focuses the one already open.
  const openProject = (): void => run(window.cockpit.invoke('projects.showPicker'))

  // A drag on the strip, or the tab menu's Move left / right. The local order changes only once
  // main accepted it, so the strip never shows an order main doesn't have.
  const reorder = (tabId: string, toIndex: number): void =>
    run(
      window.cockpit.invoke('tabs.reorder', { tabId, toIndex }).then(() => {
        dispatch({ type: 'moved', tabId, toIndex })
      })
    )

  const move = (tabId: string, delta: -1 | 1): void => {
    const from = state.tabs.findIndex((t) => t.id === tabId)
    if (from < 0) return
    reorder(tabId, Math.max(0, Math.min(state.tabs.length - 1, from + delta)))
  }

  // Every close the USER starts (×, the tab menu, Close Tab by key or palette, the exited banner)
  // comes here; main's own closes (a clean exit, a plugin) never do. A tab with nothing running
  // closes at once; for a running one the setting is read from main at each close (a change made in
  // another window applies too), and a failed read asks, the safe side.
  const requestClose = (tabId: string): void => {
    if (confirmFor.current !== null) return
    const tab = stateRef.current.tabs.find((t) => t.id === tabId)
    if (!tab || !tabIsRunning(tab)) {
      close(tabId)
      return
    }
    window.cockpit
      .invoke('settings.confirmTabClose')
      .catch(() => true)
      .then((enabled) => {
        // What changed during the round trip: a screen or overlay opened over the window (the
        // request is dropped rather than asked under it), another dialog opened, the tab went or
        // its process ended (read again: an exited tab no longer asks).
        if (confirmFor.current !== null || settingsShown.current || overlayOpen.current) return
        const now = stateRef.current.tabs.find((t) => t.id === tabId)
        if (!now) return
        const question = closeQuestion(now, ownRef.current.get(tabId)?.status, enabled)
        if (!question) {
          close(tabId)
          return
        }
        // Set before the render, as settingsShown is: a focus frame queued just before (the palette
        // closing as it runs Close Tab) must find the dialog up and leave the terminal alone.
        confirmFor.current = tabId
        setConfirm(question)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
  }

  // Commands (Task 11). Main resolves the key table; the handlers below act through the same tab
  // IPC as the buttons, so the router's project scoping applies to keys and palette alike.
  const actions = useRef({ create, createCommand, close: requestClose, closeNow: close })
  useEffect(() => {
    ownRef.current = own
    actions.current = { create, createCommand, close: requestClose, closeNow: close }
    paletteOpen.current = paletteCommands !== null
    settingsShown.current = settingsOpen
  })
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
    if (paletteOpen.current || overlayOpen.current || confirmFor.current !== null || offerShown.current) return
    if (settingsShown.current) {
      settingsRoot.current?.focus()
      return
    }
    const id = stateRef.current.activeId
    if (id) sessions.get(id).focus()
  }, [sessions])
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
      if (pick) dispatch({ type: 'selected', tabId: pick })
      requestAnimationFrame(focusActive)
    },
    [focusActive, setSwitcher]
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
    if (confirm !== null || cccOffer !== null || settingsOpen) endSwitcher(undefined)
  }, [confirm, cccOffer, settingsOpen, endSwitcher])
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
    requestAnimationFrame(focusActive)
  }, [focusActive])
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
    // Likewise the close dialog: dismissed as a Cancel (the tab stays), never answered blind.
    if (count > 0) {
      confirmFor.current = null
      setConfirm(null)
    }
    setCovered(count > 0)
  }, [endSwitcher])
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
      if (doClose) actions.current.closeNow(tabId)
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
    settingsOpen || covered || confirm !== null || cccOffer !== null || paletteCommands !== null || switcher?.shown === true
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
      if (tab) dispatch({ type: 'selected', tabId: tab.id })
    }
    const selects: Record<string, () => void> = {}
    for (let n = 1; n <= 9; n++) selects[`tab.select.${n}`] = select(n)
    const off = registerHandlers({
      ...selects,
      [SWITCH_NEXT]: () => switchTabs(1, !fromKey.current),
      [SWITCH_PREV]: () => switchTabs(-1, !fromKey.current),
      'tab.newClaude': () => actions.current.create('claude'),
      'tab.newShell': () => actions.current.create('shell'),
      'tab.close': () => {
        const id = stateRef.current.activeId
        if (id) actions.current.close(id)
      },
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
        confirming: confirmFor.current !== null || offerShown.current,
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
      if ((paletteOpen.current || confirmFor.current !== null || offerShown.current) && id === 'overlay.pop') return
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
    // A chord typed into a webview panel's page, resolved by main (auto-repeats never come).
    const offTrigger = window.cockpit.on('commands.trigger', ({ id }) => {
      // Not fromKey: a switch chord from a web panel's page opens the switcher sticky, since the
      // modifier may be up before the chord got here.
      if (typeof id === 'string' && allowed(id)) runCommand(id)
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
        ...tabCommandHandlers(view, (level, entryId) => actions.current.createCommand(level, entryId))
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
      offUpdated()
      offPlugin()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      window.clearTimeout(showTimer.current)
    }
  }, [closeSettings, openSettings, toggleSettings, switchTabs, endSwitcher, setSwitcher])

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
        entries={otherWindowsEntries(snapshot.strip, [...own.values()])}
        slots={layout.appSlots}
        onFocus={focusTab} onOpenProject={openProject} onOpenSettings={toggleSettings} inert={settingsOpen || covered || confirm !== null || cccOffer !== null} />
      <UpdateNotice inert={settingsOpen || covered || confirm !== null || cccOffer !== null} />
      <Zones controller={layout} inert={settingsOpen || covered || confirm !== null || cccOffer !== null}>
        <TabBar
          tabs={state.tabs}
          activeId={state.activeId}
          onSelect={(tabId) => dispatch({ type: 'selected', tabId })}
          onClose={requestClose}
          onCreate={create}
          onCreateCommand={createCommand}
          commands={menuCommands}
          onMenuOpen={loadMenuCommands}
          onMove={move}
          onReorder={reorder}
          sessions={own}
          onCancelQueued={cancelQueued}
        />
        {error && <p role="alert" className="tabs-error">{error}</p>}
        <div className="terminals">
          {state.tabs.length === 0 && (
            <p className="tabs-empty">No tabs yet. Use + to start Claude or a shell.</p>
          )}
          {state.tabs.map((tab) => (
            <TerminalView
              key={tab.id}
              tab={tab}
              active={tab.id === state.activeId}
              sessions={sessions}
              onRestart={() => restart(tab.id)}
              onClose={() => requestClose(tab.id)}
            />
          ))}
        </div>
      </Zones>
      {paletteCommands && (
        <CommandPalette
          commands={paletteCommands}
          mac={navigator.platform.toLowerCase().includes('mac')}
          onRun={(id) => runCommand(id)}
          onClose={closePalette}
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
      {confirm && (
        <CloseTabDialog
          key={confirm.tabId}
          question={confirm}
          onAnswer={(choice, dontAskAgain) => answerClose(confirm.tabId, choice, dontAskAgain)}
        />
      )}
      {cccOffer && <CccOfferDialog view={cccOffer} onDone={() => setCccOffer(null)} />}
      {settingsOpen && <SettingsOverlay rootRef={settingsRoot} onClose={closeSettings} inert={covered} />}
      <OverlayStack onChange={overlaysChanged} />
    </div>
  )
}
