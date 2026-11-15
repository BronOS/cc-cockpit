# Split groups for every tab kind (design)

Status: implemented (2026-11-14). Ships in the release that brings the code editor (`docs/design-editor.md`) and
split groups (design.md §3 "Split groups"). It replaces the rule "a page tab is never a pane" (design.md §3, §4 "Page
tabs"; design-editor.md §1) and changes nothing else about groups or page tabs.

Why: core holds tabs and the operations on them, whatever is inside a tab. A split is such an operation, so it belongs in
core for every kind, and a plugin's page tab gets it without asking for it. The layouts the person wants most are a file
beside a Claude tab and two files side by side; both come from this one change. Scope is tight on purpose: what page tabs
need to be full panes, nothing a later version could want.

Decisions in one place:
- **One rule, widened.** `isPaneKind` (`src/shared/tab-groups.ts`) is true for every `TabKind` (`claude`, `shell`,
  `command`, `page`). Overlay entries stay outside groups as before: they are never in TabManager's order.
- **Frames stay outside React, never move in the DOM.** The one fixed layer stays; each visible page pane's frame is
  placed inside it at that pane's body box, computed by a pure model from the same tree and area the terminals use.
- **The LRU never unmounts a visible frame.** At most 6 frames live, or the visible count when that is larger.
- **The shell decides which frame has the keys.** Chromium lets a frame focus itself without being asked (§4). So a
  frame that takes the keyboard without shell-side evidence of the person (the shell's own focus call, or their pointer
  entering it) is blurred and the focus goes back. Every chord or Ask Claude from a frame names that frame's tab, never
  the one selected last.
- **New tab in Group** (approved by the person): every new-tab command with a chord gets a derived command on the same
  chord plus Alt, which opens the tab beside the focused pane (§4).
- **Close all of a group asks about unsaved pages too**, whatever the running-tab setting, and discards only what the
  person was shown.
- **Ask Claude from a page beside a Claude pane preselects that pane** (§8); outside a group New session stays.
- **No new plugin path.** `ctx.tabs.openPage` gets no `beside`; a plugin's `beside` may name a page tab as its anchor.

## 1. What changes, by file

Main: `isPaneKind` widened (`shared/tab-groups.ts`); `TabGroups` keeps its `kindOf` dep and its `mayBePane` /
`panesOf` checks, which now pass page tabs; `joinOrder` lists terminal members only (§6); HostApi's `hasTab`
(`main/index.ts`) reads any tab of the project, not only terminal ones. Renderer: `SplitArea.tsx` draws a page tab as a
pane (header, empty body); `PageTabArea.tsx` and `page-frames.ts` place several frames instead of showing one;
`pane-layout.ts` gains the pure box model; `TabsPane.tsx`, `TabBar.tsx` and `pane-commands.ts` drop their page-tab
refusals (`PAGE_TAB_NOT_SPLIT` goes, the tab menu gets the split entries, the drag gets pane mode, Show beside lists page
tabs); `close-confirm.ts` asks Close all about unsaved members; `command-registry.ts` derives the "in Group" commands.
The bundled editor drops its `view.focus()` on load (`plugins/editor/src/page/file.js`). Docs in the same change: design.md §3 "Split groups" and
§4 "Page tabs", design-editor.md §1, docs/features.md (Split view, the editor entry), the CLAUDE.md "Page tabs" line.

`not-a-pane` stays in `GroupRefusalReason` as `isPaneKind`'s refusal: no kind returns false today, and the next new
`TabKind` must decide explicitly rather than slip into groups by default.

## 2. Rendering

**Where the frames live.** Unchanged in kind: one `.page-tab-layer`, a fixed box appended to `<body>`, outside the React
root, so the web shell's `<App key>` remount and every StrictMode or layout remount leave the pages alone, and an iframe
is never moved in the document (moving one reloads it, losing its buffers). What changes is inside it. Today the layer is
laid over the tab area while a page tab is selected and the shown frame fills it. Now:
- The layer is laid over the whole split area (`.terminals`) whenever this view shows at least one page pane, or a drop
  preview (below). Its box is still measured from one placeholder (`.page-tab-area`, `inset: 0` in the area) with the
  existing `observeAround` ResizeObserver set and `layerBox`: one measurement that already handles zones resizing and
  the strip growing, rather than an observer per pane.
- Each frame is placed inside the layer by a box in pixels relative to the layer (`position: absolute`), set through a
  new `PageFrameElement.place(box | null)` that replaces `setHidden` (null: `hidden`, display none, page alive). Several
  frames are visible at once; their boxes never overlap, since panes do not. The layer gets `overflow: hidden`, so a
  box can never paint outside the tab area.
- The boxes come from a pure function in `pane-layout.ts`, `frameBoxes(view, root, area, many)`: for each visible page
  pane, its `rectsOf` rect in pixels, less the pane header (`PANE_CHROME.header`) while more than one pane shows, inset
  by 3 px on each side while more than one pane shows. The inset leaves the divider's grab zone (the splitter's
  `::before` reaches 3 px into each neighbour) and the focused pane's 2 px outline (`.pane[data-focused-pane]::after`)
  uncovered: both are drawn in `.terminals`, an isolated stacking context under the layer, so whatever a frame covers
  cannot be seen or grabbed. A plain or zoomed page tab gets the whole area, no inset, as today.
