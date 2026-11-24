# Terminal panel (design)

Status: designed (2026-11-24), decisions in §10. Not implemented.

Why: the person wants a quick console beside their work, as in VS Code's terminal panel or a quake console. Open it, run
something, close it while it runs, open it again and carry on where they left it. A split pane (`Split down` › Shell)
comes close, but it belongs to one tab group: switch tabs and it is gone. A shell tab in the strip is one more tab among
the Claude tabs. The terminal panel is a place for shells that stays put across tabs and costs one key to show or hide.

Decisions in one place:
- **One core panel, `core/terminal`, with its own strip of tabs.** It lives in a zone like any panel (bottom by default,
  movable to left or right, hideable), and its body is a strip of shell and command tabs over the selected one's terminal.
  It is the first panel core draws itself. One per project window.
- **Shell and command tabs only.** Claude and page tabs stay in the main tab area. A generic "any tab in any panel" model
  (tab containers) was considered and dropped: which tab a chord acts on across several tab areas confused even the person
  who asked for it (§9). Shells have no Claude status, send gate, Discuss, rooms or Ask Claude, so the panel needs none of
  that, and the key rules stay small (§6).
- **Panel tabs are ordinary tabs with one new field.** `TabRecord.dock?: 'panel'` (absent: the main tab area). The pty,
  the mirror worker, flow control, size ownership, restart and restore are the tab machinery unchanged. No second terminal
  implementation, no second pty owner.
- **Hiding is not closing.** Hiding the panel, collapsing its zone or moving it to another zone unmounts only the drawing.
  The ptys keep running; the renderer's `SessionRegistry` keeps each xterm (it outlives the views already) and acks
  output, so a chatty program never stalls. Showing the panel attaches the selected tab's xterm again, scrollback included.
- **The person moves tabs in and out.** "Move to Terminal panel" on a shell or command tab in the main strip, "Move to tab
  area" in the panel's strip. A move keeps the session. Plugins get no way to place, move or read `dock` (§7).
