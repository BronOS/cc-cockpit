# Shell UI selectors for e2e specs

For a spec writer who does not read the renderer: what to locate each shell surface by, the helper that
already does it, and the traps. Every entry is taken from the specs in this folder and `src/renderer`.
Test ids are marked testid:NAME in backticks (`<key>` stands for a variable part); `selectors-guide.test.ts`
fails when one of them is gone from `src/renderer`, so keep that marker for every id listed here.

## Before you start

- `launchCockpit` / the `test` fixture (`fixtures.ts`) start with no bundled plugins
  (`CC_COCKPIT_NO_BUNDLED=1`): no Files, editor, Browser, Sessions panel or sessions strip. Launch with
  `env: { CC_COCKPIT_NO_BUNDLED: '' }` to get them, then wait for `pluginActive(c, 'cockpit.files')`
  (`download-fixtures.ts`) before touching their panels.
- A fresh data dir has `confirmTabClose: false`, `claudeTabOnOpen: false` and `zoneAutoHide: false`
  (see the `LaunchOptions` fields): no close question, an empty window, no auto-hidden zone.
- The window is ready when `.tabs-pane` is attached (the picker: `.picker`).
- Role names match by substring unless `exact: true`: `'Close'` also hits `Close settings`,
  `Close overlay` and `Close Shell`; `'Settings'` hits the Settings dialog, the top strip's gear and a
  plugin card's Settings toggle. Scope to a container (`settings.getByRole(...)`) or pass `exact: true`.
- Keys: `MOD` (`split-fixtures.ts`) is Meta on macOS and Control elsewhere; Playwright also takes
  `ControlOrMeta+,`.

## Tab strip and tab menu (`TabBar.tsx`)

| What | Locate by |
| --- | --- |
| The strip | `role=tablist` (no name) |
| A tab | `getByRole('tab', { name: /^Shell/ })`; the name is the tab's label (a Claude tab's session name or title) plus ` (not started)` / ` (exited)`. A page tab is a tab too (`/notes\.txt/`) |
| The selected tab | `getByRole('tab', { selected: true })`; its wrapper is `.tab.active[data-tab-id="<tabId>"]` |
| A tab's wrapper, by id | `.tab[data-tab-id="<tabId>"]` (also `data-flag="<colour>"`, `data-attention`) |
| Close a tab | `getByRole('button', { name: 'Close <label>' })`, e.g. `/^Close Shell/`; dimmed (not hidden) until the tab is hovered or active, so no hover is needed |
| New tab | button `New tab`, then `menuitem` `Claude` / `Shell` / a custom command; helper `cockpit.newTab('claude' \| 'shell')` |
| Overflow list | button `All tabs` opens `menu` `All tabs` |
| Tab menu | right-click the tab (`tab.click({ button: 'right' })`), then `menu` `Tab` |
| A split group in the strip | `role=group`, named after the group (`zoomed (n hidden)` when zoomed), `[data-group-id]`; right-click its handle `[data-group-handle]` (a click shows the group) for `menu` `Split group <title>` (Rename, Equalize, Ungroup, Close all) |
| Tab switcher (Ctrl+Tab) | `dialog` `Switch tab`, `listbox` `Open tabs`, `option`s |
| Command palette (`MOD+Shift+P`) | `dialog` `Command palette`, `combobox` `Command`, `option`s |

Tab menu items (`menuitem` unless said): `Move left`, `Move right`, `Rename` (Claude tabs only),
`Split right`, `Split down`, `Show beside ▸` (opens `menu` `Show <label> beside` with `Right of <label>`
and `Below <label>`), `Move out of group`, `Deliver room messages automatically` (`menuitemcheckbox`), a
`group` `Flag` of `menuitemradio`s `Flag Red` … , `Edit note…` (opens `dialog` `Flag note`),
`Clear flag`, `Close`. A guest sees fewer: a write guest only `Close`, a read guest no menu.