- `SplitArea` renders `PageTabArea` itself (TabsPane passes it the tabs, `listed` and `inert`, instead of building it as
  `children`), since SplitArea holds the tree and a live divider drag's sizes. It hands over the model in fractions
  (`frameBoxes` takes the area size as an argument, so it stays DOM-free for unit tests); PageTabArea turns it into
  pixels against the layer box it measures, in the same layout effect that places the layer. So the layer and its
  frames come from one measure. SplitArea's own `area` state is set by a ResizeObserver and lags by one render, so it is
  never used for a frame box.

**The pane itself.** A page tab is a `<section className="pane">` in SplitArea's one flat list, like a terminal's:
`data-pane`, the press capture that picks it, `hidden` when not visible, the "Starting…" stand-in while its tab is not
listed yet. Its body is empty (the frame lies over it). Its header is the shell's: the tab's title, the strip's marks in
words ("unsaved changes", "not seen yet", `tab-label.ts`) and "Opened by <name> (<id>)" from `TabInfo.page.plugin` and
`TabInfo.pluginName` (the manifest name main looks up when the tab opens or is restored; the bare id when there is
none), the same line a command tab's tooltip has (`tab-label.ts` `openedByLine`). The header is why the frame's box excludes it: a page can draw anything, a
look-alike Claude terminal with a permission prompt included, and the one line it cannot draw is the shell's own
header naming the plugin (D8's reason for command tabs, stronger here). A page pane with no page here (`pageTabs.src`
answered null: its plugin was switched off mid-session; the pool's `none` set) shows one line in its body, "This page
is not available: its plugin is off or did not load.", rather than a blank box under a header.

**Dividers.** A divider drag keeps scaling terminal bodies (no pty resize until release) but moves frames live: a frame
has no pty behind it, a page relayout per move is cheap (CodeMirror measures on resize), and a CSS-scaled frame would
blur its text and misplace clicks. The Splitter's and the strip's drags already take pointer capture
(`setPointerCapture`), so a pointer crossing a frame mid-drag stays with the shell. Double-click equalize, the resize
chords and `groups.resize` once on release are unchanged.

**Zoom.** Per view, as for terminals: a zoomed page pane gets the whole area; the group's other frames are placed `null`
(hidden, alive). D5's automatic zoom applies unchanged.

**Minimum sizes.** One rule for every kind: `PANE_MIN_CELLS` (20x5) and `AUTO_ZOOM_CELLS` (40x10) in cells of the
terminal font (`cellEstimate`), through the same `holdsCells`, `splitFits` and `dragMinShare`. The editor draws code in
the terminal font, so "20 columns" means the same thing in both panes, and a second unit (pixels for pages) would make a
divider stop at different places depending on which side holds a page.

**Z-order.** The layer keeps `z-index: 1`: every menu, popup and dialog drawn above the zones stays above it (the New
tab menu at a split, the tab menu, the palette, the close dialog). Two things drawn in `.terminals` must show over
frames and move into the layer: the drop preview of a strip drag in pane mode and the split menu's preview of the new
pane. The layer gets one non-frame child for it, above the frames, placed from the same rect `edgePreview` gives today
(`pointer-events: none`). The layer itself becomes `pointer-events: none` and only its frames take events, so the
headers and dividers under its empty parts are reachable. Inert handling is unchanged: the layer is made inert with the
zones (settings screen, overlay, close dialog, ccc offer, the question box), which covers every frame in it.

## 3. Frame lifecycle

`PageFrames.show(tabId | null)` becomes `show(visible: readonly string[], focused: string | null)`: every visible page
pane is mounted (on its first show, as today: a window restored with a group of four files loads those four, the files
on screen, and nothing else) and moved to the front of the LRU, the focused one first. Then `place(boxes)`.

The cap: at most `MAX_LIVE_PAGE_FRAMES` (6) live frames, or the visible count when that is larger, as the existing
`trim` counts (it never unmounts a visible frame, a dirty one or one `keep` holds). A group can hold 8 page panes: all 8
stay while shown, and once they are hidden the least recent go first, down to 6. What the cap was for
is unchanged: a person switching among a handful of files keeps them warm, one past it reloads in a second.

`fromPage`'s `tabId === this.shown` checks (chords, Ask Claude) become "visible here and its frame has the keyboard"
(§4). `wantFocus` (the shell asked a frame for the keyboard before its page loaded) takes it on load only when its tab
is still the focused pane and the keys are on: a pane that came into view by a group change elsewhere must not take keys
(D3). PageTabArea's select effect, which focuses the active tab's frame, also checks the keys are on.

Unchanged: the host restart and web reconnect hand every live frame a new port with no reload (`FrameLoads.reconnect`,
`ReadyReconnects`), the relay's pause and resync of a page-tab port, `sync(undefined)` before a fresh pane's first
`tabs.list`, and server mode's hidden page, where `pageTabs.src` answers null and nothing ever mounts (its SplitArea draws
the pane sections with empty bodies, which nobody sees; ViewSizes never measures it). Placing, moving out, moving between
groups and ungrouping only change a frame's box: none reloads a page.

