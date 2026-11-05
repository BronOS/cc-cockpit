# cc-cockpit — next design (real-work round)

Status: built (app 0.10, 2026-11-05); unreleased until the version bump. Deviations from the text below, all additive:
`ctx.slots.available(type)` answers a `Promise<boolean>` (only main knows the project's pick); a provider slot needs `type`
and `entry`, `title` is optional; the Services group (service, open-file and slot picks) moved from Plugins to This Project;
side-panel settings sit on General; the bare-element rules of the component stylesheet are scoped to `:root:not(.cc-shell)`
so the shell keeps its own controls; the reviewer no longer `uses` the editor (its toolbar Edit is a type button that opens
micro at line 1); `SessionInfo` also gained `gist`. The plan with its per-task notes is
`docs/plans/completed/20261104-redesign-inbox-v2.md`. Turns decisions 9-14 of `docs/feedback/20261104-real-work.md` into designs;
decisions 1-8 and 15 (Inbox and its feed) are in the Inbox repo, `docs/design-v2.md`. `docs/design.md` stays the
source of truth for everything not named here; each section below ends with what it changes there. Where a decision
left a detail open, the simplest choice is written in and repeated under Open questions.

Target: app 0.10.x. The plugin API stays `api: 1`: every change is additive. `contributes` and the manifest top
level are lenient (`src/shared/manifest.ts`), so an older app ignores a new key silently, and a plugin that needs a
new member checks for it (`typeof ctx.slots === 'object'`) and says the app version in its README, as Inbox did for
0.9.7.

## 1. Component stylesheet and `ccc guide style` (decision 13)

Plugin pages look home-made today: every plugin draws its own buttons, inputs and rows with the theme's colour
tokens. The app ships one component stylesheet and one guide topic, and the review of a plugin page checks it uses them.

**Delivery.** `src/sdk/components.css` is the one copy. The panel SDK already adopts a constructable sheet (thin
scrollbars, `panel-core.ts`); it adopts the components sheet the same way, first in `adoptedStyleSheets`, with every
rule inside `@layer cc`. Unlayered CSS beats any layer whatever its specificity, so a plugin's own rule always wins and
nothing needs `!important`. A constructable sheet needs no CSP change. `panel.ts` takes the text through a Vite `?raw`
import, which inlines a string and creates no shared chunk (the `panel.js` `require` trap, CLAUDE.md). The shell's
`styles.css` imports the same file, so a settings form drawn by the shell and a plugin page are the same controls.

It reaches every page that loads `/__sdk/panel.js`: panels, html overlays, slots (§2) and html settings pages (§5).
Not url overlays or web views (foreign sites). A page without the SDK gets nothing, as with the theme today.

**What is in it.** Tokens are fixed, like radii and fonts today (themes stay colour-only): `--cc-space-1..6`
(4, 8, 12, 16, 24, 32 px), `--cc-radius-s` 4 px / `--cc-radius-m` 6 px, `--cc-text-s` 11 px / `--cc-text-m` 13 px /
`--cc-text-l` 15 px, `--cc-control-h` 26 px, `--cc-row-h` 28 px (compact) / 36 px. Colours only through the theme
tokens that exist.

| Component | Selector | Notes |
|---|---|---|
| Button | `:where(button)`, `.cc-btn`; `.cc-primary`, `.cc-danger`, `.cc-ghost`, `.cc-icon` | one primary per view; `.cc-icon` is a square 26 px button with a 16 px icon and a required `title` |
| Inputs | `:where(input, textarea, select)`, checkbox and radio | native-looking, the shell's focus ring |
| Field | `.cc-field` (label, control, `.cc-help`, `.cc-error`) | the settings form's layout |
| Card | `.cc-card`, `.cc-card-title` | a framed block; not for list items |
| List | `.cc-list` > `.cc-row` (`.cc-row-main`, `.cc-row-title`, `.cc-row-meta`, `.cc-row-actions`), `.cc-row[aria-selected]`, `.cc-row.cc-unread` | the row every item list uses; actions show on hover and focus |
| Group header | `.cc-group` (`.cc-group-title`, `.cc-count`), `details.cc-group` collapsible | lanes, Inbox groups |
| Chip / badge | `.cc-chip` (filters, toggle with `aria-pressed`), `.cc-badge` (short tag, palette names `green red blue amber violet grey`) | |
| Toolbar | `.cc-toolbar` | a row of controls at the top of a page |
| Tabs | `.cc-tabs` (`role="tablist"`) | |
| States | `.cc-empty`, `.cc-spinner`, `.cc-error-line`, `.cc-muted`, `.cc-kbd` | |

**`ccc guide style`** (`src/cli/guide/style.md`): the components with a short HTML example each, the spacing scale and
sizes, and the rules: rows for items, cards for a block that is not an item; one primary button; a destructive action
asks or offers undo; empty, loading and error states always drawn (`.cc-empty` says why and what to do); sentence case
labels; every icon-only control has a `title`; keyboard reachable, visible focus; no settings forms in a panel (§5).
Own controls only where no component fits (a timeline, a diff), still with the tokens. The `cc-cockpit` skill's
plugin-review rule and `ccc guide plugins` "before you publish" list name the topic.

**Main enforces** nothing (CSS in a sandboxed page). **Tests**: a drift test ties every `.cc-*` class in
`components.css` to `style.md` and back (as `cli-guide.test.ts` does for commands); a unit test that the SDK installs
the sheets in order and inside the layer; the hello plugin and `examples/plugin` pages use the components (the
example repo gets the same change). **Migration**: pages that style `button` partly (a colour, no border) now show the
layer's border under their rule; the bundled plugins (reviewer, files, editor) move to the components in the same
release, third-party pages see it on update. **Changes to design.md**: §4 Panels (the second sheet), §5 Panel side,
§7 (guide topic list).

## 2. Slots (decision 9; `sessions-strip` from decision 11)

A slot is a place in one plugin's panel (or in the app's chrome) where another plugin draws its own page: the Inbox
places an `agenda` slot, the Calendar fills it. The host of the slot only places it; the page in it is the provider's,
isolated like a panel, talking only to the provider's backend. Plugin code never runs inside another plugin's page,
and a sandboxed page cannot frame anything anyway (its CSP), so the **shell** draws slot frames, never the panel page.