Traps:
- Every strip menu (New tab, All tabs, Tab, Show beside, Split group) closes on Escape or on a click
  the window sees. Close it with `page.keyboard.press('Escape')` before the next step: left open it
  sits over what you click next, and a click into an iframe (a panel, a page tab, an overlay) never
  reaches the window, so it does not close the menu at all.
- `Rename` and `Edit note…` open an inline editor (`textbox` `Tab name` / `Note`); Enter saves, Escape cancels.

## Split panes and their headers (`SplitArea.tsx`, helpers in `split-fixtures.ts`)

| What | Locate by |
| --- | --- |
| A pane | `section[data-pane="<tabId>"]`, `role=region` named after its tab (plus `, <asking status>`); `paneOf(page, tabId)` |
| Visible panes | `visiblePanes(page)` (`[data-pane]:visible`; a pane hidden by zoom or another group is `hidden`) |
| The focused pane | `data-focused-pane="<tabId>"` on its pane, only while more than one pane shows; `focusedPanes(page)` |
| A pane header | `[data-pane-header]` inside the pane, only while more than one pane shows (`data-focused` on the focused one) |
| Dividers | `role=separator` with `[data-split-divider]`; `dividers(page)` |
| The split area | `[data-split-area]` with `data-zoom="manual" \| "auto"`; `splitArea(page)` |
| A pane still starting | `region` `Starting tab` |

Make splits through `place`, `createTab` and `groupOfShells` (`split-fixtures.ts`: the same intents the UI
sends) rather than by dragging. `groupOfShells` and `roomyDesktop` widen the window first: three or four
panes on the default window fall under the auto-zoom size and only one is drawn.

## The terminal of the selected pane

- With one pane shown, `cockpit.terminalText()`, `waitForTerminalText()` and `typeLine()` (`fixtures.ts`)
  and the browser's `terminalText()` / `waitForTerminalText()` (`web-fixtures.ts`) read
  `.terminal-view:not([hidden])`. Use them only then.
- Right after a new tab, those helpers can still read the tab before it: a second shell's
  `FAKE-SHELL ready` is on the first one's screen too, so waiting for it proves nothing. Take the new
  tab's id (`tabsOf` before and after) and wait on `paneOf(page, id)`, as `newTaggedShell` does.
- With a split shown, several `.terminal-view`s are visible at once and those helpers read or click
  the wrong one. Address the pane instead: `const id = await page.locator('.tab.active').getAttribute('data-tab-id')`,
  then `paneOf(page, id)`, and `paneText`, `waitPaneText`, `typeInPane`, `tagPane` (`split-fixtures.ts`).
  Text lives in `.xterm-rows > div`; click `.xterm` to give a terminal the keys.
- A pane is easiest to tell apart by what it printed: `tagPane` / `newTaggedShell` make it print `<tag>-2`,
  then `paneShowing(page, '<tag>-2')`.
- `domFocusInTerminal(page)` says whether the keys are in a terminal; a view can be "keys off".
- A terminal overlay has its own xterm under `.overlay[data-kind="terminal"]`, outside `.terminal-view`.

## Overlays and their toolbar (`OverlayStack.tsx`, `OverlayToolbar.tsx`)

| What | Locate by |
| --- | --- |
| An overlay | `getByRole('dialog', { name: '<overlay title>' })`, or `.overlay[data-kind="html" \| "terminal" \| "url"]` |
| Its page | `page.frameLocator('iframe[title="<overlay title>"]')` |
| Its toolbar | `.overlay[data-kind="html"] .overlay-header`; title `.overlay-title` |
| A toolbar button | by its label (`toolbar.getByRole('button', { name: 'Edit' })`), or `[data-button-id="<id>"][data-source="opener" \| "type"]` |
| Overflowed buttons | button `More buttons`, then `menu` with `menuitem`s |
| Discuss | `group` `Discuss with Claude`: buttons `Discuss in a new Claude session` and `Discuss in an existing session`; the latter opens `dialog` `Discuss in an existing session` with `listbox` `Send to` |
| Close | button `Close overlay` |
| Still loading | `.overlay-loader` (gone when loaded) |
| Held by another device | `testid:held-elsewhere` with button `Take over` |