## 4. Focus and keys

**Which pane is focused.** As today, the view's selected tab (`activeId`, `tabs.selected`) is the focused pane, with
D3's keys-off rule. A page pane is picked by a press on its header or the inset band around its frame (SplitArea's
press capture), by a pane chord, or by the person clicking into its frame. A press inside a frame never reaches the
shell's document. In Electron 45 the iframe element gets no `focus` or `focusin` event either (the review's spike):
when the keyboard goes from the shell into a frame, the shell sees only the window's `blur`; from frame to frame it sees
nothing, and `document.activeElement` changes without an event. `document.hasFocus()` stays true while a frame holds
the keyboard. So the shell reads `document.activeElement` at these points: the window's `blur`; a `cc-plugin.tab-focus`
hint the panel SDK posts on its own window's `focus` (a reason to look, never trusted for what it says, but see below:
with another frame on record it moves the keyboard to the hinting frame); before every chord from a frame; and before
Ask Claude.

*Measured, Electron 45 (plan Task 4's e2e):* a click from one page tab frame into another of the same plugin (two
files) moves the keyboard but leaves the shell's `document.activeElement` on the first frame for good, not only
without an event. So at a hint from frame X while the record names another frame, the shell focuses X's iframe
element first (`PageFrames.resync`, recorded as no focus of its own, so it is no evidence), and the check then decides
as for any frame. Only while a frame is on record: a hint while a terminal or the shell holds the keyboard moves
nothing (a real move into a frame from there does update `activeElement`, and the window `blur` runs the check). So **a
hint can move the keyboard between frames; it never reaches a terminal.** With fresh pointer evidence near X (the
person came over X's header a moment ago, then moved to another frame by a chord the shell does not see as a key), X's
hint alone gets X picked; without evidence the keyboard goes to nothing, so a page posting the hint in a loop can empty
the keyboard of the frame the person types in on every post, never fill a terminal. Both are page to page and no more
than a page could do with `focus()` plus the hint. A page without the SDK posts no hint, so after a click into it from
another frame the record stays on the frame left until the next move the shell sees (a known limit, as below).

**Unprompted focus is allowed, so the shell checks.** In the spike, a sandboxed cross-site frame calling `focus()`
with no user activation took the keyboard from the parent. The bundled editor did this on every load (`view.focus()`
in `load()`, `plugins/editor/src/page/file.js`). A file pane that mounts while the person types in the Claude pane
(restore, the palette's Show Tab Beside, a remount after an LRU trim, a browser's first show) would pull their keys into
the editor. D4 exists to keep a plugin from taking the keys from a Claude tab waiting for input, and that is exactly
what a visible frame beside one could do. `navigator.userActivation` cannot tell the cases apart: it is true precisely
while the person types. When `activeElement` is the frame of tab T, it counts only with shell-side evidence:
- the shell's own `pageFrames().focus(T)` put it there (focusActive, a pane chord, `wantFocus`), or
- the person's pointer went into it: the last pointer position the shell saw (a `pointermove`, `pointerdown`, `wheel`,
  or the `pointerout` as the pointer left the shell's area) is inside T's frame box or within 24 px of it
  (`POINTER_NEAR_PX`), nearer to T's box than to any other visible frame's, no more than 3 s old (`POINTER_FRESH_MS`),
  and no shell `keydown` (nor a focus moving within the shell) came after it.

*Measured, Electron 45:* the shell gets no event at all as the pointer goes into a cross-site frame (no `pointerout`,
no `pointerover` of the iframe, no `:hover` on it) and none while it is inside one. The last position the shell has is
one event's travel short of the frame's edge, hence the 24 px; two frames across a divider are 6 px apart, hence the
nearest frame only. A pointer that jumps into a frame from far away (a test's teleporting mouse, a touch or pen tap),
that crosses from one frame straight into another with no event over the shell between them, or that came in more than
3 s before the click (its travel inside the frame is unseen) leaves no evidence. The 3 s bound keeps hover from being
consent for ever: a page focusing itself later (a host message, a loop) is not picked because the pointer stopped beside
its frame a minute ago.

With evidence, and T not `activeId`, the shell picks T as the person's own act (keys on); T being `activeId` needs the
same evidence to keep the keys (the selection says nothing about where the person types now: with a file pane focused
and the person in a shell field, the palette or a search box, the page's own `focus()` would take their keys). A frame
kept or picked on the pointer evidence goes on the pool's own-focus record (`PageFrames.proven`), so a chord typed in it
minutes later, the pointer evidence long stale, still names it until the focus moves within the shell. Without evidence the shell
fails safe: it calls the iframe element's `blur()` and the keyboard goes to *nothing* (the shell's body), never to "the
focused pane". That pane is often a Claude terminal, and an unproven frame focus is as often a real click into the file
(the cases above), after which a stray Enter, digit or "y" would answer a permission prompt.

**Nothing a page does can move the keyboard into a terminal.** Not a page's `focus()`, not its hint, not any message:
keys enter a terminal only from the person's own act on it in the shell (a press on it, its strip tab, a pane chord
typed in the shell, the shell's `focusActive` after such an act). So there is no give-back either: an unproven frame
focus never hands the keyboard back to the element the person typed in last, not even in the "typing while a pane
mounts" case (a file pane mounting beside Claude takes the keys mid-word). Every check that finds an unproven frame
focus is one a page could have triggered (its own `focus()` raises the window `blur`, its hint the rest), and an earlier
give-back to a key typed within 500 ms let a hint from file B push the keyboard out of file A, just chosen by a chord,
into the Claude textarea. The keys typed after such a steal are lost (the person sees the outline still on Claude and
the cursor gone, and clicks); losing keys is safe, misdirecting them is not. The bundled editor no longer focuses
itself at load (below), so the steal needs a page that does. The check itself (`checkFrames`, frame-focus.ts) has no
way to focus anything but a frame's pane (`pick`, only ever a page tab); unit tests hold it to that for a hint, a
frame's own focus and a hint loop. The blurred frame then lets
the pointer through to its pane (`pointer-events: none` on the iframe, `PageFrames.passThrough`) until the shell next
sees the pointer move, press or wheel: the person's next press on it, even without moving, lands on the shell's pane
body and picks the pane (its `mousedown` default is prevented so the frame keeps the keyboard), and their next move
gives fresh pointer evidence for a click into the frame. A click the shell could not prove costs one more click, never
a key in the wrong pane. A pure `framePick(activeTab, activeId, evidence)` decides, unit-tested; the pool's own-focus
record counts only while its tab stays the focused pane (`show` drops it when the selection moves on).
The editor drops its `view.focus()` on load: the shell's `wantFocus` already gives a page the keyboard on its first
select, and a page that keeps focusing itself is now only blurred.

*Known limits.* The check runs a task after the window's `blur` (a blur and refocus made inside that event are undone
by the browser), or when a page's hint arrives across processes: keys typed in that gap of a few ms land in the frame
and stay there, so a mount-time steal while the person types can put a character into the page (an editor's buffer).
Frame to frame, the shell sees nothing of its own: it learns of a page that took the keyboard from another frame only
from the stealing page's `cc-plugin.tab-focus` hint (posted by the panel SDK, whose use is opt-in), or at the next
check (a chord or Ask Claude from a frame, the next shell `blur`). A page tab without the SDK that focuses itself while
another frame holds the keyboard keeps it unnoticed until then; it can take keys from another page, never from a
terminal (a terminal holding the keyboard means the shell's window has it, and its `blur` runs the check).

**Moving between panes.** Terminal to frame: a pane chord or a click, as above. Frame to terminal: a click on the
terminal pane (its press capture picks it, and xterm takes the focus from the frame), or a pane chord typed in the frame
(below), which ends in the terminal's `focus()`. The parent may call that while a child frame has the keyboard. Keys off
(D3) now also blurs a frame that holds the keyboard: SplitArea's blur looks only inside the area, and the frames are
not in it. With the keys off nothing is picked from a frame, whatever the evidence: a click into a frame is blurred, and
only a press the shell sees picks a pane (a header, a terminal, the strip, a chord). Thanks to the pass-through that
includes the person's next press on that same frame. The terminal size take (`terminal-session.ts`, `windowLeaves` /
`backArmed`) counts a leave only when `document.hasFocus()` is false after the `blur`, and each session arms once per
leave it has not seen a return from. A move into a frame keeps the document focused, so coming back from a file pane
does not arm a size take, before or after the person first left the window; only leaving the window does. Leaving the
app while a frame holds the keyboard fires no shell `blur`, so that return arms nothing (a press in the pane still takes).

**Chords from a frame name their tab.** Desktop: main's `before-input-event` sends the app's chords from a page-tab
frame as `commands.trigger` with `from: 'page-tab'` and the tab main knows that frame by (`PageTabFrameTabs`,
`page-tab-keys.ts`). The shell names each frame `cc-page-tab:<tab id>`, and main reads that name once, at the
`will-frame-navigate` of the shell's own src set on its own child frame, before any page runs there; it is keyed by
`frameTreeNodeId` and never read or overwritten again, so a page renaming or navigating itself changes nothing. The
shell also reads which frame holds the keyboard from `document.activeElement` at that moment (a live frame of a
visible pane, with `document.hasFocus()` true), and runs the chord only when that frame is the named tab's. Anything
else is dropped, never run for `activeId` or another tab. The chord crosses processes, so the keyboard may have moved
in between. The window `blur`'s check may have blurred the frame: a page's `focus()` with no evidence, then Cmd+W typed
into it at once would have closed the Claude pane the outline shows. Or another page may have taken the keyboard:
Cmd+W typed in A would have closed B. A webview panel's chord (`from: 'webview'`) also arrives as `commands.trigger`,
but its WebContentsView holds the keyboard then and the shell document has no focus, so no frame is found and it runs
for `activeId`. `commands.trigger` also carries the chord and its key's physical `code`. After a `pane.*` chord from a
frame or a webview (or the web shell's forwarded one, whose page sends the code too), the shell holds that key and
swallows its auto-repeats (`HeldChordKeys`, `pane-commands.ts`), as its own keydown path does with `swallow`. So an
arrow held on after the modifiers came up never reaches the terminal the chord moved to. The hold matches the code or
the chord's key name: on Dvorak, Ctrl+Alt+H is the chord `h` (by code), and the same key repeats as `d` once the
modifiers are up. A fresh press, a keyup or a window `blur` ends the hold. Web shell: `chord(chord)` carries the tab `fromPage` knows,
under the gate "listed chord, frame visible in this view, frame has the keyboard, `userActive`". In both shells the
command runs with that target, `runCommand(id, { tabId })`. Every handler that acts on "the active tab" (`tab.close`,
the flag, `pane.*`, split right / down, the in-Group commands) reads `target ?? stateRef.current.activeId`. When the
check blurs the frame (it held the keyboard with no evidence), the chord is dropped, never run for `activeId`: the person
typed it where the shell says no keys belong, and the pane the outline shows is not where they typed (`chordTarget`,
`frame-focus.ts`). Selecting
first and running after does not work: `stateRef.current` is written in an effect (`TabsPane.tsx`) and
`commands.trigger` runs the handler synchronously, so Cmd+W would close the Claude pane the person just left. The
shell still dispatches the selection, for the outline and `tabs.selected`. A visible frame without the keyboard can post
nothing.

Precedence is unchanged: the app table and `keyOverrides` win (Ctrl+Tab, Cmd+W, the `pane.*` chords, split right /
down). A page's declared chords go to the page while its frame has the keyboard, so Ctrl+P typed in the Claude pane
beside a file goes to Claude, never to the editor. Ctrl+Tab from a frame opens the switcher sticky, as today (its
modifier release is not seen). Split Right / Down on a focused page tab now open the New tab menu at the new pane;
`pane.*` focus, move, resize and zoom work as for a terminal pane.

**New tab in Group** (the person's addition). Each new-tab command with a chord gets a derived command on the same chord
plus Alt. It opens the tab beside the focused pane, with no menu. The derived commands are New Claude Tab in Group
(Cmd+Alt+T), New Shell Tab in Group (Cmd+Alt+Shift+T), and "New tab: <label> in Group" for each of the person's own
entries that they gave a key (entries have no default chord, `tabCommandDefs`). An entry that opens as an overlay gets
none: an overlay is never a pane.
- *Where.* `CommandRegistry.defs` (`main/commands/command-registry.ts`) adds the derived defs after the core and entry
  ones, with ids `tab.inGroup.<base id>` (helpers beside `tabCommandId` in `shared/tab-commands.ts`; the entry pattern
  of `parseTabCommandId` has no dot, so no id reads as both). `has`, `view` and `bindings` treat them like any command.
  Each is its own row in Settings › Keybindings and in the palette, and can be rebound or cleared.
- *Default chord.* `resolveKeys` runs twice. The first pass resolves every other command, with the person's overrides.
  Each derived default is then its base's resolved chord plus Alt. It has none when the base has no chord, is in an
  unresolved conflict or already carries Alt, and none when that chord is bound in the first pass. The second pass
  resolves everything, so a derived command never takes a chord from another one. When the person rebinds the base, the
  derived default moves with it at the next `view`. Once the person overrides the derived command, that override wins,
  as any override does. On Linux Cmd is Ctrl, and Ctrl+Alt+T opens a terminal on GNOME and Ubuntu desktops (Omarchy
  binds Super there), so that row is where the person rebinds it.
- *What it does* (renderer, beside `tab.newClaude` in `TabsPane.tsx` and `tabCommandHandlers`): `tabs.create` with
  `beside: { tabId: target, edge }`, as the menu choice of Split Right / Down sends. `edge` is `right` when the focused
  pane is wider than tall in pixels as this view draws it (`paneSize`): cells are about twice as tall as wide, and
  pixels are what the person sees. Otherwise it is `down`. When that edge does not fit (`splitFits`) the other is tried.
  When neither fits, or the group is full, the strip's error line says why and nothing opens, as for Split Right. A
  focused plain tab forms a new group. The new pane takes the focus (`addPicked`), since it is the person's own act.
  With the keys off it does nothing, like every command on the active tab.
- Split Right / Down (Cmd+Shift+D / Cmd+Alt+Shift+D, which open the New tab menu at the new pane) stay as they are.

## 5. Unsaved text

Dirty stays per (tab, view), from each page's report, kept by main; nothing about it depends on groups.
- *Closing a pane* is closing its tab: `requestClose` and `closeQuestion` as today (asks whenever this view's frame or
  main says dirty, whatever the setting). The focus goes to the pane that took its space (D3), unchanged.
- *Close all of a group* (the handle's menu): `closeGroupQuestion` lists the running members and, as their own kind of
  line, the page members with unsaved changes (`tab.dirty` or this view's `isDirty`). It asks when any member is
  unsaved even with the setting off (what a close loses there is text, as for one tab), and when the setting is on and
  any member runs. Close sends `discard: true` for the unsaved members it listed and a plain close for the rest. A member
  dirty in another view whose report has not reached this one is refused by main (`{ unsaved: true }`) and asked about
  then, alone; with the dialog already up for another refusal it is dropped and stays open, the safe side. In a server
  view, a group question that lists unsaved members is an `ApprovalDialog`, as the single unsaved question's
  `CloseTabApproval` is today: CLAUDE.md requires one for any discard a browser may give. It has no "Don't ask again",
  and its button says "Discard and Close all". A group question with only running members keeps `CloseTabDialog`.
- *Moving out, ungrouping, moving between groups, zoom*: nothing closes, nothing asks; the frame only changes box.
- *Window close, quit and reopen*: main's ask over every page tab of the window dirty in any view
  (`windows/unsaved-dialog.ts`, the reopen's "Discard and Reopen") is unchanged and does not care about groups. The
  groups are saved with the tabs in one write (`TabRestorer`), and the reopened or relaunched window restores the page
  tabs in their groups (§6), never their buffers.
- *A browser's unload* (`beforeunload` while any page frame of the view is dirty) and the desktop remote window's ask
  are unchanged.

## 6. Main's rules

- **Placement.** `groups.place`, `tabs.create` with `beside`, Show beside and the pane-mode drag accept a page tab as the
  tab placed and as the anchor; every id is still looked up in the sender's project (unknown and foreign are one
  refusal). Caps are unchanged and page panes count in them: 8 panes, depth 4, 32 groups per project, the 10% share; the
  64 page tabs per plugin per project are unchanged.
- **Plugins.** `ctx.sessions.open` / `openShell` / `openCommand` `beside` may name a page tab (HostApi's `hasTab` is any
  tab of the host's window's project). D4 and D7 stay: the new tab is placed, never focused, only below 4 panes. Main
  knows no cell size of a page pane (`TabManager.sizeOf` has none: no pty, no size report), so the halves check is
  skipped for a page anchor, as for any anchor of unknown size; the 4-pane cap and each view's automatic zoom bound it.
  `ctx.tabs.openPage` gets no `beside` (§9), and host-api still has no group op (`no-plugin-group-edits.test.ts`).
- **What stays refused.** Overlay entries (a `tabs.create` of a command entry that opens as an overlay returns null and
  places nothing), unknown and foreign ids, everything over the caps.
- **Restore.** The saved `tabGroups` leaves name `TabRecord.id`s of every kind; `TabManager.restoreTab` returns the page
  tab's new id like any other, so the restore's id map carries page leaves and `restoreGroups` keeps them. A page tab
  that does not come back loses its leaf, like a failed spawn: one whose plugin is gone or no longer declares the type
  (dropped from the record), and one that is `'later'` (installed but failed to load or off in the project: kept in the
  record as an unrestored tab, tried at next launch, where it comes back as a plain tab at the end of the strip). A group
  left with one pane dissolves. Keeping a hole in a live group for a tab that is not live would break the invariant every
  op relies on (a leaf is a live tab). The cost, a layout lost after a plugin was off for one launch, is accepted for
  this release (the person's call); a placeholder pane is listed in §9.
- **Web joins.** `TabGroups.joinOrder` lists the selected tab and the group's terminal members only (`kindOf`): a page
  member has no mirror to join, and queuing it would leave it in `ViewTerminals`' waiting set for the view's life.
- **Sessions.** `SessionInfo` still carries no group; page tabs stay out of the send gate, `typed` and Claude status.

## 7. Browser views and remote windows

Same rules as terminal panes, per view: divider sizes shared by every view (D1), zoom and the automatic zoom per view,
the focused pane per view, keys off per view. Every browser view (and a desktop remote window, which runs the server's
web client) has its own layer and pool, so a page tab visible in two views has two frames, two buffers and two dirty
reports, as a plain page tab already does. A browser draws a group with a page pane as soon as `groups.get` answers after
`tabs.list`; until then the selected page tab fills the area, then moves into its pane, a box change and no reload. A
web reconnect remounts the tree and re-applies the boxes from the new tree; the frames take a new port at `ready`. The
chord gate is §4's. Server mode's hidden page mounts no frame, unchanged.

## 8. Ask Claude and the unseen dot

**Ask Claude.** `discussMayOpen` keeps `activeId === tabId`, which in a group means the page is the focused pane, and
`fromPage` takes the ask only from a visible frame with the keyboard (§4), so a file pane beside the one the person
works in cannot raise the box.

The preselected target (the person's call): a page tab in a group with a Claude pane preselects that pane, since the
file beside Claude is the layout this is for. With several, it is the one this view focused last (TabsPane's
`lastClaude` ref, when that tab is in the group), else the first in reading order. A pane that is `not-ready`
(`discussReadiness`: a Claude tab never prompted) is skipped; with none left, the box preselects New session. A page tab
outside a group keeps New session as the default (commit 9895a7c), with the Claude tab this view used last first in
the list.

Where it is decided: in the renderer, when the page asks. A pure `groupDiscussPreselect(root, claudeTabs, lastClaude)`
in `page-tab-discuss-model.ts` returns a tab id or none. TabsPane calls it with the page's group and passes the answer to
`PageTabDiscussDialog` as `preselect`; the dialog starts its `target` there instead of at `NEW_SESSION`
(`orderDiscussTabs` already lists the preselected tab first). A preselected tab that closes while the box is up falls
back to New session (the dialog's existing rule). Main decides nothing new: the preselect is a default on a box the
person sees, Send is armed only after about a second (`ApprovalArm`), and `pageTabs.discuss` checks the target
(`discussTargetProblem`) as it does for any pick. After a send, main selects the target Claude tab as today; in the
page's group that moves the focus to that pane, and the file stays on screen beside it. Before the box opens, the shell
reads the frame focus (§4), so Ask Claude from the second of two files is not dropped for a stale `activeId`.

**Unseen dot.** Unchanged: set when a page tab opens while another tab is selected (`ccc edit` from Claude), cleared by
`tabs.selected` from a view. A member keeps its dot in the group's segment like any member's. A page tab only gets into
a group by the person's act, and a drag or the tab menu's Show beside selects it; only the palette's Show Tab Beside
keeps the focus on the anchor, so an unseen tab placed that way keeps its dot while visible until the person clicks it.
Accepted, not worth a `tabs.shown` channel. `ccc edit` never selects: the editor opens with `focus: false`
(`plugins/editor/dist/host.js`), so the keys stay in the Claude tab that ran it; a file already open in a visible pane
gets the dot again and moves to the line. `ctx.tabs.focus` of a page tab in a group selects it as it would a plain one,
and its group shows with it focused. That is the plugin's explicit call, and the keys go to its own page, which cannot
answer a Claude prompt.

## 9. Not in this version

- `ctx.tabs.openPage(..., { beside })` (the editor's "open to the side"): it needs its own focus rule, since a page
  takes the keyboard on load and D4 says a plugin's pane never does. Two files side by side come from a drag or Show
  beside.
- Page entries in the New tab menu of a split (a file picker there): a page tab is opened by its plugin.
- A placeholder pane for a `'later'` page tab, keeping its place in its group across a launch (§6: it comes back as a
  plain tab instead).
- A page's own minimum size (a manifest field): the cell minimum applies to every pane.
- A `tabs.shown` channel to clear the unseen dot of a visible, unfocused pane.

## 10. Testing

Unit (vitest, DOM-free):
- `frameBoxes` (`test/unit/pane-layout.test.ts`): one page pane in a two-pane row, a column, nested splits, the header
  and the 3 px inset only while several panes show, a zoomed page pane and the automatic zoom (whole area), a live divider
  drag's sizes, terminal panes yield no box, a 0x0 area yields none.
- `PageFrames` (`page-tab-frames.test.ts`, fake elements): `show` mounts every visible page pane once; `trim` with 8
  visible keeps 8 and unmounts hidden ones past 6, never a dirty one; placing, moving out and between groups never calls
  `remove` or `load`; a chord or discuss from a visible frame without the keyboard, or from a hidden one, is dropped; the
  web chord carries the frame's tab; `wantFocus` does nothing when the tab is not the focused pane.
- The focus pick (a pure `framePick(activeElement, visible, activeId, userActive)` beside the pool): picks only a
  visible frame other than `activeId`, only with activation, else asks for the keyboard back.
- `tab-groups-service.test.ts`: a page tab is placed, as tab and anchor; `tabs.create` beside a page tab places; a
  restore maps page leaves; a `'later'` or dropped page tab prunes its leaf (and dissolves a two-pane group); `joinOrder`
  skips page members. The current refusal tests flip.
- `close-confirm.test.ts`: Close all with an unsaved page member asks with the setting off; the answer discards exactly
  the listed members; nothing unsaved and nothing running closes at once.
- `pane-commands.test.ts`: Split Right on a page tab opens the menu; `PAGE_TAB_NOT_SPLIT` is gone.
- `groupDiscussPreselect` (`page-tab-discuss-box.test.ts`): a plain page tab gets none (New session); a group with one
  ready Claude pane gets it; with two, `lastClaude` when it is in the group, else the first in reading order; a
  `not-ready` pane is skipped, and all `not-ready` gives none; a Claude tab outside the group is never picked; the
  dialog starts on `preselect` and falls back to New session when that tab closes.
- `framePick`: the shell's own focus and pointer evidence each pick; a focus with neither, or with a shell keydown after
  the pointer, blurs and leaves the keys on nothing (no give-back); with the keys off nothing is picked. `checkFrames`:
  a hint from B after a chord into A, a frame's own focus while the person types in Claude, and a hint loop never put
  the keyboard in a terminal and never pick one.
- Chord targets (`pane-commands.test.ts`, the tab handlers): `tab.close`, the flag and `pane.*` act on the target passed
  in, not on `activeId`.
- The in-Group commands (`command-registry.test.ts`): derived ids and titles, none for an overlay entry; the default is
  the base plus Alt; none when the base has Alt, has no chord, or the chord is taken; the default follows a rebound
  base; the person's override of the derived command wins. The handler picks right or down by pane shape and refuses
  when neither fits.
- `close-confirm.test.ts` (server): a group question with unsaved members is an approval saying "Discard and Close
  all", with no "Don't ask again".
- `terminal-session` size take: a `blur` while `document.hasFocus()` is still true does not set `windowLeft`.

E2E (Playwright; `test/e2e/editor-split.spec.ts` rewritten from its refusal checks, launched with
`env: { CC_COCKPIT_NO_BUNDLED: '' }` for the editor):
- *File beside Claude.* Open a file from Files, drag its tab to the right edge of the Claude pane: both visible, the
  frame's box inside the right pane (below its header), a marker the page holds survives (no reload); typing in the frame
  changes the file, the Claude tab's `typed` stays false; Move out and Ungroup keep the marker.
- *Two files side by side* by Show beside; both frames visible, distinct boxes, a divider drag moves both, restored
  after a relaunch in the same group (new ids).
- *Ask Claude beside Claude.* With the file beside a Claude pane that has run a prompt, the editor's Ctrl+L opens the
  box with that Claude tab selected; the same file as a plain tab opens it on New session.
- *Unprompted focus.* Type in the Claude pane while a file pane beside it mounts (Show Tab Beside from the palette, and a
  relaunch that restores the group): every key lands in Claude, and the file frame does not keep the keyboard.
- *File A to file B.* With two files side by side, click into A, then into B: the outline and `tabs.selected` follow;
  Cmd+W closes B; Ask Claude from B opens its box.
- *Keys off on a page pane.* Another view moves the focused file out of its group: no key reaches any frame or terminal
  until the person clicks.
- *A menu over a frame.* The tab menu and the New tab menu opened over a file pane are drawn on top and take the click.
- *`ccc edit`* of the visible file, run from the Claude pane: the keys stay in Claude, and the file moves to the line.
- *New Claude Tab in Group* (Cmd+Alt+T) on a wide file pane opens Claude to its right, focused.
- *Two visible frames survive* a host restart (`panels.reload` for the editor) and a web reconnect: both markers stay.
- *Server mode* (`launchServer`) with a file pane in a group: the hidden page mounts no frame; Close all with a dirty file
  shows the approval in the browser, and Discard and Close all closes the group.
- *Close all with a dirty file.* Type in one file, Close all: the dialog names it; Cancel keeps the group and the text;
  Close closes every member.
- *Keys to the focused pane.* Click into the file frame, native Cmd/Ctrl+W (main's `before-input-event`): the file tab
  closes, the Claude tab stays; with the Claude pane focused, the editor's declared Ctrl+P does not reach the page; a pane
  focus chord from the frame puts the keyboard in the terminal.
- *Web view.* With web access on, the desktop places a file beside Claude; the browser shows both panes, its own frame
  at the pane's box; a forwarded Ctrl+W from the browser's focused frame closes the file; the desktop's frame is
  untouched until then.

Not covered by e2e, said in the plan: Firefox and Safari views (their focus events on an iframe and the pointer
evidence there), and a real person's fast pointer crossing a divider into a frame (the evidence rule's edge case).