**Slot type**: a name `^[a-z][a-z0-9-]{0,63}$`. Any plugin defines one by using it; the guide lists the known ones and
their meaning (`agenda`: today's events, a compact strip; `sessions-strip`: the Claude sessions of other windows, one
line). Names the app places itself (`sessions-strip`) are app slot types: a panel may not place them.

**Provider** (`plugin.json`):

```jsonc
"contributes": {
  "slots": [{ "type": "agenda", "entry": "slots/agenda.html", "title": "Today's agenda",
              "minHeight": 48, "maxHeight": 320 }]          // px; at most 10 slots per plugin; needs `main`
}
```

```ts
ctx.slots.onOpen(type: string, listener: (slot: SlotInstance) => void): Disposer   // type declared in contributes.slots
interface SlotInstance {
  readonly id: string                         // opaque, per frame
  readonly type: string
  readonly host: { kind: 'panel'; pluginId: string; panelId: string } | { kind: 'app'; place: 'top-bar' }
  readonly params: JsonValue | undefined      // from the placement; untrusted for the provider
  post(message: JsonValue): void              // the panel message rules and caps
  onMessage(listener: (message: JsonValue) => void): Disposer
  onClose(listener: () => void): Disposer     // frame unmounted (host panel hidden, placement removed, reload)
}
ctx.slots.available(type: string): boolean    // for a HOST plugin: would a placement of `type` draw now
```

Page side: the panel SDK unchanged (`ccPanel.post`, `onMessage`, `theme`), plus `ccPanel.slot`: `{ type,
setHeight(px) }`. A slot page sizes itself within `[minHeight, placement height]`; the default is the placement height.

**Host** (a panel that places slots):

```jsonc
"panels": [{ "id": "main", "title": "Inbox", "entry": "panels/main.html", "slots": ["agenda"] }]   // at most 4 types
```

```ts
ctx.panels.slots(panelId: string, placements: SlotPlacement[] | null): void
interface SlotPlacement { type: string; position: 'top' | 'bottom'; height: number; params?: JsonValue }  // ≤ 4
```