Escape pops the top html or url overlay only. In a terminal overlay Escape goes to the program: close it
with `Close overlay` or `MOD+Shift+KeyW`.

## Approval dialogs (`ApprovalDialog.tsx`)

An approval is `role=alertdialog`, never `dialog`: `getByRole('alertdialog', { name: '<title>' })`. Its Allow
button is enabled only after the dialog has been on top, in a focused, visible window for about a second
(`APPROVAL_ARM_MS`). Wait with `await expect(allow).toBeEnabled({ timeout: 5_000 })`, then click.

- A press begun before it armed does not count when released after; Enter and Space do nothing inside;
  Escape is Deny. The backdrop (`testid:approval-backdrop`) blocks clicks but answers nothing.
- One under another approval is disarmed and needs a fresh second once on top again.
- A window without focus never arms (the page checks `document.hasFocus()`), which matters with a
  desktop and a browser app in one spec: keep the window that must answer focused.
- It takes no focus: keys you type keep going to the terminal.

| Approval | Title / ids |
| --- | --- |
| Download offer (`ccc download`) | `testid:download-offer`, Allow `testid:download-offer-accept`, Deny `testid:download-offer-cancel`, path `testid:download-offer-path` |
| A guest asks to close the owner's tab | `testid:guest-close-ask`, `testid:guest-close-allow` (Close tab), `testid:guest-close-keep` (Keep open) |
| Give a guest write | `testid:guest-upgrade-confirm`, button `Allow write` |
| Create an invite | `testid:guest-invite-confirm`, button `Create invite` |
| Show a plugin to guests | `testid:guest-show-confirm`, `testid:guest-show-allow`, `testid:guest-show-cancel` |
| Remove a room member | `testid:room-remove-ask`, title `Remove <name> from the room “<room>”?`, button `Remove` |
| Picker: Trust this host? / certificate | `testid:remote-hostkey-prompt` (`testid:remote-hostkey-trust`, `testid:remote-hostkey-cancel`), `testid:remote-cert-prompt` (`testid:remote-cert-trust`, `testid:remote-cert-cancel`) |
| A server's browser: web access Revoke / Disconnect | title `Revoke <device>?` / `Disconnect <device>?`, button `Revoke` / `Disconnect` (the desktop acts at once, no ask) |
| In a browser of a server: link a plugin, trash a file, close the project, discard unsaved | `/Link plugin …/`, `/Move the file … to the Trash/`, `/^Close .+ for every device\?$/`, `Close “<tab>”?` with `Discard and Close` |
| A guest on a desktop host: Move to Trash | Deny only (no Allow button), with a note naming the owner |

## Core dialogs (not approvals)

These are `alertdialog`s too, without the one-second wait:
- Close a tab (`CloseTabDialog.tsx`, only with `confirmTabClose: true` or unsaved text): title `Close “<label>”?`
  or `Close all tabs of “<group>”?`; buttons `Cancel`, `Close` / `Close all` / `Discard and Close`; checkbox
  `Don't ask again`. Escape or a backdrop click cancels. In a server's browser an unsaved close is the
  approval above.
