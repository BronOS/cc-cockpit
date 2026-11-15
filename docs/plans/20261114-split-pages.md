# Split groups for every tab kind

External review: sol / high

## Overview
- Page tabs (the editor's file tabs, any plugin's `contributes.tabs`) become split panes like terminal tabs (design
  `docs/design-split-pages.md`, the source of truth). It replaces "a page tab is never a pane" (design.md §3, §4 "Page
  tabs"; design-editor.md §1) and changes nothing else about groups or page tabs.
- The layouts this is for: a file beside a Claude tab, two files side by side. Both come from one widened rule
  (`isPaneKind` true for every `TabKind`) plus the renderer placing several frames at once.
- The shell decides which frame has the keys (§4): a frame that took the keyboard without shell-side evidence of the
  person is blurred, and every chord or Ask Claude from a frame names that frame's tab. This is the riskiest part (the
  review's spike found Electron's iframe focus behaves differently than assumed), so it comes right after rendering.
- Additions the person approved: New tab in Group (each keyed new-tab command gets a derived one on chord + Alt), Close all
  asks about unsaved pages, Ask Claude from a page beside a Claude pane preselects that pane.

## Context (from discovery)
- Rule and main: `src/shared/tab-groups.ts` (`isPaneKind`, `GroupRefusalReason` `not-a-pane`), `src/main/tabs/tab-groups.ts`
  (`TabGroups`: `mayBePane`, `panesOf`, `joinOrder`, `restore`, `sizeOf` for a plugin's `beside`), `src/main/index.ts`
  (HostApi's `hasTab` at the `openTab` deps reads `isPaneKind(tabs.kindOf(...))`; the TabGroups deps' comment; the web
  connection's own `hasTab`), `src/main/restore.ts` (`restoreGroups`, `'later'` page tabs), `src/main/plugins/host-api.ts`
  (`beside` check).
- Renderer: `src/renderer/tabs/SplitArea.tsx` (skips `kind === 'page'`, `children` slot for PageTabArea, keys-off blur
  inside the area, `.pane-drop-preview`), `PageTabArea.tsx` (one layer on `<body>`, `layerBox`, `observeAround`, the
  select effect focusing the active frame, the pool's `chord` → `runForwardedChord`), `page-frames.ts` (`PageFrames.show(tabId)`,
  `shown`, `setHidden`, `wantFocus`, `fromPage` gates on `tabId === this.shown && el.hasFocus()`, `trim`,
  `MAX_LIVE_PAGE_FRAMES`), `pane-layout.ts` (`PANE_CHROME`, `holdsCells`, `splitFits`, `dragMinShare`, `edgePreview`),
  `TabsPane.tsx` (`stateRef` written in an effect, `commands.trigger` and `setForwardedRunner` → `runCommand(id)`,
  `tab.close` / flag handlers on `activeId`, `focusActive`, `paneSize`, `splitBlocked`, `openSplit`, `besideItems`,
  `closeGroup`, `lastClaude`, `setPageTabDiscussHandler`), `TabBar.tsx` (drag `paneable`, menu split entries, Show
  beside list, all on `isPaneKind`), `pane-commands.ts` (`PAGE_TAB_NOT_SPLIT`, handlers on `ctx.state().activeId`),
  `close-confirm.ts` (`closeGroupQuestion` running members only), `CloseTabDialog.tsx` (`CloseTabApproval`),
  `page-tab-discuss-model.ts`, `PageTabDiscussDialog.tsx` (`NEW_SESSION`, `preselectDiscussTarget`, `orderDiscussTabs`),
  `terminal-session.ts` (`windowLeft` set on every window `blur`), `src/renderer/styles.css` (`.page-tab-layer`,
  `.pane[data-focused-pane]::after`, `.pane-drop-preview`).
- Keys: `src/renderer/commands/keybindings.ts` (`CommandHandler = () => void`, `runCommand`, `runForwardedChord`,
  `tabCommandHandlers`), `src/renderer/commands/web-keys.ts` (browser-kept chords get Alt added),
  `src/main/tabs/page-tab-keys.ts` (desktop `before-input-event` → `commands.trigger`, names no tab),
  `src/main/commands/command-registry.ts` (`CORE_COMMANDS` `tab.newClaude` Cmd+T, `tab.newShell` Cmd+Shift+T,
  `tabCommandDefs`, `view` / `bindings` / `has` over one `resolveKeys`), `src/shared/tab-commands.ts` (`tabCommandId`,
  `parseTabCommandId`), `src/shared/keys.ts` (`resolveKeys`).
- Panel SDK: `src/sdk/panel-core.ts` (`cc-plugin.tab-key`, `cc-plugin.tab-discuss`), `src/shared/page-tabs.ts` (message
  names), `src/sdk/panel.ts` (classic script, no import or `require` in the output).
- Editor: `plugins/editor/src/page/file.js` `load()` calls `view.focus()` on every load (the other focus calls follow
  the person's acts); bundle committed as `plugins/editor/dist/pages/file.bundle.js` (`npm run build:editor`).
- Tests today: `test/unit/{tab-groups,tab-groups-service,pane-layout,pane-commands,page-tab-frames,page-tab-keys,
  page-tab-discuss-box,close-confirm,command-registry,terminal-session,panel-sdk,web-keys,no-plugin-group-edits}.test.ts`;
  e2e `test/e2e/editor-split.spec.ts` (the refusal checks), `split-fixtures.ts` (`place`, `groupOfShells`,
  `visiblePanes`, `domFocusInTerminal`), `editor.spec.ts`, `editor-web.spec.ts`, `web-fixtures.ts`, `server-fixtures.ts`.

## Development Approach
- **testing approach**: Regular (code first, then tests); every task ends with its tests, all passing before the next.
- main stays the authority: every id in a placement is looked up in the sender's project; nothing about focus or a
  chord's target is taken from a page's message (the `cc-plugin.tab-focus` hint is only a reason to look).
- DOM-free models where the design names them (`frameBoxes`, `framePick`, `groupDiscussPreselect`, the pool with fake
  elements), so vitest covers the decisions and e2e covers the browser's behaviour.
- New IPC channels need their `REMOTE_CLASS` in the same change (none planned: the design adds no channel).
- A changed `src/sdk/types.ts` comment goes to `examples/plugin/sdk/types.ts` by hand (`cp`); guide text changes in the
  same change as the behaviour (drift tests `cli-guide.test.ts`, `claude-plugins.test.ts`).
- Editor page source changes: `npm run build:editor` and commit the bundle (a unit test rebuilds and compares bytes).
- Dense "why" comments: the spike's finding (no `focus`/`focusin` on the iframe element, `activeElement` changing
  silently), D3, D4.

## Testing Strategy
- **unit (vitest)**: `isPaneKind` and TabGroups with page tabs (placement, restore, prune, `joinOrder`); `frameBoxes`;
  the pool (`show` visible set, `place`, cap, chord and discuss gates); `framePick`; chord targets; derived in-Group
  commands; Close all with unsaved members (desktop and server); `groupDiscussPreselect`; the size take.
- **plugin tests (`node:test`)**: a source check that the editor page no longer focuses itself on load.
- **e2e (Playwright)**: `test/e2e/editor-split.spec.ts` rewritten from its refusal checks (desktop, launched with
  `env: { CC_COCKPIT_NO_BUNDLED: '' }`), plus `test/e2e/editor-split-web.spec.ts` (web view and server mode).
- Not covered by e2e (said here and in Post-Completion): Firefox and Safari views (their iframe focus events and the
  pointer evidence there), a real person's fast pointer crossing a divider into a frame.

## Progress Tracking
- mark completed items with `[x]` immediately; ➕ new tasks; ⚠️ blockers; keep the plan in sync with the work.

## Solution Overview
- Main: one widened rule. `isPaneKind` is true for every `TabKind`; `not-a-pane` stays as its refusal for the next kind.
  `joinOrder` lists terminal members only (a page has no mirror to join). HostApi's `hasTab` reads any tab of the project.
- Renderer: frames stay in the one fixed layer outside React and never move in the DOM. The layer covers the whole split
  area while any page pane shows; each frame is placed by a pixel box from a pure `frameBoxes` (pane rect less header and
  a 3 px inset while several panes show). SplitArea draws the page pane's section (header, empty body) and renders
  PageTabArea itself so layer and boxes come from one measure. The pool shows a visible set, never unmounting a visible
  frame.
- Focus: the shell reads `document.activeElement` at window `blur`, at a `cc-plugin.tab-focus` hint, before each chord
  from a frame and before Ask Claude. A frame holding the keys counts only with evidence (the shell's own focus call, or
  the pointer entering it with no shell keydown after); otherwise it is blurred and `focusActive` runs.
- Commands from a frame run with an explicit target: `runCommand(id, { tabId })`, every active-tab handler reading
  `target ?? stateRef.current.activeId`.

## Technical Details
- `PageFrameElement.place(box: { left: number; top: number; width: number; height: number } | null)` replaces
  `setHidden`; null is `hidden` (display none, page alive). The layer gets `overflow: hidden`, `pointer-events: none`
  (frames `pointer-events: auto`) and one non-frame child above the frames for the drop and split previews.
- `frameBoxes(view, root, area, many)` in `pane-layout.ts` returns fractions/pixels per visible page pane; zoomed or plain:
  the whole area, no inset.
- `PageFrames.show(visible: readonly string[], focused: string | null)` then `place(boxes)`; cap = `max(6, visible.length)`.
- `framePick(activeTab, activeId, ownFocus, pointer, keyAfterPointer)` → `{ pick: tabId } | { blur: true } | null`
  (keys off: never a pick). The §10 bullet that says `framePick(activeElement, visible, activeId, userActive)` with
  "only with activation" is superseded by §4 (`userActivation` cannot tell the cases apart); this plan follows §4.
- `CommandHandler = (ctx?: { tabId?: string }) => void`; `runCommand(id, ctx?)`; `runForwardedChord(chord, tabId)`.
- Derived ids `tab.inGroup.<base id>` (`inGroupCommandId` / `parseInGroupCommandId` beside `tabCommandId`); `resolveKeys`
  runs twice in `CommandRegistry` (first pass without derived defaults, second with them).
- `groupDiscussPreselect(root, claudeTabs, lastClaude)` in `page-tab-discuss-model.ts`; `PageTabDiscussDialog` gets
  `preselect?: string`.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: manual checks on the desktop, in a browser view, in the Mac remote window, and Hyprland focus.

## Implementation Steps

### Task 1: Main: every tab kind may be a pane [model: sonnet]

**Files:**
- Modify: `src/shared/tab-groups.ts`, `src/main/tabs/tab-groups.ts`, `src/main/index.ts`, `src/main/tabs/tab-manager.ts` (comment)
- Modify: `test/unit/tab-groups.test.ts`, `test/unit/tab-groups-service.test.ts`

- [x] `isPaneKind` true for `claude`, `shell`, `command`, `page` (an explicit list, not `true`: a new `TabKind` must be
  added by decision); keep `not-a-pane` in `GroupRefusalReason` with a comment saying why
- [x] `TabGroups`: `mayBePane` / `panesOf` keep the `kindOf` dep and now pass page tabs; `joinOrder` lists the selected
  tab and the group's terminal members only (`kindOf`), so a page member never waits in `ViewTerminals`' set
- [x] HostApi's `hasTab` (`main/index.ts`, the `openTab` deps) is any tab of the project (`tabs.kindOf(...) !== undefined`);
  a page anchor has no `sizeOf`, so the halves check is skipped as for any anchor of unknown size (D4, D7, the 4-pane
  cap unchanged); rewrite the comments that say a page tab is never a pane (index.ts TabGroups deps, tab-manager.ts)
- [x] restore: page leaves map through the restore's id map like any tab; a dropped or `'later'` page tab prunes its
  leaf and a one-pane group dissolves (check `restore.ts` passes page ids into `idMap`)
- [x] write tests: a page tab placed as tab and as anchor; `tabs.create` beside a page tab places; restore maps page
  leaves; `'later'` and dropped page tabs prune (a two-pane group dissolves); `joinOrder` skips page members; the
  refusal tests flip; a plugin `beside` naming a page tab places with the halves check skipped
- [x] `no-plugin-group-edits.test.ts` still passes (host-api gains no group op)
- [x] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`)

### Task 2: Renderer: page panes drawn, several frames placed [model: opus]

**Files:**
- Modify: `src/renderer/tabs/pane-layout.ts`, `src/renderer/tabs/page-frames.ts`, `src/renderer/tabs/PageTabArea.tsx`
- Modify: `src/renderer/tabs/SplitArea.tsx`, `src/renderer/tabs/TabsPane.tsx`, `src/renderer/styles.css`
- Modify: `test/unit/pane-layout.test.ts`, `test/unit/page-tab-frames.test.ts`, `test/e2e/editor-split.spec.ts`

- [x] `frameBoxes(view, root, area, many)` in `pane-layout.ts`: each visible page pane's `rectsOf` rect, less
  `PANE_CHROME.header` and inset 3 px per side only while several panes show; zoomed / auto-zoomed / plain: whole area;
  terminal panes yield nothing; 0x0 area yields nothing. DOM-free (area size is an argument)
- [x] `PageFrames`: `show(visible, focused)` mounts each visible page pane on its first show and moves it to the LRU front
  (focused first); `place(boxes)`; `PageFrameElement.place(box | null)` replaces `setHidden`; `trim` never unmounts a
  visible, dirty or `keep` frame, cap `max(MAX_LIVE_PAGE_FRAMES, visible count)`; `shown` becomes the visible set
- [x] `SplitArea` draws a page tab as a `<section className="pane">` (`data-pane`, press capture, `hidden`, "Starting…"
  stand-in) with the shell's header (title, "unsaved changes" / "not seen yet" from `tab-label.ts`, "Opened by
  <plugin>" from `TabInfo.page.plugin`) and an empty body; with `pageTabs.src` null (the pool's `none` set) the body says
  "This page is not available: its plugin is off or did not load."
- [x] `SplitArea` renders `PageTabArea` itself (TabsPane passes `tabs`, `listed`, `inert` instead of `children`) and hands
  it the fractions from `frameBoxes` with the live divider-drag sizes; PageTabArea turns them into pixels against the
  layer box in the same layout effect that places the layer (`layerBox`, `observeAround` unchanged; never SplitArea's
  lagging `area` state); the layer covers `.terminals` while any page pane shows
- [x] CSS: `.page-tab-layer` `overflow: hidden`, `pointer-events: none`, frames `position: absolute; pointer-events: auto`;
  `z-index: 1` kept so menus and dialogs stay above; divider drags move frames live (no CSS scaling of a frame)
- [x] write tests: `frameBoxes` (two-pane row, column, nested splits, header and inset only with several panes, zoom and
  automatic zoom, a live drag's sizes, terminal panes, 0x0); pool with fake elements (`show` mounts each visible pane
  once; 8 visible keep 8 and hidden ones past 6 unmount, never a dirty one; placing, moving out and between groups never
  calls `remove` or `load`)
- [x] e2e (`editor-split.spec.ts`, rewritten; `CC_COCKPIT_NO_BUNDLED: ''`): *file beside Claude* placed with the
  `place` helper: both visible, the frame's box inside the right pane below its header, a page marker survives Move out
  and Ungroup; *two visible frames survive a host restart* (`panels.reload` for the editor): both markers stay
- [x] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split.spec.ts`)

### Task 3: Focus model: the shell decides which frame has the keys [model: opus]

**Files:**
- Create: `src/renderer/tabs/frame-focus.ts` (DOM-free `framePick` and the pointer-evidence state)
- Modify: `src/renderer/tabs/PageTabArea.tsx`, `src/renderer/tabs/page-frames.ts`, `src/renderer/tabs/TabsPane.tsx`
- Modify: `src/renderer/tabs/SplitArea.tsx`, `src/renderer/tabs/terminal-session.ts`
- Modify: `src/sdk/panel-core.ts`, `plugins/editor/src/page/file.js`, `plugins/editor/dist/pages/file.bundle.js`
- Create: `test/unit/frame-focus.test.ts`, `plugins/editor/test/page-focus.test.mjs`; Modify: `test/unit/page-tab-frames.test.ts`, `test/unit/terminal-session.test.ts`, `test/unit/panel-sdk.test.ts`

- [x] `framePick(activeTab, activeId, ownFocus, pointer, keyAfterPointer)`: with evidence (the shell's own
  `pageFrames().focus(T)`, or the last shell pointer position inside or on the edge of T's frame box with no shell
  `keydown` after it) and T not `activeId`: pick T (keys on); without evidence: blur the iframe element and leave the
  keyboard on nothing (review fix: not `focusActive`, which handed it to a Claude terminal), except back to the element
  of a shell key within 500 ms with the pointer not near the frame; the blurred frame passes the pointer to its pane
  until it moves; keys off: never a pick. The pool records its own focus calls; the shell tracks `pointermove` /
  `pointerout` and `keydown` (capture) for the evidence
- [x] read `document.activeElement` at the window `blur`, at a `cc-plugin.tab-focus` hint (new `TAB_FOCUS_MESSAGE` in
  `sdk/panel-core.ts`, beside the other page-tab message constants; panel-core posts it on its own window's `focus`; never trusted for what it says); the pick
  dispatches `selected` so the outline and `tabs.selected` follow; `panel.ts` still builds with no import or `require(`
- [x] `wantFocus` takes the keyboard on load only when its tab is still the focused pane and the keys are on; the
  PageTabArea select effect checks the keys too (a pane shown by another view's group change never takes keys, D3)
- [x] keys off (D3) also blurs a frame holding the keyboard (SplitArea's blur looks only inside the area); a click on a
  terminal pane takes the keys back from a frame (press capture, xterm `focus()`)
- [x] `terminal-session.ts`: the window `blur` sets `windowLeft` only when `document.hasFocus()` is false after it, so
  coming back from a file pane arms no size take
- [x] editor: drop `view.focus()` from `load()` in `plugins/editor/src/page/file.js` (the shell's `wantFocus` gives the
  first select the keyboard); keep the focus calls that follow the person's acts; `npm run build:editor`
- [x] write tests: `framePick` (own focus picks, pointer evidence picks, neither blurs and leaves the keys on nothing (or gives them back to a key typed within 500 ms), a shell
  keydown after the pointer blurs, keys off picks nothing, T equal to `activeId` is no change); `wantFocus` does nothing
  when the tab is not the focused pane or the keys are off; the size take ignores a `blur` with `hasFocus()` true; the
  SDK posts `cc-plugin.tab-focus` on window focus; a source check `plugins/editor/test/page-focus.test.mjs` (no page test loads
  `file.js`'s DOM): `load()` calls no `view.focus()`
- [x] e2e: *unprompted focus* — type in the Claude pane while a file pane beside it mounts (palette Show Tab Beside via
  the `place` helper for now, and a relaunch that restores the group): every key lands in Claude, the frame does not
  keep the keyboard; *keys off on a page pane* — another view (or a `groups.remove` hook call) moves the focused file
  out: no key reaches any frame or terminal until a click; *`ccc edit`* of the visible file from the Claude pane: keys
  stay in Claude, the file moves to the line
- [x] run tests - must pass before next task (`npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint`,
  `npm run build:editor`, `editor-split.spec.ts`, `editor.spec.ts`)

### Task 4: Chords and Ask Claude from a frame name their tab [model: opus]

**Files:**
- Modify: `src/renderer/commands/keybindings.ts`, `src/renderer/tabs/TabsPane.tsx`, `src/renderer/tabs/pane-commands.ts`
- Modify: `src/renderer/tabs/page-frames.ts`, `src/renderer/tabs/PageTabArea.tsx`
- Modify: `test/unit/pane-commands.test.ts`, `test/unit/page-tab-frames.test.ts`, `test/unit/page-tab-keys.test.ts`, `test/e2e/editor-split.spec.ts`

- [ ] `CommandHandler` takes an optional `{ tabId }`; `runCommand(id, ctx?)`; `runForwardedChord(chord, tabId)` and the
  forwarded runner pass it through the same `allowed` gate
- [ ] desktop `commands.trigger`: before running, resolve the target from `document.activeElement` (a live frame of a
  visible pane with `document.hasFocus()` true; a webview panel's chord resolves none since the shell has no focus),
  run Task 3's pick on it, then `runCommand(id, { tabId })`
- [ ] web shell: the pool's `fromPage` gate becomes "listed chord, frame visible in this view, frame has the keyboard,
  `userActive`" and calls `chord(chord, tabId)`; `discuss` likewise from a visible frame with the keyboard only (re-read
  focus before the box, so Ask Claude from the second of two files is not dropped for a stale `activeId`)
- [ ] every active-tab handler reads `target ?? stateRef.current.activeId`: `tab.close`, the flag
  (`TOGGLE_FLAG_COMMAND`), `pane.*` in `paneCommandHandlers` (focus, move, resize, zoom, move out, split right / down,
  show beside), and the later in-Group commands; the shell still dispatches the selection for the outline
- [ ] a page's declared chords go to the page only while its frame has the keyboard (Ctrl+P in the Claude pane beside a
  file goes to Claude); Ctrl+Tab from a frame opens the switcher sticky as today
- [ ] write tests: `tab.close`, the flag and `pane.*` act on the target passed in, not `activeId`; a chord or discuss
  from a visible frame without the keyboard, or from a hidden one, is dropped; the web chord carries the frame's tab
- [ ] e2e: *file A to file B* — two files side by side, click into A then B: outline and `tabs.selected` follow, Cmd+W
  closes B, Ask Claude from B opens its box; *keys to the focused pane* — click into the file frame, native Cmd/Ctrl+W
  (`nativeChord`): the file tab closes, the Claude tab stays; with the Claude pane focused the editor's Ctrl+P does not
  reach the page; a pane focus chord typed in the frame puts the keyboard in the terminal (`domFocusInTerminal`)
- [ ] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split.spec.ts`)

### Task 5: Strip, menus and previews for page panes [model: sonnet]

**Files:**
- Modify: `src/renderer/tabs/TabBar.tsx`, `src/renderer/tabs/TabsPane.tsx`, `src/renderer/tabs/pane-commands.ts`
- Modify: `src/renderer/tabs/SplitArea.tsx`, `src/renderer/tabs/PageTabArea.tsx`, `src/renderer/styles.css`
- Modify: `test/unit/pane-commands.test.ts`, `test/e2e/editor-split.spec.ts`

- [ ] remove `PAGE_TAB_NOT_SPLIT` and the page-tab refusals in `splitBlocked`, `openBeside` and the `not-a-pane` text
  (`refusalText` keeps a generic line for it); `besideItems` and TabBar's Show beside list page tabs
- [ ] TabBar: the tab menu gets the split entries for a page tab; the drag gets pane mode (`paneable` on every kind);
  Split Right / Down on a focused page tab opens the New tab menu at the new pane
- [ ] the drop preview of a strip drag and the split menu's preview move into the layer's non-frame child (above the
  frames, `pointer-events: none`, placed from the same `edgePreview` rect), so they show over frames
- [ ] write tests: Split Right on a page tab opens the menu; `PAGE_TAB_NOT_SPLIT` is gone; Show beside offers page tabs
- [ ] e2e: *file beside Claude* by dragging the file tab to the right edge of the Claude pane (marker survives, typing in
  the frame changes the file, the Claude tab's `typed` stays false); *two files side by side* by Show beside: distinct
  boxes, a divider drag moves both, restored after a relaunch in the same group (new ids); *a menu over a frame*: the tab
  menu and the New tab menu over a file pane are on top and take the click
- [ ] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split.spec.ts`)

### Task 6: New tab in Group commands (chord + Alt) [model: opus]

**Files:**
- Modify: `src/shared/tab-commands.ts`, `src/main/commands/command-registry.ts`, `src/renderer/commands/keybindings.ts`
- Modify: `src/renderer/tabs/TabsPane.tsx`, `src/renderer/commands/web-keys.ts` (only if the decision below needs it)
- Modify: `test/unit/command-registry.test.ts`, `test/unit/tab-command-keys.test.ts`, `test/unit/web-keys.test.ts`, `test/e2e/editor-split.spec.ts`

- [ ] `inGroupCommandId(baseId)` / `parseInGroupCommandId(id)` beside `tabCommandId` (`tab.inGroup.<base id>`; the entry
  pattern has no dot, so no id reads as both)
- [ ] `CommandRegistry.defs` adds derived defs after core and entry ones: New Claude Tab in Group, New Shell Tab in Group,
  "New tab: <label> in Group" for each entry (none for an entry that opens as an overlay); `has`, `view`, `bindings`
  treat them as any command (own rows in Settings › Keybindings and the palette, rebindable, clearable)
- [ ] `resolveKeys` twice: pass 1 resolves everything else with overrides; each derived default is its base's resolved
  chord plus Alt, none when the base has no chord, is in an unresolved conflict, already has Alt, or that chord is bound
  in pass 1; pass 2 resolves all; a rebound base moves the derived default at the next `view`; the person's override
  of a derived command wins
- [ ] browser chords (decided by Oleg 2026-11-14): in a browser, `web-keys.ts` keeps New Claude Tab on Ctrl+Alt+T and
  New Shell Tab on Ctrl+Alt+Shift+T; the derived "… in Group" commands get **no chord in a browser** (the clash rule,
  rebindable there; Split Right/Down still open the New tab menu). The desktop and the Mac remote window keep
  Cmd/Ctrl+Alt+T and Cmd/Ctrl+Alt+Shift+T for "… in Group". Pin it in `web-keys.test.ts`
- [ ] renderer handlers (beside `tab.newClaude` and in `tabCommandHandlers`): `tabs.create` with `beside: { tabId:
  target, edge }`; `right` when `paneSize(target)` is wider than tall, else `down`; the other edge when `splitFits`
  fails; neither, or the group full: the strip's error line, nothing opens; a plain tab forms a group; the new pane takes
  the focus (`addPicked`); keys off: nothing
- [ ] write tests: derived ids and titles, none for an overlay entry; default = base + Alt; none when the base has Alt, has
  no chord or the chord is taken; follows a rebound base; the derived override wins; the handler picks right or down by
  pane shape and refuses when neither fits
- [ ] e2e: *New Claude Tab in Group* (Cmd+Alt+T, `nativeChord` from the frame) on a wide file pane opens Claude to its
  right, focused
- [ ] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split.spec.ts`)

### Task 7: Close all of a group asks about unsaved pages [model: sonnet]

**Files:**
- Modify: `src/renderer/tabs/close-confirm.ts`, `src/renderer/tabs/CloseTabDialog.tsx`, `src/renderer/tabs/TabsPane.tsx`
- Modify: `test/unit/close-confirm.test.ts`, `test/e2e/editor-split.spec.ts`

- [ ] `closeGroupQuestion` lists running members and, as their own kind of line, page members with unsaved changes
  (`tab.dirty` or this view's `isDirty`); asks when any member is unsaved whatever the setting, and when the setting is
  on and any member runs; `CloseQuestion.group` carries the unsaved ids
- [ ] `closeGroup` no longer returns early when nothing runs but something is unsaved; Close sends `discard: true` for
  exactly the listed unsaved members and a plain close for the rest; a member main refuses with `{ unsaved: true }`
  (dirty in another view not reported here) is asked about alone, or dropped and kept open when a dialog is already up
- [ ] server view: a group question with unsaved members is an `ApprovalDialog` (a `CloseTabApproval` variant) with no
  "Don't ask again" and the button "Discard and Close all"; a question with only running members keeps `CloseTabDialog`
- [ ] write tests: Close all with an unsaved page member asks with the setting off; the answer discards exactly the listed
  members; nothing unsaved and nothing running closes at once; server: an approval saying "Discard and Close all" with no
  "Don't ask again"
- [ ] e2e: *Close all with a dirty file* — type in one file, Close all: the dialog names it; Cancel keeps the group and the
  text; Close closes every member
- [ ] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split.spec.ts`)

### Task 8: Ask Claude preselects the Claude pane of the group [model: sonnet]

**Files:**
- Modify: `src/renderer/tabs/page-tab-discuss-model.ts`, `src/renderer/tabs/PageTabDiscussDialog.tsx`, `src/renderer/tabs/TabsPane.tsx`
- Modify: `test/unit/page-tab-discuss-box.test.ts`, `test/e2e/editor-split.spec.ts`

- [ ] `groupDiscussPreselect(root, claudeTabs, lastClaude)`: the group's Claude panes in reading order, `not-ready`
  (`discussReadiness`) skipped; `lastClaude` when it is in the group, else the first; none outside a group or with none left
- [ ] TabsPane's discuss handler calls it with the page's group and passes `preselect` to `PageTabDiscussDialog`; the
  dialog starts `target` there instead of `NEW_SESSION` (`orderDiscussTabs` lists it first) and falls back to New session
  when that tab closes; a plain page tab keeps New session with `lastClaude` first in the list
- [ ] main unchanged (`pageTabs.discuss` checks the target; Send armed after about a second); after a send the target
  Claude pane takes the focus and the file stays beside it
- [ ] write tests: plain page tab → none; one ready Claude pane → it; two → `lastClaude` when in the group, else first in
  reading order; `not-ready` skipped, all `not-ready` → none; a Claude tab outside the group never; the dialog starts on
  `preselect` and falls back when it closes
- [ ] e2e: *Ask Claude beside Claude* — with the file beside a Claude pane that has run a prompt (fake `claude`), the
  editor's Ctrl+L opens the box with that tab selected; the same file as a plain tab opens it on New session
- [ ] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split.spec.ts`)

### Task 9: Browser views, remote windows and server mode [model: sonnet]

**Files:**
- Modify: `src/renderer/tabs/PageTabArea.tsx`, `src/renderer/tabs/SplitArea.tsx` (only for what the specs find)
- Create: `test/e2e/editor-split-web.spec.ts`

- [ ] a browser view draws a group with a page pane once `groups.get` answers after `tabs.list` (the selected page tab
  fills the area until then, then moves into its pane: a box change, no reload); a web reconnect re-applies the boxes
  from the new tree and frames take a new port at `ready`
- [ ] server mode's hidden page: SplitArea draws the page pane sections with empty bodies, no frame mounts
  (`pageTabs.src` null), `ViewSizes` never measures it
- [ ] e2e (`enableWebAccess`, `openBrowser`; `CC_COCKPIT_NO_BUNDLED: ''`): *web view* — the desktop places a file beside
  Claude; the browser shows both panes with its own frame at the pane's box; a forwarded Ctrl+W from the browser's
  focused frame closes the file; the desktop's frame untouched until then; *two visible frames survive a web reconnect*
  (both markers stay)
- [ ] e2e (`launchServer`): a file pane in a group mounts no frame in the hidden page; Close all with a dirty file shows the
  approval in the browser and Discard and Close all closes the group
- [ ] run tests - must pass before next task (`npm test`, `npm run typecheck`, `npm run lint`, `editor-split-web.spec.ts`,
  `editor-web.spec.ts`, `split-views.spec.ts`)

### Task 10: Verify acceptance criteria [model: sonnet]
- [ ] every point of `docs/design-split-pages.md` implemented or listed in its §9
- [ ] edge cases: 8 page panes in one group (all live while shown, trimmed to 6 when hidden), a `'later'` page tab on
  relaunch (plain tab at the strip's end, group dissolved), a plugin `beside` naming a page tab (placed, never focused)
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:plugins`, `npm run build:editor` (bundle unchanged)
- [ ] `npm run test:e2e`

### Task 11: [Final] Update documentation [model: sonnet]
- [ ] `docs/features.md`: Split view (page tabs as panes, file beside Claude, Close all asks about unsaved files, Ask
  Claude's preselect), the editor entry (drop "A page tab is never a split pane"), the keybinding table with the
  New Claude Tab in Group / New Shell Tab in Group / "New tab: <label> in Group" rows (Cmd+Alt+T, Cmd+Alt+Shift+T; the
  GNOME / Ubuntu Ctrl+Alt+T note) and the browser chord outcome decided in Task 6; known limits (Firefox / Safari focus)
- [ ] `docs/design.md` §3 "Split groups" (every kind; `not-a-pane` kept for the next kind; `joinOrder` terminal members)
  and §4 "Page tabs" (frames placed per pane, the cap, the focus rule, chords naming their tab); `docs/design-editor.md` §1
- [ ] CLAUDE.md: the State paragraph on split groups (page tabs are panes, design in `docs/design-split-pages.md`), the
  "Split groups" pattern line (`isPaneKind` covers every kind; HostApi's `hasTab` any tab; `joinOrder` terminal only), the
  "Page tabs" pattern line (several frames placed, a frame takes the keys only with shell-side evidence, chords and Ask
  Claude carry the frame's tab)
- [ ] guide: `src/cli/guide/api.md` (a page tab may be a `beside` anchor; drop "never a split pane"), `plugins.md` where it
  says so; `src/sdk/types.ts` `OpenBeside` comment, then `cp src/sdk/types.ts examples/plugin/sdk/types.ts`; drift tests pass
- [ ] mark `docs/design-split-pages.md` status as implemented
- [ ] move this plan to `docs/plans/completed/` (done by the harness at the end)

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- desktop: a file beside a Claude tab; type in Claude while the file pane mounts (restore, Show Tab Beside); click between
  the panes, Cmd+W, Ask Claude; a divider drag over the frame
- a browser view (Chrome, then Firefox and Safari, which e2e does not cover): the same, plus a forwarded Ctrl+W and the
  in-Group chords in the browser
- on the Mac: the remote window to this VM with a file pane beside Claude (focus, chords, Ask Claude)
- Hyprland: focus behaviour while the e2e suite runs alongside (a window losing and regaining focus, the size take); a
  fast pointer crossing a divider into a frame

**External system updates:**
- example plugin repo: push the updated `sdk/types.ts` (`OpenBeside` comment only)
