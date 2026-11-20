# Overlays in every view (guests included)

External review: sol / high

## Overview
- Html overlays of plugins that opt in (`"overlays": { "perView": true }`) load one live copy per view: the owner's
  desktop and browsers (D-1) and every guest allowed to see them. Today one view holds the page and a guest only ever
  sees "Open on <device>", so showing the Reviewer to guests gives them nothing (Oleg, 2026-11-20).
- The bundled Reviewer opts in, with replayable state, guest-safe payloads, and notes shared between the owner and
  write guests (D-3).
- Fixes found on the way: an overlay opened for a hidden plugin (a mail Gmail opens in the Reviewer) leaks its title to
  guests in 0.24.0 (D-4); an owner browser's Discuss and buttons act as the desktop.
- Source of truth: `docs/design-overlay-views.md` (decisions D-1..D-4 in §8; three codex sol/high review rounds closed).
  Every task reads it first; where this plan and the design differ, the design wins and the plan gets a ⚠️ note.

## Context (from discovery)
- Main: `src/main/overlays/overlay-manager.ts` (single holder: `hold`, `held`, `toPage`, outbox at `:331`, origin at
  `:629`, `visibleTo` at `:971`, Discuss `:1235`, buttons `:1128`), `src/main/plugins/host-api.ts` (overlay RPCs at
  `:70-79`, `:188-200`; `files.open` at `:2067`), `src/main/ipc/router.ts` (`overlays.*` handlers),
  `src/main/external/open-external.ts`, `src/main/plugins/plugin-pages.ts`.
- Guests: `src/shared/guest-class.ts` (`overlays.*` rows `:161`, `:196-200`, `:319-323`), `src/main/web/guest-events.ts`
  (`:161-164`), `src/shared/guest-filter.ts` (`guestOverlays` `:292-306`), `src/shared/guest-access.ts` (`guestPort`).