- Link a plugin on the desktop (`ShellNotices.tsx` `LinkDialog`): `/Link plugin <id>/`, `Deny` / `Allow`.
  Allow is armed at once, but disarmed while an approval covers it. While it is up `#root` is inert,
  Escape denies and a backdrop click denies. A browser of a desktop gets it with Deny only (Allow is
  the desktop's), shown on both: `getByRole('alertdialog')` in each page.
- Install the ccc command: `alertdialog` `Install the ccc command?` (`testid:ccc-offer`).
- Claude Code not found: `alertdialog` `Claude Code was not found` (or `Claude Code is not on the PATH`)
  (`testid:claude-offer`); its command lines `testid:claude-offer-command` / `claude-offer-path`, each with a
  `Copy …` button; buttons `Not now` and `Install in a new tab`. Settings › General: `testid:claude-code`.
- Web access risk confirm: `testid:web-access-risk-confirm`, armed at once like the link confirm (one
  or more steps); Cancel or Escape leaves loopback.

While a portalled confirm is up `#root` is inert, and Playwright's `toBeVisible` / `click` look straight
through anything painted over it; `web-access-settings.spec.ts` `paintedOnTop` checks what is really on top.

Other plain `dialog`s: `Settings`, `Guests`, `Group name`, `Flag note`, `Connect to server`, `Open folder`,
the room dialog (`testid:room-dialog`), the invite dialog (`testid:guest-invite-dialog`).

## Zones, panels and their menus (`zones/`)

| What | Locate by |
| --- | --- |
| A zone's icon strip | `toolbar` `<Zone> panels`, `[data-zone]`; scope by `.zone-left` / `.zone-right` |
| A panel's icon | button named after the panel, plus `, <n> new` / `, needs you` / `, has an error`: `getByRole('button', { name: /^Files/ })` |
| A panel | `section.panel[aria-label="<title>"]`, `[data-panel="<pluginId>/<panel>"]`; its page `frameLocator('section.panel[aria-label="<title>"] iframe')` |
| Panel header | button `Move or hide <title>` (opens a menu), `Settings of <title>`, actions by their title |
| Hidden panels | button `Hidden panels`, then `menu` `Hidden panels` |
| Zone resizers | `separator` `Resize left zone`, `Resize <panel title>` |

The icon menu (right-click an icon: `Move up`, `Move down`, `Move to top`, `Move to <other zone>`, `Hide`)
closes on Escape or a click outside the strip; close it before the next step.

## Settings (`settings/`)

Open with `page.keyboard.press('ControlOrMeta+,')`; the dialog is `getByRole('dialog', { name: 'Settings' })`.
Pages are buttons in `navigation` `Settings sections`: `General`, `Appearance`, `Keybindings`, `Plugins`,
`This Project`, `Projects`. Close with button `Close settings` or Escape. While it shows, `.zones` is inert.

- Keybindings: a row's buttons (`Change`, `Unbind`, `Reset`) are `opacity: 0` until the row is hovered or
  focused. Playwright still clicks them; hover first if you check what a person sees.
- Plugins: a row is `[data-plugin="<id>"]` (also on This Project). The list is `list` `Plugin list`, paged
  20 a page (`group` `Pages`), filtered by `searchbox` `Search plugins`. Row buttons:
  `Settings` (toggles the forms `testid:app-settings-form`, `testid:project-defaults-form`), `Limits`
  (`testid:plugin-limits`, rows `testid:limit-<key>`), `Uninstall`. `Add plugin…` opens `form`
  `Install a plugin`. Guests: `combobox` `Guests: <name>` in `testid:plugin-guests`, explained in
  `testid:plugin-guests-text`; picking Shown asks the approval above. Service problems:
  `testid:service-warning`. A plugin page off here says so in `testid:settings-page-not-enabled`.
- This Project: `checkbox` `Enable <name>`, service picks `testid:service-picks`, guests
  `testid:project-plugin-guests` (`combobox` `Guests of <name> in this project`).
- General: global caps `testid:global-plugin-limits`; the `ccc` row `testid:ccc-command`.
- Web access (on General, heading `Web access`, `exact: true`): `checkbox` `Allow browsers to connect`,
  `combobox` `Sign-in`, owner name `testid:web-access-owner-name`, the access link `testid:web-access-link` (buttons `Show` / `Hide`), risks
  `testid:web-access-risks`, short password `testid:web-access-password-short`, devices
  `testid:web-access-devices`, each `testid:web-access-device` with `Disconnect` / `Revoke`, and
  `testid:web-access-none-revoke`. A server's browser shows a read-only card instead of the form:
  `testid:web-access-server-card` with rows `testid:web-access-row-<key>` (`mode`, `none`, `confirm`,
  `address`); its device buttons ask first (the approvals above). Prefer `enableWebAccess(cockpit)` (`web-fixtures.ts`) to the form
  when the form is not what is tested.
- There is no Guests page: guests are the top strip's `Share` button (opens `testid:guest-invite-dialog`,
  link `testid:guest-invite-link`) and its chip `Guests: …` (opens `dialog` `Guests`, a `radiogroup`
  `<name>'s role` with `radio` `Read-only` / `Write` per guest). Prefer `inviteGuest`
  (`guest-fixtures.ts`) when the dialog is not what is tested.