- **Guests do not see the panel or its tabs in v1** (§8). Fail closed; a later version may show it.
- **One toggle chord**, `` Ctrl+` `` by default (rebindable): show and focus, or hide and give the keys back (§6).

## 1. What the person sees

- **The panel**: a panel titled "Terminal" (icon: a prompt glyph) in the bottom zone's icon strip, closed at first. Its
  header is every panel's header (title, the zone menu: move to left / right / bottom, hide, move up / down / to top).
- **Its strip**: a compact row of the panel's tabs (name or label, the exit mark of an exited process, a ×) and a `+`.
  The `+` menu lists Shell and the custom commands of the new-tab menu (design.md §3 "Custom commands": the same levels
  and entries; an entry that opens as an overlay still opens as an overlay). Drag reorders within the strip. A tab's menu:
  Rename, Restart (an exited one), Move to tab area, Close.
- **Its body**: the selected tab's terminal, with the tabs' terminal font and theme. An empty panel shows "No terminals"
  and a Shell button.
- **The toggle** (`` Ctrl+` ``): the panel is not on screen (closed, hidden, its zone collapsed) → it is opened (its zone
  expanded, the panel made visible) and its selected tab focused; an empty panel gets a new shell first. It is on screen
  and has the keys → it is closed (its placement's `open: false`; the zone and the other panels in it stay) and the keys go
  back to the main area's selected tab. On screen without the keys → it takes the keys.
- **New terminal in panel** (`` Ctrl+Shift+` ``): a new shell in the panel, opened and focused.
- **In the main strip**: the tab menu of a shell or command tab gets "Move to Terminal panel". Nothing else in the main
  area changes; panel tabs do not appear in its strip, its tab count or `tab.select.N`.
- **A process that exits** in a panel tab behaves as it does in the main area (the tab stays with its exit mark until
  closed or restarted).

## 2. Data model

- `TabRecord.dock?: 'panel'` (`src/shared/types.ts`), saved by `tabRecordsOf` (`main/restore.ts`) and restored as saved.
  `TabInfo.dock` mirrors it to pages. Valid only for `kind` `shell` and `command`; a saved record with `dock` on another
  kind drops the field (the tab returns to the main area) rather than the tab.
- **One order.** `TabManager.order` stays the one tab order of the project. The main strip is the order without docked
  tabs; the panel strip is the order of docked tabs only. A reorder in either strip is a `tabs.reorder` naming tabs of that
  strip only; main refuses a reorder that mixes docked and undocked tabs.
- **Groups.** A docked tab is never in a split group: `TabGroups` refuses to place one (a new reason, `docked`, beside
  `not-a-pane`), and docking a grouped tab removes it from its group first (the group's usual remove: a group of two
  dissolves). `isPaneKind` is unchanged: a panel tab is still a pane kind, it is just not in the main area.
- **Selection.** `ViewSelections` keeps a second selection per view, `panelByView`, the panel's selected tab. The
  project-wide `activeTab` stays the main area's: a panel tab never becomes it, so nothing that follows the active tab
  (the sessions strip, `ccc` defaults, Discuss targets) ever lands on a panel shell.
- **The panel's placement** is a normal `PanelPlacement` under the key `core/terminal` in the saved layout. `core` has no
  dot, so it never matches `PLUGIN_ID_PATTERN` (`src/shared/manifest.ts`) and cannot collide with a plugin's panel key.

## 3. Channels

- `tabs.dock { tabId, dock: 'panel' | 'main' }` (invoke): the person's move. Main checks the kind, removes the tab from its
  group, sets the field, saves, and emits. `REMOTE_CLASS` `yes` (a browser view of the owner may move its own tabs, like
  `tabs.reorder`), `GUEST_CLASS` `no`.
- `tabs.create` gains `dock?: 'panel'` for `shell` and `command` requests. With `dock`, `beside` is refused (no groups in
  the panel). `byTabCreate` refuses `dock` for guests.
- `tabs.docked { tabId, dock }` (event, to the project's views): pages move the tab between strips. The main strip's
  selection, if it was the moved tab, moves to its neighbour as a close would. `GUEST_EVENT` `drop` (§8).
- `tabs.panelSelected` / `tabs.panelSelect`: the panel's selection, as `tabs.selected` / `tabs.select` are for the main
  area. Classes as theirs, `GUEST_CLASS` `no`.

## 4. Drawing and lifecycle

- **A core panel in the panel machinery.** Main adds `core/terminal` to `available()` in `layout-service.ts`, so
  `reconcile` keeps it, and sends a `PanelInfo` with a new kind `core` (no frame, no plugin). `PanelArea` draws the header
  as for any panel and, for kind `core`, a React body instead of `PluginPanel`: `TerminalPanelBody` (strip plus the
  attach point). `IconStrip`, `Zone` and the zone menu need nothing new beyond the icon. `pluginOfPanelKey`
  (`shared/guest-filter.ts`) and every walk of panel keys as plugin ids skip `core/` keys.
- **Terminals stay outside React.** `TerminalPanelBody` attaches the selected panel tab's `TerminalSession` from the
  renderer's `SessionRegistry` (`session.attach(container)`), and detaches it on unmount or when another tab is selected.
  The registry creates a session when the tab is added and disposes it when the tab is removed, never on a detach, so a
  hidden panel's shells keep their xterm, scrollback and acks. `SplitArea` skips docked tabs. Check in the plan that no
  path disposes a session on unmount (today every tab stays mounted, so that path may never have been needed).
- **Size.** A detached xterm measures 0x0, so a detached session sends no resize (the existing `shown()` guard in
  `terminal-session.ts`). While hidden, a panel tab keeps the size it had; showing it refits through the ResizeObserver and
  `tabs.resize`, under `view-sizes.ts` as for any tab (the panel view that shows it is a view of that key). A panel tab
  created while the panel is hidden spawns at the usual initial size (80x24; 120x40 in server mode) and refits when shown.
- **Flow.** Unchanged: `DesktopFlow` / `PtyService` pause at the high water, and the registry acks whether or not the
  xterm is attached. A hidden panel never pauses its programs.
- **Browser views.** The web shell is the same renderer, so it draws the panel too, with its own open or closed state per
  view as for every panel. `view-terminals.ts` follows the visible tabs of a browser view; a view showing the panel shows
  two terminals (the main area's and the panel's), as a split group already does. Check in the plan that the visible set
  is a set per view, not one tab.
- **Server mode.** The hidden page draws no panel (it draws nothing a person looks at); `WindowManager`'s server rules are
  untouched.
- **Restart and restore.** A panel tab is saved with `dock` and comes back in the panel: a shell fresh in its cwd, a
  command tab not started (`notStarted`), as in the main area. The panel's open or closed state is the layout's.

## 5. Closing

- Closing a panel tab is `tabs.close`, with the usual "running process" ask (design.md §3).
- Closing the window or project closes the panel's tabs with the rest, with the same asks.
- Hiding the panel, collapsing its zone, or the toggle never closes a tab.

## 6. Keys

The rule: **the panel acts on its own tab only while it has the keys** (its xterm or its strip holds the DOM focus);
otherwise every command acts on the main area exactly as today.

- `terminal.toggle` (`` Ctrl+` ``) and `terminal.new` (`` Ctrl+Shift+` ``) join `CORE_COMMANDS`
  (`main/commands/command-registry.ts`), rebindable through `keyOverrides`. On macOS too: VS Code uses Ctrl there, and
  Cmd+` is the system's window cycling.
- With the panel holding the keys: `tab.close` closes the panel's selected tab; `tab.switchNext` / `Prev` cycle the
  panel's tabs; `tab.newShell` opens a shell in the panel. `tab.select.N`, `tab.newClaude`, the flag and every `pane.*`
  command act on the main area as today (`tab.newClaude` also gives the keys to the new Claude tab). The panel's handlers
  sit on the `registerHandlers` stack while it has the keys, so `activeTabHandlers` (`pane-commands.ts`) is not widened.
- `Cmd+J` (`zone.toggleBottom`) keeps collapsing the whole bottom zone; the panel's tabs keep running.
- Keys-off (design.md §3 "Split groups") is about the main area and does not change. A panel tab exiting gives the keys
  to the panel's next tab, else back to the main area.

## 7. Plugins and the CLI

- No API in v1. `ctx.sessions.openShell` / `openCommand` open in the main area; a plugin cannot read or set `dock`.
  Plugin command tabs (`openedBy`) may be moved into the panel by the person; restore still drops one whose plugin is gone.
- `cockpit.sessions` and `SessionInfo` are untouched: they list Claude tabs only.
- No `ccc` command in v1. The guide needs no text (no new `ccc` command or `ctx` member).

## 8. Guests

v1 hides the panel and its tabs from guests, fail closed:
- `PanelInfo` for `core/terminal` is never sent to a guest view, and `core/` keys never pass the guest panel filters.
- `guestTabs` drops docked tabs; a tab that is docked while a guest can see it reaches that guest as `tabs.removed`, and
  one moved back as `tabs.added` (the guest filter's own events, never `tabs.docked`).
- `tabs.dock`, `tabs.panelSelect` and `tabs.create` with `dock` are `GUEST_CLASS` `no`; terminal channels naming a docked
  tab (`tabs.input`, `tabs.resize`, `tabs.fit`, the data and ack) are refused for guests by the target check (the tab is
  not visible to them).

Showing the panel to a write guest is a later decision (design-guests.md would get a row).

## 9. Alternatives considered

- **Tab containers** (any tab kind in any number of panel tab areas). Cleanest model on paper, one feature for every
  kind. Dropped: several tab areas each with their own active tab make "which tab does Cmd+W, Ask Claude or Discuss act
  on" a question the person has to answer every time, and Claude's status, send gate and rooms would need rules per area.
- **A quake drop-down overlay.** Overlays are stacked, modal in the key gate, unsaved and close on exit
  (`overlay-manager.ts`); a persistent session there would be a second terminal owner beside tabs.
- **A plugin panel.** A plugin page cannot own a pty: `ctx.processes` gives pipes, so no line editing, no full-screen
  programs, no resize, no terminal signals.

## 10. Decided with the person (2026-11-24)

1. The toggle closes the panel (its placement `open: false`); the bottom zone and its other panels stay.
2. Default chords `` Ctrl+` `` and `` Ctrl+Shift+` ``, on every platform.
3. No flags on panel tabs in v1 (the flag marks tabs in the main strip).
4. Guests do not see the panel or its tabs in v1.

## 12. Interface (fixed before the build)

Both sides build against these shapes; Task 01 lands them first.

```ts
// src/shared/types.ts
export type TabDock = 'panel'
interface TabRecord { /* ... */ dock?: TabDock }        // only kind 'shell' | 'command'

// src/shared/ipc.ts
interface TabInfo { /* ... */ dock?: TabDock }
type TabCreateRequest =
  | { kind: 'claude'; cwd?: string; beside?: TabBeside }
  | { kind: 'shell'; cwd?: string; beside?: TabBeside; dock?: TabDock }   // dock and beside never together
  | { kind: 'command'; level: TabCommandLevel; entryId: string; beside?: TabBeside; dock?: TabDock }
interface PanelInfo { /* ... */ kind?: 'webview' | 'core' }               // 'core': drawn by the shell, no src

export const TERMINAL_PANEL_KEY = 'core/terminal'                         // src/shared/layout.ts

// invoke channels
'tabs.dock':          { req: { tabId: string; dock: 'panel' | 'main' }; res: void }
'tabs.panelSelected': { req: { tabId: string }; res: void }              // the view selected a panel tab
// event channels
'tabs.docked':        { tabId: string; dock: 'panel' | 'main' }
// (no 'tabs.panelSelect' event: dropped in §13.7)

// src/shared/layout.ts: per-view open state of the Terminal panel (§13.1)
interface LayoutGeometry { /* ... */ terminalOpen?: boolean }
```

Classes: `tabs.dock` REMOTE `yes`, GUEST `no`; `tabs.panelSelected` REMOTE `adapted` (as `tabs.selected`), GUEST `no`;
event `tabs.docked` GUEST_EVENT `drop`. `shared/keys.ts`: `Backquote` code fallback (§13.13). Commands in `CORE_COMMANDS`: `terminal.toggle`
(`` Ctrl+` ``), `terminal.new` (`` Ctrl+Shift+` ``). `TabGroups` refusal reason: `docked`.

## 11. Tests

- Unit: restore round trip with `dock` (shell, command, a forged `dock` on a Claude record dropped); `tabs.dock` kind
  checks and group removal; reorder refusing a mixed list; `TabGroups` refusing a docked tab; `panelByView`; the guest
  filter dropping docked tabs and turning a dock into `tabs.removed`; key targets with and without panel focus;
  `GUEST_CLASS` / `REMOTE_CLASS` / `GUEST_EVENT` rows (typecheck forces them).
- e2e: create a shell in the panel, run a command that prints over time, hide the panel, show it, see the output that
  arrived while hidden; move a tab in and out keeping its session; restart the app and find the tab in the panel; a
  browser view shows the panel with its own open state; a guest sees neither the panel nor the docked tab.

## 13. Spec review amendments (2026-11-24)

The build team's blind questions (dev-xavi, dev-hana, qa-carol) found these gaps. **This section overrides the sections
above where they differ.** The run's `shared/spec-review.md` lists every question and who asked it.

1. **Open state per screen** (Oleg, D8). `open` is shared layout state today (`shared/layout.ts` "Shared state"); only
   geometry is per view. The Terminal panel's open state moves into `LayoutGeometry` (per view, kept by `layout-sync.ts`,
   never taken from another view's `layout.set`: `keepGeometry` keeps it as it keeps zone sizes). Its placement (zone,
   order, hidden) stays shared. A toggle on one screen never opens or closes it on another. A view with no geometry for
   it yet starts closed.
2. **Guests: one rule, and the stream stops.** `tabVisible` (`shared/guest-filter.ts`, input from `main/ipc/guest-deps.ts`;
   `GuestStore.tabVisible`) returns false for a docked tab, so target checks, ports, HTTP routes, overlay origins,
   downloads and presence all follow. Docking a tab a guest could see is a **narrowing** of that guest (D-30's path:
   `accessChangedFor`, close 4464, transfers dropped, the reconnect's snapshot has no docked tab); undocking is a
   widening. No `tabs.removed` / `tabs.added` synthesis. `pluginOfPanelKey` returns undefined for `core/` keys.
3. **Keys owner is sticky, not DOM focus.** The shell keeps `keysOwner: 'main' | 'panel'` per view, set by a focusin in
   the panel body or the main area, by the toggle and by `terminal.new`; popups, the palette, dialogs and a window blur
   do not change it; the body's unmount resets it to `main`. `focusActive` / `giveBack` return focus to the owner's tab.
   `terminal.toggle` and `terminal.new` are registered by TabsPane always (else xterm types a NUL); the body registers
   only the panel-scoped overrides while the owner is `panel`.
4. **Exits never move keys to the main area.** Clean exits close tabs (`tab-manager.ts`: a command on code 0, a shell
   after `SHELL_MIN_LIFE_MS`), so §1's "stays with its exit mark" holds only for failures. When a panel tab goes, main
   applies `ViewSelections.exitFocus`'s rule inside the panel (the person's own keys there within 1.5 s → the panel's
   next tab); otherwise that view goes keys-off. Never the main area by itself. The last panel tab closing leaves the
   panel open on "No terminals".
5. **Main selection.** Panel typing and `tabs.panelSelected` never reach `acted` / `typed` / `setActive` / presence;
   `activeTab` and `byView` are main-area only; docking the `activeTab` hands it back at once, as `viewGone` does. A
   `tabs.select` / `ctx.sessions.focus` naming a docked tab is ignored by main.
6. **Reorder.** `tabs.reorder { tabId, toIndex, block? }` keeps a full-order `toIndex`; each strip maps a drop or a
   Move left / right to the full index of its neighbour in that strip (so a step past a hidden docked tab is visible);
   main refuses `block` on a docked tab; `tabs.moved` is remapped per strip.
7. **Browser views.** `tabs.panelSelected` goes to a separate `panelSelected` on `WebConnection` and joins that tab's
   stream (`ViewTerminals` already follows a set), leaving `selected`, the group join queue and presence alone. The page
   sends it when the panel is on screen and its selection changes, and on each show; never while hidden.
   The **`tabs.panelSelect` event is dropped** (nothing sends it in v1); a reloaded view picks the first docked tab.
8. **Groups.** A `dockedOf` dep: `place` answers `docked` when the tab or its anchor is docked (a plugin's `beside` gets
   the usual `placed: false`), `panesOf` and `joinOrder` leave docked tabs out, so restore and sync prune them.
9. **Core panel plumbing.** A `CORE_PANELS` constant (bottom zone, closed) joins `reconcile` and `PanelInfo` only;
   `placedPanel` and the plugin setters (`setStatus`, `setBadge`, `setHeader`, `setSlots`) refuse `core/` keys.
10. **Renderer state.** Docked tabs stay in `state.tabs` (one order); `activeId` is never docked (one rule after each
    reducer step); a page-local `panelActiveId`. Main-area consumers filter docked tabs (TabBar, SplitArea, switcher,
    `tab.select.N`, Show Beside, Close all, `keepContiguous`); the close-ask wait counts the view's full list. One
    `SessionRegistry` above both areas (context); `activeChanged(shown)` gets main's visible set plus the panel's shown
    tab. `detach(container)` is a no-op unless that container is current. Snapshot ordering: a `tabs.list` taken before a
    dock must not undo it (main sends the current `dock` in every snapshot; the page re-applies docks it saw first).
11. **Person's moves.** Own "Move to Terminal panel": the panel opens on this screen, selects the tab, takes the keys.
    Own "Move to tab area": main selects it. A move from another view changes nothing here (keys-off if it was this
    view's active tab).
12. **Toggle details.** It unhides a hidden panel into its remembered zone and expands that zone; `Cmd+J` only touches
    the bottom zone; with a modal open (palette, ApprovalDialog, settings, a terminal overlay) it does nothing.
    `tab.switchNext / Prev` with panel keys: a plain step in the panel strip, no switcher. `tab.newCommand.*` chords act
    on the main area.
13. **Chords on other layouts.** `chordFromEvent` maps `code === 'Backquote'` (Cyrillic `ё`, German dead key, ISO `§`).
    The `CORE_COMMANDS` comment records D3's Ctrl exception.
14. **Flags.** Docking clears the flag; `tabs.flag` / `tabs.toggleFlag` refuse a docked tab.
15. **Restore.** `dock` passes through `tabRecordsOf`, `RestoredTab`, `buildRestorePlan`, `failedRecord`,
    `restoreTab` / `RestoreTabOptions` / `add`. The panel selection is not saved. A window whose saved tabs are all
    docked opens its main area on "No tabs yet" (accepted, documented).
16. **Size across views.** A desktop with the panel closed stays a tab's sizer; a browser showing it takes the size by
    typing or Fit (accepted).
17. **No upload entry** on panel terminals in v1. Server mode's hidden page renders no panel body. Guest pages drop any
    TabInfo carrying `dock`.
18. **e2e locators.** The panel gets stable locators listed in `test/e2e/SELECTORS.md` (checked by
    `selectors-guide.test.ts`): the panel region, its strip (`tablist` named "Terminal tabs"), tab names, `+`, tab menu
    items, the empty state, a test id per panel terminal. The main-area helpers in `test/e2e/fixtures.ts` scope to
    `[data-split-area]`; new helpers `panelTerminalText` / `panelTypeLine`.