- Host: `src/host/ctx/ui.ts` (overlay handle `:509-532`, `:661`; panels' per-view lines `:165-260` are the pattern),
  `src/host/services.ts` (call frames `:206-235`, `caller` `:819`), `src/host/overlay-buttons.ts` (`run` `:192`),
  `src/host/ctx/origin-view.ts`.
- Shell: `src/renderer/overlays/OverlayStack.tsx`, `HtmlOverlay.tsx`, `src/renderer/plugins/HeldElsewhere.tsx`,
  `src/renderer/shell-kind.ts`, `src/renderer/settings/PluginsPage.tsx`.
- SDK and manifest: `src/sdk/types.ts`, `src/shared/manifest.ts`, `src/main/plugins/validate.ts`,
  `examples/plugin/sdk/types.ts` (copy).
- Reviewer: `plugins/reviewer/plugin.json`, `dist/host.js` (plain JS host), `dist/lib/review.js`, `src/page/review.js`
  (bundled by `npm run build:reviewer` into the committed `overlay/review.bundle.js`), tests in `plugins/reviewer/test`.
- Tests: `test/unit/overlay-manager.test.ts`, `ctx-ui.test.ts`, `host-api.test.ts`, `host-services.test.ts`,
  `host-overlay-buttons.test.ts`, `guest-class.test.ts`, `guest-events.test.ts`, `guest-filter.test.ts`,
  `guest-overlays.test.ts`, `open-external.test.ts`, `reviewer-plugin.test.ts`; e2e `test/e2e/guest-*.spec.ts` with
  `guest-fixtures.ts`.
- Docs: `docs/features.md` ("Web access" › "Guests", the Reviewer entry), `docs/design-guests.md` (§9, §16.3 row),
  `docs/design-web.md` §5.4, guide `src/cli/guide/api.md` (drift tests `cli-guide.test.ts`).

## Development Approach
- **testing approach**: Regular (code first, then tests in the same task), as in the previous plans.
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for its code changes, success and error cases
- **CRITICAL: all tests must pass before starting the next task** (`npm test`, `npm run typecheck`, `npm run lint`;
  `npm run test:plugins` for Reviewer tasks)
- **CRITICAL: update this plan file when scope changes during implementation**
- backward compatibility: a plugin without `perView` behaves exactly as today (one holder, Take over), apart from the
  D-4 visibility fix and `from` naming the real caller.
- One full e2e run at a time on a machine; never touch the real app data dir or `~/.claude`.

## Testing Strategy
- **unit tests**: required in every task (see above). The copy lifecycle in `OverlayManager` gets table-style cases for
  every transition (connect, first targeted post, broadcast, loaded, reload, release, view gone, overflow, cap).
- **guest boundary tests**: every widened guest row gets a refusal case for a non-`perView` overlay, a hidden `via`
  plugin, a forged copy id and another view's copy.
- **e2e**: Task 13 drives the owner desktop, an owner browser, a read guest and a write guest against the Reviewer
  (Playwright, `test/e2e/guest-fixtures.ts`).

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with the work

## Solution Overview
- An overlay of a `perView` plugin is a set of **copies**, one per view that may see it; each copy has a main-minted id,
  its own ready flag and outbox, and joins broadcasts with the plugin's first post addressed to it (its starting state).
  Everything a page sends carries its copy id and is accepted only from that copy's view while it is live.
- `from` (view, access, and a guest's `person`) is filled by main for every message, button, Discuss and type button,
  for every plugin, so plugins decide by who acted, never by where a listener runs.
- **Provenance (D-4)**: each overlay keeps `origin.via`, the plugins it was opened or filled for (the host's service
  caller chain at overlay calls, `addSources` for deferred fills, `requestedBy` on main-routed file opens). A guest gets
  the overlay only when the opener and all of `via` are visible to it; growth releases a guest's copies synchronously.
- Guests: `overlays.ready` / `.loaded` / `.message` widen to `read` for `perView` overlays only; read guests' ✕ and
  `{ result }` become a hide of their own copy; write guests' ✕ closes for all (D-2).
- The Reviewer becomes the reference `perView` plugin: per-copy `init` from replayable state, payloads projected for
  guests, a host-owned shared draft with host note ids and main-supplied authors.

## Technical Details
- Manifest: `"overlays": { "perView": boolean }` (top level, optional; an older app ignores it).
- SDK (`src/sdk/types.ts`): `ViewFrom.person?: string`; `OverlayHandle.onConnect(l(from & { copy }))`,
  `onDisconnect(l(from & { copy }))`, `onMessage(l(message, from & { copy }))`, `post(message, { copy? })`,
  `hide({ copy })`, `addSources(pluginIds: string[])`; `onButton(id, l(from))`, `onDiscuss(l(from))`; type-button
  `run(info, from)`; `ctx.services.callers(): string[]` (outermost first); `ctx.openExternal(url, { view? })`;
  `FileOpenEvent.requestedBy?: string`.
- Main per overlay (perView): `copies: Map<copyId, { view, live, joined, ready, loaded, outbox }>`, `via: Set<pluginId>`,
  `hiddenFor: Set<viewId>` (read guests' hides). Copy id: random 128-bit hex, never reused.
- Channels: `overlays.ready` answers `{ copy }`; `overlays.loaded`, `.message`, `.result` take `copy`; new invoke
  `overlays.release { overlayId, copy?, hide? }` (REMOTE `adapted`, GUEST `read` with the overlay target); new event
  `overlays.hide { overlayId, copy }` to the copy's view (from `handle.hide`). Each new channel gets its `REMOTE_CLASS`,
  `GUEST_CLASS` and `GUEST_EVENT` rows in the same change.
- Limits: per-copy outbox 100 messages / 8 MiB (string length, as today); overflow of a not-ready copy drops and reloads
  that copy only; connects per (overlay, view) capped per minute like `panel-ports.ts:258`.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo (the Reviewer included, it is bundled).
- **Post-Completion**: Oleg's hands-on check between his two Macs and on the Debian server; release; the example repo
  push.

## Implementation Steps

### Task 1: Manifest key, SDK types and the caller chain [model: sonnet]

**Files:**
- Modify: `src/shared/manifest.ts`, `src/main/plugins/validate.ts`, `src/sdk/types.ts`, `src/host/services.ts`
- Modify: `test/unit/host-services.test.ts`, the manifest validation tests (`test/unit/validate*.test.ts`)

- [x] add the optional top-level `overlays: { perView?: boolean }` to the manifest schema and its parsed type (unknown
  sub-keys refused, as for `guests`)
- [x] add the SDK types listed in Technical Details (types only; implementations come in later tasks), with doc comments
  that say who fills each field (main, never the page)
- [x] implement `ctx.services.callers()` in `src/host/services.ts`: the live call frames' consumers, outermost first,
  empty outside a frame or once the frame settled (same liveness rule as `caller`)
- [x] tests: manifest accepts/refuses the key; `callers()` for A → B → C (C sees [A, B]), after the call settles, from a
  timer after settle, and for a plugin's own code running in another's frame (excluded, as `caller` does)
- [x] run tests - must pass before task 2

### Task 2: OverlayManager copies for perView overlays [model: opus]

**Files:**
- Modify: `src/main/overlays/overlay-manager.ts`
- Modify: `test/unit/overlay-manager.test.ts`

- [x] keep the per-overlay `perView` flag (from the opener's manifest, passed by host-api at `start`) and, for `perView`
  overlays, the copies map instead of `holder`/`pageReady`/`outbox`; non-`perView` code paths unchanged
- [x] `connect(view)` mints a copy id (refused for server mode's hidden page and for a view not allowed by the caller's
  visibility callback); `release(view, copy)`; `viewGone(view)` releases that view's copies; each fires the host's
  connect/disconnect
- [x] binding: `loaded`, `message`, `result` accepted only when `copy` belongs to the calling view and is live; stale
  copies dropped silently
- [x] fan-out: `post(message, { copy? })`; a copy joins broadcasts with its first targeted post; per-copy outbox while not
  ready; overflow drops and reloads that copy only (disconnect + the shell told to reload it); connects capped per
  (overlay, view) per minute
- [x] `loaded` clears that copy's loader only; `info` carries `perView: true` and no `heldBy` for `perView` overlays
- [x] tests: every transition in the Testing Strategy list, the hidden page refused, a stale copy's traffic dropped,
  a broadcast before the first targeted post not delivered, overflow isolation, the connect cap; non-`perView` regression
  cases unchanged
- [x] run tests - must pass before task 3
- ⚠️ the connect cap reuses the panel ports' numbers (`MAX_CONNECTS_PER_PANEL` per `CONNECT_WINDOW_MS`: 10 per 10 s), not
  a per-minute window; `list()` (a renderer reload) does not release that view's copies: the shell's release or its next
  connect does (Task 8 must release on unmount/reload)

### Task 3: Channels, router and the caller's view for every overlay call [model: opus]

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc/router.ts`, `src/main/plugins/host-api.ts`, `src/main/overlays/overlay-manager.ts`
- Modify: `test/unit/host-api.test.ts`, the router tests that cover `overlays.*`, `test/unit/overlay-manager.test.ts`

- [x] `overlays.ready` answers `{ copy }` for `perView` overlays; `loaded`, `message`, `result` carry `copy`; add
  `overlays.release` (invoke) and `overlays.hide` (event) with their `REMOTE_CLASS` rows
- [x] the caller's view travels router → manager → host for messages, buttons, Discuss and type buttons, owner views
  included (today `:1235`, `:1276` lose it); host-api's RPC events carry `from` `{ view, access, person? }`, with
  `person` = the guest's invite name from main's `GuestStore`, absent for the owner
- [x] host-api RPCs for `post { copy? }`, `hide { copy }` (event to that copy's view), connect/disconnect events to the host
- [x] ➕ wire Task 2's manager API: `open(..., origin, { perView })` from the opener's manifest; `connectCopy` /
  `copyReady` (or one `overlays.ready` doing both, answering `{ copy }` or the `CopyRefusal`), `copyLoaded`, `copyMessage`,
  `copyResult`, `releaseCopy` (all `(windowId, overlayId, view, copy, ...)`), `post(..., { copy })`; the channel's
  `onConnect(copy, view)` / `onDisconnect(copy, view)` / `onMessage(message, view?, copy)` to the host; the options
  `mayConnectCopy` (owner views never asked; guests by Task 5) and `reloadCopy(view, windowId, overlayId, copy)`, which
  needs an event to that view (e.g. `overlays.reload`, with its REMOTE_CLASS / GUEST_EVENT rows) for Task 8's shell. The
  `overlays.message` event already carries `copy` for a perView overlay; the shell must route by it (Task 8)
- [x] tests: an owner browser's Discuss and button carry its view (not the desktop); a guest's carries its `person`;
  `post` to a gone copy is dropped; `hide` reaches only that copy's view
- [x] ➕ (Task 2 review) `copyResult` refuses an admitted guest copy and an owner copy's result ends every copy; posts
  inside `onConnect` queue and drain in order, inside `onDisconnect` are dropped; a throwing listener breaks nothing
- [x] run tests - must pass before task 4
- ⚠️ wire shapes Task 7 consumes (host-api.ts header): events `overlay.message { pluginId, handle, message, view?, copy?,
  from }`, `overlay.connect` / `overlay.disconnect { pluginId, handle, copy, view?, from }`; requests
  `overlay.buttonClick { ..., view?, from }` (opener and type) and `overlay.discuss { pluginId, handle, view?, from }`;
  RPCs from the host `overlay.post { ..., copy? }` and `overlay.hide { pluginId, handle, copy }`. `from` is
  `{ view?, access, person? }` in the panel port tag's convention: `view` only for a `web:n` view, absent = the
  desktop page (owner); never `desktop:<n>`. The top-level `view?` stays for `dispatchInView`. `from` is read live
  through HostApiDeps `viewAccess` (`guestStore.whoAccess`; `person` = `GuestAccess.name`, the invite name), and a
  revoked, unknown or other-project view is dropped (message, connect) or refused (click, Discuss), never the owner;
  a disconnect reuses its connect's `from` (the view may be gone from the registry). The host ignores
  `overlay.connect` / `.disconnect` until Task 7.
- ⚠️ the perView flag reaches HostApi as `HostApiPlugin.overlaysPerView` (index.ts `HostPlugin` → host-manager's launch
  and `updatePlugin`); the router branches on `OverlayManager.isPerView`, never on a payload's `copy`: a perView page
  call without `copy` throws, a `copy` on any other overlay is dropped (false / no-op). `overlays.ready` for perView is
  `OverlayManager.connectReady` (connect + ready) and answers `{ copy }` or `{ refused }`. `overlays.reload
  { overlayId, copy }` is the new event behind `reloadCopy` (REMOTE `yes`, GUEST_EVENT `drop`).
- ⚠️ Task 5: `overlays.release` is guest `no`, `overlays.hide` / `.reload` events are guest `drop`, and index.ts wires
  `mayConnectCopy: () => false`; all three widen there. `hideCopy` only releases and emits: nothing records the hide,
  so the next `overlays.updated` / reconnect would bring the overlay back to that view (Task 5 records it).
- ⚠️ Task 8: the host's starting-state post for a new copy can reach the shell (`overlays.message { copy }`) before the
  `overlays.ready` reply that names that copy: buffer messages by copy id until the reply arrives.

### Task 4: Provenance (`via`), requestedBy and the title-leak fix [model: opus]

**Files:**
- Modify: `src/host/ctx/ui.ts`, `src/main/plugins/host-api.ts`, `src/main/overlays/overlay-manager.ts`,
  `src/main/index.ts` (the `openFile` wiring), the files-open taker path
- Modify: `test/unit/overlay-manager.test.ts`, `test/unit/ctx-ui.test.ts`, `test/unit/host-api.test.ts`,
  `test/unit/guest-overlays.test.ts`

- [x] host: every overlay call (`start`, `post`, title, buttons) made inside a service frame sends the frame's
  `callers()` chain; `handle.addSources(ids)` sends ids (validated as known plugin ids of this host)
- [x] main: `via` only grows; `visibleTo` requires the opener and every `via` plugin visible (or a shared-tab origin, as
  today); applies to `perView` and non-`perView` overlays (closes the 0.24.0 title leak)
- [x] growth: when `via` gains a plugin hidden from a guest with copies, release that guest's copies and drop their
  queues in the same synchronous step, before the triggering post is delivered; the overlay leaves that guest's list
- [x] `files.open`: main passes `requestedBy` (the calling plugin main bound, never the payload; absent for core clicks
  and a tab's `ccc`) on the taker's open event
- [x] tests: A → B → Reviewer attributes A and B; deferred `addSources`; a hidden `via` plugin hides the overlay and its
  title from a guest; growth on a live overlay releases the guest's copy before delivery; `requestedBy` set and absent
  cases; the shared-tab origin rule unchanged
- [x] run tests - must pass before task 5
- ⚠️ wire shapes: `overlay.open` / `overlay.post` / `overlay.setButtons` take `via?: string[]` (the host's
  `ctx.services.callers()` at the call site, sent only when non-empty; there is no title-update RPC, a title is set at
  open only), and the new RPC `overlay.addSources { pluginId, handle, ids } -> boolean`. Main keeps only this host's
  plugin ids (`HostApi.overlaySources`), refuses a non-array or more than `MAX_OVERLAY_SOURCES` (32,
  `shared/overlay-buttons.ts`), and grows the set through `HostApiDeps.addOverlaySources` →
  `OverlayManager.addSources` before the post or buttons are delivered (refused when that dep is not wired). Sources
  named before the overlay exists collect in the handle's live set (`OverlayLink.via`), which the manager reads at
  creation (`OverlayStartOptions.via`), so the first `overlays.updated` already honours them. `via` lives on the
  overlay record, never in `OverlayInfo`.
- ⚠️ (Task 3 review) `overlays.release` is REMOTE_CLASS `yes`, not `adapted` as Technical Details says: its handler binds
  the copy to the caller's view like ready/loaded/message/result and does nothing different for a remote view. Task 5
  widens its GUEST_CLASS only.
- ⚠️ Task 5: growth re-asks `mayConnectCopy` for every non-owner copy and releases the ones it refuses (with
  `overlays.hide` to that view); so the wiring that replaces `mayConnectCopy: () => false` in index.ts must go through
  `OverlayManager.visibleTo` (the router's `overlayVisible`), or growth would not hide anything. The `overlays.hide`
  event a growth sends is guest `drop` until Task 5 widens it; the guest's list loses the overlay anyway through the
  re-sent `overlays.updated`.
- ⚠️ Task 7: the host already sends `via` on open/post/setButtons and implements `handle.addSources` (any kind, not
  html-only); keep both when the handle is reworked. Task 10: `ctx.files.onOpen` requests carry `requestedBy` only for
  a plugin's `ctx.files.open` (routeProjectFile); `ctx.sessions.openFile` (routeOpenFile, the person's click) never does.

### Task 5: Guest rows, filters and the read guest's hide [model: opus]

**Files:**
- Modify: `src/shared/guest-class.ts`, `src/main/web/guest-events.ts`, `src/shared/guest-filter.ts`,
  `src/main/ipc/router.ts`, `src/main/overlays/overlay-manager.ts`
- Modify: `test/unit/guest-class.test.ts`, `test/unit/guest-events.test.ts`, `test/unit/guest-filter.test.ts`,
  `test/unit/guest-overlays.test.ts`

- [x] `overlays.ready`, `.loaded`, `.message`, `.release` become guest `read` with the overlay target; the handlers
  refuse a non-`perView` overlay to a guest; `overlays.take` stays `no`; `overlays.result` and `.close` stay `write`
- [x] `overlays.message` / `overlays.hide` events pass to a guest only for its own copies; `guestOverlays` keeps
  `perView` and the per-view state, honours `via` and the guest's hides
- [x] guest ports: a read guest of a plugin that is not `guests.aware` gets a one-way copy (messages dropped, logged
  once), as panels (D-17)
- [x] read guest's hide: `overlays.release` from a read guest also records the hide for that view (the overlay leaves
  its stack and does not come back); a write guest's `overlays.close` closes for everyone (D-2)
- [x] ➕ (Task 5 review) `overlays.release { hide: true }` is the hide, plain release only lets go for every caller;
  the hide holds with no live copy (`guestHide`), and is refused for the owner and a write guest
- [x] tests: each widened row refuses a non-`perView` overlay, a forged copy id, another view's copy, a hidden `via`
  plugin; read vs write guest close and hide; one-way copy for a non-aware plugin
- [x] run tests - must pass before task 6
- [x] ➕ (Task 4 review) `via` sources are never cut to a bound (a dropped source fails open): the host filters to its
  own plugins (`ServiceRegistry.knows`) and dedupes before anything else, and with no filter throws past
  `MAX_OVERLAY_SOURCES` at the call site; main refuses (never trims) a list longer than that or than its host's plugin
  count, whichever is larger; stale `overlayVisible` comments now name the `via` rule
- ⚠️ the hide is keyed by the guest id, not the view (`PerViewState.hiddenFrom`, read through
  `OverlayManager.hiddenFrom`), unlike Technical Details' `hiddenFor: Set<viewId>`: a reconnect is a new view id and
  the overlay must not come back on it. A guest's hide releases that guest's copies on every view (`overlays.hide` to
  each) and lives as long as the overlay. A growth release (`addSources`) never records one. Owner views' hides are
  not recorded in main (D-1: every owner view gets every overlay); the shell keeps its own.
- ⚠️ one rule, three callers: `guest-wiring.ts` `overlayVisibleOf` (origin, every `via` plugin, not hidden by that
  guest) feeds the router's target check, the guest sink's filters (index.ts `guestSources`) and
  `overlayCopyPortOf` / `mayConnectCopyOf` (also live guest, the overlay's own window, perView, the opener's
  `guestPort` not `none`). One-way is read live per page message through the manager's new `copyPort` option
  (`copyMessage` drops a non-`full` guest copy's messages, logged once per copy); connect, `loaded`, release and the
  opener's posts still flow. The guest sink checks a copy's view through `OverlayManager.copyViewOf` (live copies
  plus the last 32 released, since `overlays.hide` goes out after its copy is released); `overlays.message` and
  `.reload` also need the overlay still visible, `.hide` does not.
- ⚠️ Task 8 (changed by the Task 5 review fix): release and hide are separate. Every shell, a read guest's included,
  sends a plain `overlays.release { overlayId, copy }` on unmount and reload (it only lets go); a read guest's ✕ or
  page `{ result }` sends `overlays.release { overlayId, hide: true }` (copy optional: main records the hide for the
  guest of the bound view with or without a live copy, `OverlayManager.guestHide`). `hide` from the owner or a write
  guest is refused (they close with `overlays.close`), so the shell must never send it there.
- ⚠️ Task 8: a perView overlay a shared tab opened whose opener plugin is hidden from guests is in the guest's list
  (the tab rule) but its `overlays.ready` answers `{ refused: 'not-allowed' }` (port `none`): the shell needs a state
  for that (the reworded note, not a spinner).
- ⚠️ Task 12: the `handle.hide` doc says a guest's hide covers every view of that guest, for the overlay's life.
- ⚠️ (known, not built) the owner hiding the plugin while a guest holds a copy leaks nothing (the gate and the sink
  re-read visibility live, and `copyPort` drops its messages), but the copy record stays until that view reconnects
  or the overlay ends.
- ⚠️ Task 7 / 10: a one-way copy still fires `onConnect` / `onDisconnect`; the Reviewer must not count on its
  messages (it declares `guests.aware`, so its read guests get full copies and the host drops their edits by
  `from.access`). `handle.hide({ copy })` of a guest's copy records the hide for that guest (Task 10's read guest
  Close).

### Task 6: View-addressed `ctx.openExternal` [model: opus]

**Files:**
- Modify: `src/main/external/open-external.ts`, `src/main/plugins/host-api.ts`, `src/host/ctx/` (openExternal)
- Modify: `test/unit/open-external.test.ts`, `test/unit/host-api.test.ts`

- [x] `ctx.openExternal(url, { view })`: main routes to that view only (a browser view gets it as its own link open;
  the system opener only when `view` is the desktop); a gone view or a guest's view never falls back to the system
  opener: refused with a clear error
- [x] without `view`, today's behaviour (the origin-view hint) unchanged
- [x] tests: desktop view opens with the system opener; owner browser view and guest view get the view-only open; a
  gone view and an expired hint with `view` set are refused, never the system opener
- [x] run tests - must pass before task 7
- ⚠️ the desktop page has no id a plugin gets (shared/views.ts: only `web:n` travels through a host), so a plugin
  names the desktop by omitting `view`: `{ view: from.view }` with `from.view` absent (or `undefined`) is today's
  request, the origin hint deciding (the desktop's system browser when no browser view is behind the call). `null`,
  `''` and any non-`web:n` value reject (host TypeError, main again). The adapter's `addressed` target can name
  `desktop:<own window>` (the system opener on the desktop, refused in server mode: the hidden page has no screen),
  but HostApi never builds one from a plugin.
- ⚠️ `{ view }` is an address, not the hint: HostApi `linkView` checks `web:n`, this window (`viewWindow`), then
  `viewAccess` live (owner; a guest of this project only while `guestPluginVisible`, the new dep wired to
  `GuestStore.pluginVisible`; revoked, another project's guest or an unwired lookup: refused) before the budget; the
  adapter (`OpenTarget.addressed`) sends `{ url, to }` to that view alone or throws `VIEW_GONE_TEXT`, in both modes
  (an unaddressed gone view on the desktop still resolves silently, as before). The URL check runs first on every route.
- ⚠️ Task 10 / 12: the Reviewer's mail links and `open-url` / `open-link` pass `{ view: from.view }`; the guide
  (`api.md` ctx.openExternal) gets the text of the `openExternal` JSDoc in `src/sdk/types.ts` (already copied to
  `examples/plugin/sdk/types.ts`).

### Task 7: Host overlay handle for perView plugins [model: opus]

**Files:**
- Modify: `src/host/ctx/ui.ts`, `src/host/overlay-buttons.ts`
- Modify: `test/unit/ctx-ui.test.ts`, `test/unit/host-overlay-buttons.test.ts`

- [x] `OverlayHandle`: `onConnect`, `onDisconnect`, `onMessage(m, from & { copy })`, `post(m, { copy? })`,
  `hide({ copy })`, `addSources`; listeners for a copy's messages run dispatched in that copy's view (as today for
  remote views) but plugins get `from`
- [x] the copy's view joins and leaves `ctx.views` membership as panel lines do (`ui.ts:222`)
- [x] `onButton`, `onDiscuss` and type buttons' `run(info, from)` receive `from` for every plugin
- [x] non-`perView` handles: same API surface, messages only from the holder, as today
- [x] tests: connect/disconnect order on reload, `post` to one copy, `ctx.views` membership, `from` on buttons and
  Discuss, non-`perView` unchanged
- [x] run tests - must pass before task 8
- ➕ the host needs the manifest flag for the call-site throws: `HostPluginSpec.overlaysPerView` (`host/loader.ts`
  parses it, `host-manager.ts` `buildSpec` sends it, `UiApiDeps.overlaysPerView`); a perView handle is html AND the
  flag, as in the manager. `post({ copy })` (a defined copy) and `hide` throw on any other overlay; `post(m, { copy:
  undefined })` is a broadcast everywhere, so `post(reply, { copy: from.copy })` works for both kinds. `onConnect` /
  `onDisconnect` are accepted on any html overlay (never fire without perView) and throw on other kinds like `onMessage`.
- ⚠️ `from` is parsed fail-closed in one place (`ctx/views.ts` `viewFromOf`, used by `ui.ts` and `overlay-buttons.ts`):
  the same view as the envelope, an access `tagAccess` accepts, `person` only a guest's (1-60 chars). A message,
  connect or disconnect with a missing or malformed `from` is dropped (logged), a click or Discuss refused. The plugin
  sees `from.view === 'desktop'` for the desktop page (main sends `view` absent), as panels do; `ctx.openExternal(url,
  { view: 'desktop' })` routes to the host's own window's desktop page (the Task 6 review fix commit).
- ⚠️ a perView message is delivered only for a copy the host was told of by `overlay.connect`, from that copy's view;
  any other overlay's message naming a copy is dropped. The disconnect's listeners get the connect's `from`.
  `ctx.views` keeps access only (the SDK's `views` has no person; `person` is on `from`). The view joins before the
  `onConnect` listeners run and leaves after the `onDisconnect` ones; the overlay ending (`result` settles, the
  plugin disposed) releases every remaining copy's line with no `onDisconnect`.
- ⚠️ Task 10: register `onConnect` right after `ctx.overlay.start` (a connect is not replayed to a later listener);
  listeners are called one at a time in the order added, each with its own `from` object.

### Task 8: Shell: one copy per view, hide, and the reworded note [model: opus]

**Files:**
- Modify: `src/renderer/overlays/OverlayStack.tsx`, `src/renderer/overlays/HtmlOverlay.tsx`,
  `src/renderer/plugins/HeldElsewhere.tsx`, `src/renderer/shell-kind.ts` (render eligibility)
- Modify: the renderer overlay tests (`test/unit/follow-overlays.test.ts`, `overlay-toolbar.test.ts`, or a new
  `test/unit/overlay-copies.test.ts` for the pure parts)

- [ ] a `perView` overlay loads its own copy in every eligible view: connect returns the copy id, every page call
  carries it, a reload or reconnect is a new copy; the hidden page never renders one
- [ ] per-copy loader cleared by that copy's `loaded`
- [ ] read guest: ✕ and a page `{ result }` become `overlays.release { hide: true }` before any channel (unmount and
  reload send a plain release, for every caller); `overlays.hide` from
  main removes the copy; a write guest's ✕ is `overlays.close`
- [ ] non-`perView` guest note: "Open on <owner>'s screen. <Plugin> does not show its windows to guests." (owner views
  keep HeldElsewhere with Take over)
- [ ] tests for the pure model parts (copy state per view, hide, note text); existing overlay tests pass
- [ ] ➕ (Task 2 review) a ready copy whose emit to its view fails is dropped with no `reloadCopy` (`overlay-manager.ts`
  ~1441): the shell must notice a copy it no longer gets (an `overlays.hide`, a reload, or a reconnect on the view's
  next `overlays.list`) and connect again, so a transient emit failure never leaves a stuck page
- [ ] run tests - must pass before task 9

### Task 9: Plugins page says whether a plugin's windows reach guests [model: sonnet]

**Files:**
- Modify: `src/renderer/settings/PluginsPage.tsx` (and its model file if the text is computed there)
- Modify: the Plugins page tests

- [ ] where a plugin is shown to guests, one line: its windows (overlays) are shown to guests too (`perView`) or stay
  on the owner's screen; for a plugin others open things in (the Reviewer), the D-4 sentence: things another plugin
  opens in it reach guests only when that plugin is shown too
- [ ] tests for the text per case
- [ ] run tests - must pass before task 10

### Task 10: Reviewer: perView, replayable state, guest projection, access table [model: opus]

**Files:**
- Modify: `plugins/reviewer/plugin.json`, `plugins/reviewer/dist/host.js`
- Modify: `plugins/reviewer/test/host.test.js`, `test/unit/reviewer-plugin.test.ts`

- [ ] declare `"overlays": { "perView": true }` and `"guests": { "aware": true }`
- [ ] keep each overlay's current state (content and assets, hidden parts, status, layout, draft) and send it from
  `onConnect` to that copy, prepared (loading or failed) overlays included; the `content` handshake per copy
- [ ] project payloads for guest copies: no host path (`sides.root`, absolute paths), names relative to the project
- [ ] enforce the design's §6 table by `from.access`: `layout`/`split` saved for the owner only; `retry` and `action`
  owner only (their buttons not drawn in guest copies); `view` re-emitted for the owner only; `open-url`/`open-link` via
  `ctx.openExternal(url, { view: from.view })`; `close` → `handle.close()` for owner and write guests,
  `handle.hide({ copy })` for read guests
- [ ] `addSources(callers())` in `prepare` and `annotate` (kept with the stored content); `addSources([requestedBy])`
  on `files.onOpen`
- [ ] tests: every table row per access; replay to a late copy; guest projection has no host path; attribution calls
- [ ] run `npm run test:plugins` and `npm test` - must pass before task 11

### Task 11: Reviewer shared notes and Discuss cleanup [model: opus]

**Files:**
- Modify: `plugins/reviewer/dist/host.js`, `plugins/reviewer/dist/lib/review.js`, `plugins/reviewer/src/page/review.js`,
  `plugins/reviewer/overlay/review.bundle.js` (via `npm run build:reviewer`)
- Modify: `plugins/reviewer/test/review.test.js`, `plugins/reviewer/test/host.test.js`

- [ ] the draft is the host's: pages send note ops (add with a page-local tag, change, delete by host id, `global`);
  the host assigns ids, answers the adding copy with tag → id, applies, saves, broadcasts the change; read guests'
  ops dropped
- [ ] each note keeps `author` from `from.person` (absent = owner); `lib/review.js` cleaning keeps it; the page shows it
- [ ] Discuss sends the shared draft; on delivery removes only notes unchanged since the snapshot, and `global` only if
  unchanged
- [ ] rebuild the bundle (`npm run build:reviewer`; the byte-compare test passes)
- [ ] tests: concurrent adds from two copies get distinct ids; author kept through save/load; forged author ignored;
  Discuss keeps notes added or edited meanwhile; read guest op dropped
- [ ] run `npm run test:plugins` and `npm test` - must pass before task 12

### Task 12: Docs and the guide [model: sonnet]

**Files:**
- Modify: `docs/features.md`, `docs/design-guests.md`, `docs/design-web.md`, `src/cli/guide/api.md`,
  `docs/design-overlay-views.md` (status), `CLAUDE.md`, `examples/plugin/sdk/types.ts`
- Modify: the guide drift tests if they list members (`test/unit/cli-guide.test.ts`)

- [ ] features.md: overlays in every view (owner screens and guests), the Reviewer's shared notes and authors, what a
  read and a write guest can do in an overlay, D-4's rule and its scope limit (Guests and the Reviewer entries)
- [ ] design-guests.md §9 and the §16.3 `overlays.*` row: a pointer to design-overlay-views.md; design-web.md §5.4: Take
  over only for non-`perView` plugins
- [ ] guide `api.md`: `perView`, `onConnect`/`onDisconnect`, `from` and `copy`, `post { copy }`, `hide`, `addSources`
  and the provider rule, `ctx.services.callers()`, `ctx.openExternal(url, { view })`, `requestedBy`
- [ ] CLAUDE.md: one implementation-pattern bullet for overlay copies and `via`
- [ ] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`; `npm run build:example`
- [ ] run tests (drift tests included) - must pass before task 13

### Task 13: e2e: owner screens and guests on the Reviewer [model: sonnet]

**Files:**
- Create: `test/e2e/guest-overlay-views.spec.ts`
- Modify: `test/e2e/guest-fixtures.ts` (helpers only if needed)

- [ ] owner desktop and an owner browser both show a Reviewer overlay live (no Take over)
- [ ] a read guest sees it, cannot add a note (its op dropped), its ✕ hides only its copy
- [ ] a write guest adds a note the owner sees with the guest's name; the write guest's ✕ closes it for all
- [ ] an overlay opened through the Reviewer by a hidden plugin (a fixture plugin using the `reviewer` service) never
  reaches the guest, title included
- [ ] a guest's link click in the overlay opens on the guest's side only (the owner's `shell.openExternal` recorder
  stays empty)
- [ ] run the new spec and the existing `guest-*.spec.ts` - must pass before task 14

### Task 14: Verify acceptance criteria [model: sonnet]
- [ ] every requirement in the Overview and every D-1..D-4 rule is implemented (walk the design's sections)
- [ ] non-`perView` plugins behave as before (Take over among owner views) apart from the D-4 fix and `from`
- [ ] run the full suite: `npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint`
- [ ] run e2e: `npm run test:e2e` (one run at a time on this Mac, screen unlocked)

### Task 15: [Final] Update documentation
- [ ] README.md if the guest or overlay summary there needs a line
- [ ] CLAUDE.md "State" paragraph: overlays in every view implemented, with the design and this plan
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**
- Oleg: share a project from his Mac to his work Mac (browser and the app's Connect to server › Link), Reviewer shown;
  read and write guest; a mail from Gmail (hidden) opened in the Reviewer stays invisible to the guest.
- The same on the Debian server (10.0.20.116) from a browser after the next release.

**External system updates**
- Push `examples/plugin/sdk/types.ts` to `BronOS/cc-cockpit-plugin-example` with the release.
- Third-party plugins keep working unchanged; the guide tells authors how to opt in.