## Top strip and sessions strip (`status/TopStrip.tsx`)

- The strip: `header.top-strip`; `navigation` `Claude sessions`; buttons `Open project…`, `Settings`
  (`exact: true`), the web access chip `Web access: …`, `Close project` (a server's browser only).
- The sessions strip is cockpit.sessions' slot page (bundled plugins on):
  `[data-slot-frame][data-slot-plugin="cockpit.sessions"]`, its page
  `frameLocator('.top-strip iframe[title="sessions-strip slot"]')`, an entry `.entry` inside.
  Any slot frame: `[data-slot-frame][data-slot-type="<type>"]`, iframe title `<type> slot`.
- Queued texts on a tab: button `queued <n>`, then `menuitem` `Cancel queued text: …`.
- Notices over the shell: `testid:page-notice`, `testid:download-ready`, `testid:download-failed`,
  `testid:oauth-notice`, `testid:web-confirm-card`, `testid:guest-close-notice`; in a guest's view
  `testid:guest-banner` (its `data-role` is `read` or `write`).

## Files panel and editor page tabs (bundled plugins)

The page inside is the plugin's, not `src/renderer`, so these are classes, not test ids.
- `filesTree(page)` (`download-fixtures.ts`) opens the Files panel and returns its frame;
  `treeRow(tree, 'notes.txt')` is the `.row` named exactly so (`role=treeitem`).
- A file row's `Edit` button is `display: none` until the row is hovered or selected:
  `await row.hover()`, then `row.getByRole('button', { name: 'Edit' }).click()`.
- Right-click a row for `tree.getByRole('menu')` (`Open`, `Rename…`, `Move to Trash`, `Download` in a
  browser …); it lives in the frame, so close it with Escape (the frame has the keys), not a click outside.
- An editor page tab: `getByRole('tab', { name: /notes\.txt/ })`; its frame
  `iframe.page-tab-frame[title="notes.txt"]` (the selected one: `iframe.page-tab-frame:not([hidden])`;
  several are visible in a split, so go by title). Inside: `.cm-content`, save state `#state`
  (`Unsaved`).
- A page frame gets the keys only with evidence the person reached it: move the mouse over the shell
  next to the frame (or hover its `[data-pane-header]`) before clicking into it. A click whose pointer
  jumped straight into the frame leaves the keys nowhere.

## Picker and browsers

- Desktop picker (top strip `Open project…`): `.picker`, `list` `Recent projects` (a row `.picker li`,
  `hasText` its path, then its button named after the project, `exact: true`), `Connect to server…`.
  A browser's picker has `Open folder…` (`dialog` `Open folder`).
- A browser on the gateway: `openBrowser(link)` (`web-fixtures.ts`), then `openProjectInBrowser` or
  `joinProject` (`download-fixtures.ts`): `list` `Open projects`, link `a[href="?project=<id>"]`.
- Server mode: `launchServer()` (`server-fixtures.ts`); `server.cockpit.page` is the hidden page, never
  shown. Act from a browser on `server.origin`; `ccc(server, [...])` and `addDeviceLink` run the CLI.