`position` is above or below the panel's own frame in the panel's column; `height` 24-600 px (clamped to the
provider's min/max). The Inbox's "Agenda: top / bottom / off" setting is a `slots(...)` call. Inline placement (a slot
inside the list) is not offered: it would need the panel page to report a rect for the shell to lay a frame over, the
web view's mechanism; see Open questions.

**Which provider.** The plugins of the project that declare the type, through `selectProvider` as providers of a
reserved name, as `@open-file` does: the pick is stored in `serviceProviders` under `@slot:<type>` (a plugin id or
`@none`). One candidate draws; several with no valid pick draw nothing and the Plugins page shows a "pick a provider"
row (the service rule); `@none` turns the slot off for the project. No provider: no slot, the panel's column is just
the panel. A change of pick needs no host restart (main re-sends the layout).

**Main enforces**: a placement's type is in that panel's manifest `slots` and is not an app slot type; the call names a
panel of the calling plugin (`HostApi`, as `panels.header`); the provider is enabled in the project, declares the type
and is the pick; the frame is a sandboxed iframe served by `cc-plugin://<provider>/` with the panel CSP and its own
`MessagePort` to the provider's backend (handed by main, `panel-ports.ts`), so the host panel gets no handle on it and
the provider sees only `params`. `params` is plain JSON of at most 4 KiB. At most 8 slot frames per window. Placements
follow the panel header's path: kept per project and panel in the layout service, pushed with `PanelInfo`, cleared when
the host plugin's ctx ends, it reloads, or the host stops.

**Lifecycle.** A provider reload remounts its frames (`onClose`, then `onOpen` in the new copy); a disabled provider
removes them; a hidden or collapsed host panel unmounts its slots; the frames live and die with the panel's.

**App slots.** The top bar holds the `sessions-strip` slot between the project name and the "+" (§4). Its height is
the bar's (fixed), its width the space left; the frame is `no-drag` on macOS. The pick works the same
(`@slot:sessions-strip`).

**Tests**: `selectProvider` over slot candidates and the `@slot:` keys (CLAUDE.md: code walking the picks as services
skips `@` keys); `HostApi` placement checks (undeclared type, app type, other plugin's panel, caps); the renderer's
column layout and height clamp; an e2e with two `agenda` providers and a pick, a hidden host panel, and a provider
disabled mid-session. **Changes to design.md**: §4 Panels (the column), §5 manifest, Host API table, the reserved-key
note next to Open file, §6 This project (slot picks).

## 3. Overlay: toolbar, type, buttons, loader, Discuss (decision 10)

The overlay kinds stay `html` (a plugin page), `terminal` (a command in a PTY) and `url` (a foreign site). What changes:
the title bar becomes the app's toolbar, an overlay can say what it shows (a type with data), buttons come from the
opener, from other plugins for that type, and from core, and the frame appears at once with a loader.

### 3.1 Spec and handle

```ts
// added to every OverlaySpec kind
interface OverlayExtras {
  type?: { name: string; data: JsonValue }  // name ^[a-z][a-z0-9-]{0,63}$; data plain JSON ≤ 4 KiB
  buttons?: OverlayButton[]                 // the opener's own, ≤ 4
  ready?: 'load' | 'manual'                 // html only: loader until the page loads (default) or calls ccPanel.ready()
  discuss?: { tabId?: string } | false      // Discuss's preselected tab; false hides Discuss on this overlay
}
interface OverlayButton { id: string; label: string; icon?: string; primary?: boolean; disabled?: boolean; busy?: boolean }

interface OverlayHandle {                    // existing members unchanged
  onButton(id: string, fn: () => unknown): Disposer        // a click on one of the opener's buttons
  setButtons(buttons: OverlayButton[]): void               // replace them (a "Mark read" that became "Mark unread")
  onDiscuss(fn: () => Promise<{ text: string } | null> | { text: string } | null): Disposer
}
type OverlayResult = /* existing */ | { kind: 'discussed'; tabId: string; queued: boolean }
```

Button ids 1-40 of `[A-Za-z0-9._-]`, labels 1-40 characters of plain text, `icon` a core icon name or a plugin `.svg`
(the panel header rule, `src/shared/panel-header.ts`, one parse rule for host and main).

**Well-known types** (a contract in `ccc guide api`, like services; main checks only the shape):

| Type | Data | Opened by |
|---|---|---|
| `file` | `{ path, mime? }`, `path` relative to the project folder | reviewer, file tree, `ctx.files.open` routes |
| `inbox-item` | `{ source, id }`, `source` the providing plugin's id | the source plugins (Gmail, Chat, Jira), directly or through the reviewer |

A plugin may define more types (`<name>` free; the guide asks for a plain noun and a stable data shape). Data reaching
a button plugin came from the opener, so it is untrusted input there: the Editor resolves `path` inside the project as
`editor.open` does today, a source checks that `id` is one of its own.

### 3.2 The toolbar

One row: title (ellipsis, full text as tooltip) · the opener's buttons · a divider · the buttons other plugins
registered for the type, in plugin-title order · Discuss with Claude · ✕ (before or after the title by the tab close
button setting, as today). More than 6 buttons besides Discuss and ✕ fold into a "…" menu. Buttons are drawn by the
shell as React text, keyboard reachable; there are no chords for them (Esc keeps its meaning: pops an html or url
overlay, belongs to the program in a terminal one). A terminal overlay gets the same toolbar.

### 3.3 Buttons by type, from other plugins

```ts
ctx.overlay.buttons(typeName: string,
  provider: (o: OverlayInfo) => OverlayTypeButton[] | Promise<OverlayTypeButton[]>): Disposer
interface OverlayTypeButton extends OverlayButton { run: (o: OverlayInfo) => unknown | Promise<{ close?: true } | void> }
interface OverlayInfo { readonly type: { name: string; data: JsonValue }; readonly title: string;
                        readonly opener: string /* plugin id, 'core' or 'cli' */ }
```

Registration is code, host-local, so a button can depend on the data and the plugin's state (Gmail shows "Mark read"
or "Mark unread" for its own `inbox-item`, nothing for Chat's; the Editor shows "Edit" for a `file` it can edit). When
an overlay with a type opens, main asks the window's host once (`overlay.buttons` RPC with type, data, title, opener);
the host calls every provider for that type, each bounded to 500 ms (a slow or throwing one is skipped and logged in that
plugin's log), keeps the `run` functions keyed by overlay, plugin and button id, and answers the plain list with each
button's plugin id, which the host knows from the registering ctx. A click goes renderer → main → host → that `run`,
with the overlay's info; the button shows busy until it settles (30 s bound, then it is idle again). `{ close: true }`
closes the overlay (the opener's `result` is dismissed). After any click settles, and on the opener's `setButtons`,
main asks again, so labels follow state. A click never reaches the overlay's page and gives no channel to it.

### 3.4 Open at once, with a loader

Main puts the overlay on the stack when the request arrives and the renderer draws the frame and toolbar at once with a
`.cc-spinner` in the body. html: until the page's load event and port (`pageReady`, default) or, with `ready:
'manual'`, until the page calls `ccPanel.ready()`; after 10 s the loader adds "Still loading…" and ✕ always works. url:
until the view's first `did-finish-load` or `did-fail-load`. terminal: until the first PTY output. The guide's pattern
for an opener that fetches first (a mail thread, an issue): `start({ ..., ready: 'manual' })` right away, then fetch,
then `post` the content (the outbox already holds messages until the port is up), and the page calls `ready()` once
drawn. Combined with a source answering `act(id, 'open')` by opening first, a click shows a frame within a frame.

### 3.5 Discuss with Claude (core)

Shown on every overlay that has a `type` or an `onDiscuss` handler, unless `discuss: false`; a bare overlay (a user's
lazygit entry, `ccc overlay --html`) has none. A click opens a small popover under the button:

- **Target**: a list of this window's Claude tabs (name, status) and **New session**. Preselected: `discuss.tabId`
  when it is a Claude tab of this window, else the active tab when it is Claude, else New session.
- **Note**: an optional text area (4,000 characters). Empty is fine: the old "needs a note or a comment" rule is gone.
- **Send** (Enter in the target list, Cmd+Enter in the note) / Cancel (Esc closes the popover only).

Main asks the opener's `onDiscuss` (host RPC, 5 s bound) for the context text, then builds the message: `About: <title>`
line, the type as a short line (`File: src/x.ts`, `Item: bronos.gmail thread`; unknown types as `name: key=value`
pairs, at most 500 characters), the opener's text, then the note; the whole capped at 20,000 characters (the context is
cut first, the note never). It always starts with `About:`, so the send gate's `/ ! # &` refusal never fires. An
`onDiscuss` that throws or times out shows its error in the popover and sends nothing; one that returns `null` means
"no extra context". An existing tab gets the text through the send gate (queued while busy, the queued chip as today);
New session opens a Claude tab in the project folder with the text as its first prompt (main's own open path, the
`sessions.open` argument rule, its own limit of 5 a minute per window, not counted against the opener). Then main
closes the overlay with `{ kind: 'discussed', tabId, queued }` and **selects the tab** in the window, so the person
sees where it went (fixes the "new tab opens but is not shown" feedback). The reviewer clears its draft on `discussed`.

### 3.6 What main enforces

Spec shape (`parseOverlaySpec` grows the new fields: type name and data size, button shape and count, `ready` only on
html); `setButtons` and clicks only for the opening plugin's overlay (HostApi looks it up by plugin and handle, as
`post`); a type button click only for a button main currently shows on that overlay, not busy or disabled (the
renderer drops those too); registered buttons are attributed by the host to its own plugins only, and main refuses an
id that is not one of the host's plugins; the Discuss target tab must be a Claude tab of the overlay's own window,
checked again just before the send; the composed text goes through the send gate like any other. Limits stay: 3 open
overlays and 10 a minute per plugin.

### 3.7 Migration and fit

- **Reviewer** drops its Discuss, New session and Edit buttons (and the tab picker): it tags a file review `file
  {path}`, passes `discuss: { tabId }` from the click, and answers `onDiscuss` with the review text it builds today
  (notes, comment, caps), asking its page for the draft. `annotate` gains `type?` and passes it through, so Gmail's
  thread in the reviewer is `inbox-item {source: 'bronos.gmail', id}` and gets Gmail's buttons.
- **Editor** registers `ctx.overlay.buttons('file', ...)`: "Edit" for a text file it can open; `run` opens micro on
  top (the review stays under it).
- **Sources** (Gmail, Chat, Jira) register buttons for their own `inbox-item`s from the item's actions (Mark read /
  unread, the source's done) and open their overlays with `ready: 'manual'` first. **Inbox** registers "Done (Inbox)"
  for every `inbox-item` (its own memory, Inbox design v2). A Jev-based plugin may register "Improve triage" there.
- `ccc overlay` keeps working; it sets no type (OQ). An overlay opened by an older plugin has no type, its own page
  buttons, and core's toolbar with ✕ only.
- **Changes to design.md**: §4 Overlay stack (toolbar, loader, Discuss), Two-way html overlays (handle members), §5
  Host API (overlay row), the reviewer paragraph under Bundled plugins, `plugins/reviewer/docs/design.md` Buttons.

**Tests**: spec parsing (unit, both sides); host button registry (timeouts, attribution, refresh after click,
dispose on reload); main's click checks; Discuss composition and caps, the send gate path and the tab selection (e2e
with the fake `claude`); the loader shown before `pageReady` and cleared by `ready()` (e2e with a page that waits).

## 4. Sessions as a bundled plugin (decision 11)

The top-bar strip and the Sessions panel move out of the renderer into a bundled plugin, `cockpit.sessions`, built on
the public API only (the bundled-plugins rule). Core keeps what only main can do or every tab needs: the session
registry, hooks, status, the send gate and queue, the title reader, gist, restore, the tab strip with its status dots.

### 4.1 API additions

```ts
// plugin.json, top level: a declaration the Plugins page and the install confirmation show
"access": { "sessions": "all-windows" }

ctx.sessions.list(opts?: { scope?: 'window' | 'all' }): Promise<SessionInfo[] | SessionSummary[]>
ctx.sessions.onChange(listener, opts?: { scope?: 'window' | 'all' }): Disposer   // throttled to 4/s as today
ctx.sessions.focus(tabId: string): Promise<boolean>          // select the tab; another window's: raise that window too
ctx.sessions.close(tabId: string): Promise<{ closed: boolean }>
ctx.sessions.rename(tabId: string, name: string | null): Promise<void>   // null: back to Claude's title
ctx.sessions.openFile(tabId: string, path: string): Promise<void>        // the old Sessions panel's file click

interface SessionInfo { /* existing */ readonly name?: string; readonly gist?: string }
interface SessionSummary {          // scope 'all': one per Claude tab of every window
  readonly tabId: string
  readonly own: boolean             // a tab of the caller's window (then the full SessionInfo is in list({scope:'window'}))
  readonly project: { readonly name: string; readonly color?: string }
  readonly status: SessionStatus
  readonly tool?: string
  readonly title?: string
  readonly name?: string
}
```

A plugin sees status, tool, title and name for other windows' tabs, never their prompts, notes, files, cwd or terminal
content, and gets no new way to type: `send` stays this window's tabs and the gate. `scope: 'all'` needs the `access`
declaration; without it the call throws. `rename`: 1-60 characters of plain text (control, bidi and invisible format characters refused), stored
on the tab's restore record, shown by the tab strip and every plugin as `name` over `title`; core's tab menu gets
Rename too, so renaming does not depend on the plugin. `close` goes through the person's close path: a running tab
asks (`CloseTabDialog`, the `confirmTabClose` setting) in its window, which is shown first; `closed: false` on Cancel.
`openFile` does what the core panel's click did: main checks the file is one it recorded for that tab and routes it
(the `@open-file` pick, else the built-in viewer), outside-project files included.

**Main enforces**: `focus` reaches any Claude tab (the strip's click today, `sessions.focus` IPC); `close`, `rename` and
`openFile` only this window's tabs (main's lookup of the host's project, never the id's claim); `scope: 'all'` only
for a plugin whose manifest declares it; limits per plugin and window: focus 10 per 10 s, close 10 a minute, rename 30
a minute, openFile 20 per 10 s (the `files.open` budget).

### 4.2 `cockpit.sessions`

- **Panel** `sessions` (default zone left), the cards of today's panel: name or title, gist or last prompt, status,
  notes, steps, changed files (first N, Show all), a file click through `openFile`, a card click through `focus`.
  Header meta "2 in this window".
- **Slot** `sessions-strip`: the other windows' Claude tabs, needs-you first and tinted, project colour dot, a click
  through `focus`. With no other window's session it draws nothing (the bar keeps the "+").
- **Settings** (app): `filesShown` 1-500, default 10 (moved from `app.json` › `sessionFilesShown`, read once at
  first start of 0.10 and copied). `sessionGist` stays a core setting (main runs it).
- Declares `"access": { "sessions": "all-windows" }`; plain DOM with the component stylesheet, no React.

**Replacing it**: another plugin provides `sessions-strip` and appears in its pick; the panel is replaced by turning
`cockpit.sessions` off (project or app-wide) and enabling one's own. With neither, there is no strip and no Sessions
panel: the tab strip's dots, `ccc sessions` and notifications still work.

**Migration**: the layout's core Sessions panel key becomes `cockpit.sessions/sessions` at first load (same zone, order
and open state); `SessionsPanel.tsx` and the strip component are removed from the renderer; the strip's IPC snapshot
(`own` list) is replaced by `scope: 'all'`. **Tests**: scope checks and field filtering (unit, `HostApi`); focus
across windows, close with the dialog, rename persisted over restore (e2e, two windows, fake `claude`); the bundled
plugin's own `node:test` suite; an e2e with the plugin off (no strip, no panel, tabs fine). **Changes to design.md**:
§1 What belongs in core (the status view leaves core; the registry stays), §3 Claude status UI, §5 Host API sessions
row, Bundled plugins list, CLAUDE.md's bundled list.

## 5. Settings (decision 12)

### 5.1 One place

The settings screen stays the full-window layer it is today (Cmd+,, the top bar's gear), reorganised into pages:

- **General**: tab behaviour (exit, first tab, ask before closing), app-wide new-tab commands, notifications and sound,
  session gist, the command line (`ccc` install, offer at start), update notice.
- **Appearance**: theme, window background, terminal font, tab close button side.
- **Keybindings**: its own page (from Appearance and keys): search, the list with core, plugin and tab-entry commands,
  overrides, conflicts, Unbind, Reset.
- **Plugins**: installed and marketplace merged (§6); per plugin a gear opening its **global** settings.
- **This Project**: colour, enabled plugins, the project's new-tab commands, panel zones, slot and service picks, and
  per plugin its project settings.
- **Projects**: unchanged (list, relink, forget).

Every setting lives in exactly one of these. No plugin settings form inside a panel: the guide and the review rule say
so; a panel may still hold a sign-in flow (paste a client file, Sign in), which is an action, not a setting.

### 5.2 Global values and project overrides

Manifests keep `settings.app` and `settings.project`:

- `app` fields are app-wide by meaning (Jev's caps, the editor's micro path): edited only on the global page, never
  overridden per project. `ctx.settings.app` unchanged.
- `project` fields now have a **global value** too, set on the global page (Plugins › gear), and This Project shows each
  with "Use global" (default) or an override. `ctx.settings.project[field]` = the project's override, else the global
  value, else the schema default. Top-level fields only; an object field is overridden whole.
- Storage: global project-field values in `app.json` › `pluginProjectDefaults[pluginId]`; overrides stay where project
  values are today (the project record); "use global" = the key absent. A secret project field's global value is
  `setting:projectDefault:<field>` in the plugin's secret store (a new reserved key form under `setting:`), an
  override `setting:project:<projectId>:<field>` as today; the host gets the effective plaintext.
- Validation: the schema checks the effective object, so a global value plus overrides must validate together; a
  save that would make any open project's effective values invalid is refused with that project named.
- `ctx.onSettingsChange` fires in every project whose effective values changed (a global edit reaches all projects
  that use global).
- CLI: `ccc plugin config <id> --scope global key=value` (global value of a project field), `--scope project` (an
  override), `--use-global key` (drop an override). `--scope app` unchanged.

**Migration**: at first start, for each project and plugin, a stored project value equal to the schema default is
dropped (it becomes "use global", and the global value starts as the default, so nothing changes); every other value
stays an override. Secrets stay project overrides.

### 5.3 The panel gear

The app draws a gear in the header of every panel whose plugin has settings, after the plugin's actions and before
"…". It opens This Project at that plugin when the plugin has project settings (a `project` schema or an html page with
project scope), else its global page. A plugin header action with the `settings` icon is then redundant; the guide says
not to add one.

### 5.4 Plugin html settings page

For what a form cannot hold (Inbox's rules editor):

```jsonc
"contributes": { "settings": { "app": { ... }, "project": { ... },
  "page": { "entry": "settings/index.html", "scopes": ["app", "project"] } } }   // needs `main`
```

```ts
ctx.settingsPage.onOpen((page: { scope: 'app' | 'project'; post(m: JsonValue): void;
  onMessage(fn: (m: JsonValue) => void): Disposer; onClose(fn: () => void): Disposer }) => void): Disposer
```

The page shows under the plugin's schema form on its global or project page (per `scopes`), in a sandboxed iframe like
a panel (`cc-plugin://`, the panel CSP, the SDK with theme and components, its own port to the plugin's backend in this
window's host). The page has no settings API of its own: the plugin stores what it edits where it wants (`ctx.appStorage`
for app scope, `ctx.storage` for project scope) and validates it. It never receives secret values (none are in a
page's reach unless the plugin posts them; the guide says never). A plugin not enabled in this project has no backend
in this window: its page shows "Enable <plugin> in this project to edit this page" (the schema form still works).

**Main enforces**: the page is served only from the plugin's folder; the port goes to that plugin's backend in the
sender's window; one page frame per plugin at a time. **Tests**: effective-value merge and validation (unit, both
secret and plain), migration of defaults, `onSettingsChange` fan-out, the gear target, the html page port (e2e with
hello's page). **Changes to design.md**: §6 Settings list, "All plugin forms are rendered from the manifest" (now: forms
plus an optional page), §6 CLI table (`plugin config`), secrets reserved keys.

## 6. Marketplace (decision 14)

### 6.1 Preview image

- The plugin repo holds `preview.png` at the root at the pinned tag: PNG, at most 512 KiB, 1280×800 (16:10; 640×400 to
  1600×1000 accepted), no animation chunk.
- The index repo's CI (`check-entry`) already clones the tag; it reads `preview.png` from the checkout (regular file, no
  symlink), checks the PNG signature, IHDR size and the byte cap without decoding anything else, and publishes the bytes
  next to `index.json` as `previews/<id>/<commit>.png`. The entry gets `preview: { sha256 }` (`build-index`).
- The app fetches a preview lazily (when its card is on screen) from the index's own folder, refuses a redirect or a
  body over 512 KiB, checks the sha256 and the PNG signature, and caches it under `<data>/marketplace/previews/`. Main
  hands the renderer the bytes over IPC; the page shows them from a `blob:` URL (`img-src blob:` added to the shell
  CSP). Plugins installed by folder or git show their own `preview.png` through `cc-plugin://` when present.
- `parseEntry` accepts `preview` (optional in the app: an entry without one shows a neutral placeholder with the
  name's initial). CI: a new listing or version without `preview.png` is refused after the grace date (60 days after
  the release with this rule); until then it passes with a warning in the PR. Existing listings without one get the
  same warning on every run and stay listed.

### 6.2 Categories, pagination, search

- Entry field `category`: one of `sources`, `views`, `tools`, `themes`, `claude`, `other` (absent = `other`), checked by
  `parseEntry` and CI (unknown values drop to `other` in the app, refused in CI).
- The page fetches the whole index (it does today; at most 5 MiB and 2000 entries) and pages it in the renderer: 20 per
  page, search over name, id, author and description (case-insensitive substring, no regex), filters Installed /
  Available / Updates, and category. No server, no new fetch per page.

### 6.3 One Plugins page

Marketplace merges into Plugins: one list of cards (preview, name, author, version, repo as plain text, description,
state), with the filters above. Per card: Install / Update / Move to safe version / Enable in this project / gear /
Off in all projects (bundled) / Uninstall, as applicable. "Add plugin…" holds git URL install and Link folder. Index
management (add, remove, refresh, errors) is a collapsible section at the bottom. The Plugins page still never touches
the network except through the marketplace fetch it already makes.

### 6.4 Update all

A button on the Plugins page when at least one marketplace-installed plugin has a newer listed version from its
recorded index. One confirmation lists every plugin with its current and new version, repo and commit; on Confirm main
runs the same checked update per plugin, one at a time (clone the tag, `rev-parse HEAD` against the pinned commit,
`expect` from what the confirmation showed, revocation check, the repo-change rule), and lists the failures after with
their reasons; successes are not rolled back by a later failure. Linked, git-URL and revoked plugins are never in it.

**Tests**: `parseEntry` with `preview` and `category`; the CI tools on a fixture repo with a good, oversized, wrong-size
and symlinked preview (the dist is committed and byte-compared); preview fetch and hash check (unit, fake fetch);
paging and search logic (unit); Update all with one failing update (e2e with `file:` index). **Changes to design.md**:
§5 Marketplace (preview, category, Update all), §6 Settings list, the `marketplace/` template README.

## Order of work

1. **Component stylesheet** (§1): small, and every later page uses it.
2. **Slots** (§2): Inbox's agenda and the sessions strip need it.
3. **Overlay toolbar, types, buttons, loader, Discuss** (§3), with the reviewer and editor migration.
4. **Settings** (§5): pages, overrides, panel gear, html page (Inbox's rules editor needs it).
5. **Sessions plugin** (§4): builds on slots and the toolbar's tab selection path.
6. **Marketplace** (§6): independent; the index repo's CI change can go first, the app part any time.

Then Inbox v2 and the source plugins (Inbox repo, `docs/design-v2.md`), which need 1-4.

## Decided questions

All accepted as recommended (Oleg, 2026-11-04).

1. Settings as a separate OS window instead of the in-window layer? Recommended: keep the layer (This Project and html pages need the window's host).
2. Keep a Projects page beside the five named ones? Recommended: yes, unchanged.
3. Inline slot placement (inside a panel's list)? Recommended: not now; top and bottom only.
4. Several slot providers and no pick: draw none (service rule) or the first by title? Recommended: none, with the Plugins page warning.
5. `ctx.sessions.close` and `rename` for other windows' tabs? Recommended: this window only.
6. Name and shape of the declaration for cross-window sessions (`"access": { "sessions": "all-windows" }`)? Recommended: as written.
7. Other windows' sessions: add gist or last prompt to `SessionSummary`? Recommended: no, status/tool/title/name only.
8. Discuss closes the overlay after sending? Recommended: yes, so the selected tab is visible.
9. Discuss on bare overlays (no type, no `onDiscuss`)? Recommended: hidden.
10. `ccc overlay --type <name> --data <json>`? Recommended: later, when a script needs buttons.
11. Allow per-project overrides of `app` fields? Recommended: no; `app` means app-wide.
12. An opt-out of the component stylesheet for a page? Recommended: none; the layer makes plugin CSS win.
13. Preview size and cap (1280×800, 512 KiB)? Recommended: as written.
14. Category list (`sources, views, tools, themes, claude, other`)? Recommended: as written, one per entry.
15. Preview grace period length? Recommended: 60 days from the release that adds the rule.
