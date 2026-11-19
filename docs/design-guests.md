# Design: guests (invite a guest)

A guest is a person the owner invites into one project of their cockpit, read-only or with write access, from a
plain browser or from the guest's own cc-cockpit app. This file is the design and its binding interfaces (§16); the
settled decisions are §17 (**[D-n]** points at decision n), the review answers the code cites as "spec-review n" are
§18, and where the code differs from the text above it, §19 says so. User docs: [features.md](features.md), "Web
access" › "Guests". The web access design it builds on: [design-web.md](design-web.md).

## 1. Summary

A guest is a **web device of a new sign-in kind**, minted only by redeeming a one-use invite. Its name, role
(`read` | `write`), project and tab scope live in a **guest record** in main; identity is frozen on the view at `hello`,
the role and scope are read **live on every call, event, port frame and HTTP route**. Two typed tables are the choke
points: `GUEST_CLASS` (what a guest may call) and `GUEST_EVENT` (what a guest may receive), both default-deny, both
`Record<Channel, ...>` so a new channel without a guest entry fails to compile. One owner predicate, `isOwner(view)`,
replaces every place that reads `view.remote` (or `server && view.remote`) as "the person". Plugins are hidden from
guests unless the owner allows them; an allowed plugin learns the viewer's access from main's port tag, and a read-only
guest of a plugin that does not declare guest support gets a one-way (display-only) port. A guest's own cc-cockpit app
joins through Remote servers' **Direct** window (a sandboxed browser page): no new client, no new handshake.

The owner's devices take the existing path unchanged: `who === 'owner'` short-circuits every guest filter.

## 2. The principal

- `src/shared/views.ts`: `Who = 'owner' | { guest: string }` (the slot exists; router `WebCaller` carries it).
- `src/main/web/guests.ts` (new): `GuestStore` over `web-access.json` (beside devices): invites
  `{ id, hash, guestId, name, role, projectId, scope, createdAt, expiresAt }` and guests
  `{ id, name, role, projectId, scope: 'all' | TabRecord.id[], until }`. Nothing in them is a secret (the invite is
  stored as a SHA-256 hash), so guests survive a desktop/server switch of the secret store.
- A guest device is a `DeviceRecord` with sign-in mode **`'guest'`** and `guestId`. A new mode value, not an optional
  field, so an older build's `recordOf` drops it and fails closed (a guest never becomes an owner on downgrade).
- `access(who)` → `owner | { role, projectId, scope, name } | revoked`: the one lookup every check uses.
- `isOwner(view)`: the only owner rule. Every authority use of `view.remote` moves to it (transport uses such as acks
  stay); the server-mode `adapted` checks become `server && isOwner(view)`. Verified sites (router.ts 480
  `projects.close`, 797 `settings.projectOpen`, 859 / 866 plugin limits, 1067 `notices.click/dismiss`, 1093
  `oauth.paste`, 1161, and gates at 656, 2033, 2055, 2090; link-asks.ts:72; `SharedAsks` routing) would let a guest
  close or open projects, set plugin caps, revoke devices, Allow `ccc plugin link` and paste OAuth codes in server
  mode. A grep test lists the allowed `view.remote` sites.

## 3. Invites and sign-in

- **Mint**: owner only. Desktop: a core dialog on the desktop page (a `no`-class channel). Server mode: `ccc web invite`
  (shell, `HOST_ONLY_COMMANDS`) and the owner's browser behind an armed confirm **[D-11]**.
- **Token**: `randomSecret()`, 256 bits, in the URL fragment `<external origin>/#i=<token>` (never in a log, history
  `Referer` or tunnel log; the page clears it with `replaceState`). Shown once with Copy; a lost link means a new invite.
- **Bound to** name (typed by the owner, `plainText`, 60 chars, unique among live guests; the browser's own claim is
  ignored), role, project and scope. Expires if unused after 24 h (at most 7 days); revocable while pending.
- **Redeem**: `POST /auth/invite`, after the Host and Origin checks and its own attempt bucket **[D-19]**; checked and
  consumed in the same synchronous step (two redeems: one device, the second gets "already used", the owner a notice
  "Bob joined"). An owner-signed browser opening an invite is refused ("open it in a private window"), or it would
  replace the owner's cookie.
- **Owner sign-in modes**: invites work under Link, Password and Desktop confirm, independent of the owner's mode;
  regenerating the link or changing the password revokes only owner devices signed in with it. **Not under None**
  **[D-1]**: `authorize()` falls back to the anonymous owner when no cookie matches, so a guest who drops their cookie
  becomes the owner. Inviting under None is refused (409); switching to None while guests or invites exist is
  refused, naming them **[D-15]**.
- **Reconnect** is by the guest device cookie only (the invite is spent). One device per invite **[D-20]**.

## 4. What a guest may call: `GUEST_CLASS`

- `GUEST_CLASS: Record<InvokeChannel, 'no' | 'read' | 'write'>`, runtime lookup by `Object.hasOwn` (unknown = `no`),
  checked in `IpcRouter.authenticate` after `remoteAllowed`: it can only narrow `REMOTE_CLASS` (unit test: no `no`
  remote channel is `read`/`write`).
- Every channel whose request names a target carries a **target extractor** (`tabId`, `panelKey`, `frameId`,
  `pluginId`, `overlayId`) checked against scope and plugin visibility before the handler; the type makes the extractor
  mandatory when the request has such a field.
- `no` (default): settings, plugins (install, marketplace, settings saves, link, limits), updates, projects, remote,
  OAuth, `links.answer`, web access and devices, `layout.set`, `groups.*` writes, `tabs.flag/rename/reorder/roomMark`,
  rooms writes and room UI, `overlays.take`, Discuss for read guests, `webviews.input` for read guests.
- `read`: `tabs.select` (per view, never the project's `activeTab`), `tabs.visibility`, filtered lists, `layout.get`,
  theme, the connects of visible plugins and shared tabs.
- `write`: `tabs.input/fit/resize/create/close/restart` (with the rules in §6 and §7), `commands.run` of visible
  plugins, `trash.answer`, `downloads.accept` **[D-23]**, Discuss into a shared tab. On a desktop host a guest's Allow on a trash ask is
  ignored (Deny only, as for the owner's own browser) **[D-10]**.
- Riskiest, each with a named test: `links.answer`, `oauth.paste`, `plugins.limits.set`, `projects.close`,
  `settings.pluginInstall` / `marketplaceInstall` / `pluginSettingsSave`, `port.msg`, `tabs.input` (mouse reports),
  `rooms.doc`, `webDeviceRevoke`.
- Handlers that await before a change (save, rename, trash, open tab) re-check the role right before the change.

## 5. What a guest may receive: `GUEST_EVENT` and the other routes

`GUEST_EVENT: Record<EventChannel, 'drop' | 'pass' | filter(payload, access)>`, default `drop`, applied at **one sink**,
the guest connection's `WebConnection.event` **[D-18]**. The other outbound routes get the same filters:

| Route | Guest filter | Enforced in |
|---|---|---|
| Events | per channel: tab lists, panel infos, badges, headers, layout, overlays, groups, slots, commands filtered by scope and plugin visibility | `GUEST_EVENT` |
| `ready` snapshot | same filters; link, trash, download and room asks dropped (read guests: all asks) | `guestSnapshot` in `connection.ts` hello |
| `hello` | binds only the guest's project; another project closes 4403 | `WebConnection.hello` |
| `ready.paths` / `paths` | only visible plugins' prefixes (else the installed set leaks) | `pagePaths(deviceId)` |
| Terminal snapshots and chunks | only shared tabs; a group's join order skips hidden members (`selectGroup`) | `ViewTerminals.canFollow` |
| Panel, slot, page-tab ports | no port unless the plugin is visible (and the page tab shared); settings pages never | the `*.connect` invokes + `PortRelay` |
| Port page→host | read guest + plugin not guest-aware: dropped, logged once | `PortRelay.fromPage` |
| `/p/<token>/`, `/o/<token>/` | visible plugins only, 404 otherwise | `PluginPages` |
| Streamed webview frames | guests are viewers only of visible plugins' webviews | `WebviewViewers` |
| `/d/<token>` | minted only for a write guest's own view | `Downloads` |
| Notices, link notices, OAuth events, chime | core notices dropped; plugin notices only from visible plugins; link notices only to the asking view | `GUEST_EVENT` |
| Overlay buttons, palette commands | visible plugins only | main's button list, `commands.list` |
| Gateway JSON | `/api/projects`: own project only; `/api/sessions`, `POST /api/projects`, `/api/folders`: 404 **[D-26]** | `gateway.ts` route table |
| Rooms | no core room UI or marks for guests | `GUEST_EVENT` drop, `GUEST_CLASS` no |
| Presence | a guest sees positions only on tabs it can see; anyone elsewhere is "elsewhere" | presence filter |

Tests: a unit test runs every event through `GUEST_EVENT` with `who: 'owner'` and asserts identity; the acceptance e2e
plants a marker in a hidden plugin, another project and an unshared tab and asserts no guest frame or HTTP answer
holds it.

## 6. Plugins

- **Visibility setting** (core, not a plugin schema field): `app.json › pluginGuestAccess[id]` = `hidden` | `shown`,
  project override in the project record, absent = use global, default `hidden`, bundled plugins included. One
  resolver in `src/shared/guest-access.ts` for main and the Plugins page (as `serviceStatus` is).
- **What a plugin learns**: `onMessage`'s `from` gains `access: 'owner' | 'read' | 'write'` from main's port tag (never
  the page's `ccPanel.view`); the same on page-tab and slot instances; `ctx.views.access(view)` and
  `ctx.views.onChange`, so a plugin can post owner-only data per view instead of broadcasting. Page side
  `ccPanel.view.access` is a UI hint only.
- **Manifest** `"guests": { "aware": true }`: "I check `access`". A plugin that is not aware: read guests get a one-way
  port (pushes only, their messages dropped, logged once); write guests get full messages (trusted) **[D-17]**.
  Main cannot enforce "nothing that changes state" inside a plugin; it enforces one-way ports.
- **Allowing a plugin** shows what it exposes ("Team shows every room doc of this project to guests"). 
- **Bundled adoption** (public API only): Files (read guests: no rename, trash, upload, download; confined to the
  project realpath, no symlink escape), Editor (read guests: no save, no quick chat or Ask Claude; guests confined to
  the project for LSP and outside-path rules), Sessions and Usage (this project only, per-view posts, or they stay
  hidden). Guide topic and drift test for the API change.
- **Team** (`bronos.team`, its own repo): its panel loads by request (`hello`), so a one-way port shows it
  blank. It becomes guest-aware **[D-8]**: declares `guests.aware`, answers read guests with state and room
  docs, refuses every Team action (start, hire, fire, invite, end, ...) from any guest.

## 7. Tabs

- **Claude status** of shared tabs reaches guests from core's own tab strip (`TabBar` status dots from the renderer's
  session registry), filtered by scope like `tabs.list`; it does not need the Sessions plugin.
- **Scope**: `all` is dynamic (every terminal and page tab of the project, now and later, except tabs `openedBy` a
  hidden plugin and page tabs of hidden plugins). `selected` is a fixed set of `TabRecord.id`s, remapped on restore;
  a tab opened later is not shared until the owner shares it (tab menu: "Share with <guest>"). Unshared tabs are
  absent from `tabs.list`, `sessions.*`, `groups.changed`, `tabs.typed`, close, download and trash asks.
- **Split groups**: a guest gets a projection with hidden members removed and shares renormalised; the group's name is
  hidden if any member is **[D-16]**. Intents naming a hidden id are refused; `exitFocus` never hands a guest a hidden id.
- **A write guest's new tab** is the owner's process: it joins that guest's scope, is tagged `openedByGuest` (tooltip),
  stays when the guest leaves, capped at 4 per guest; seen by that guest and every all-tabs guest, not other
  selected-tabs guests **[D-21]**.
- **Closing tabs**: a write guest closes only tabs it opened; closing an owner's tab asks the owner **[D-9]**.
- **Page tabs and the editor**: page tabs are project-wide shared state; a guest opening a file would add a tab to the
  owner's strip. Read guests see only page tabs in their scope and cannot open new ones **[D-2]**. Write guests open and edit files as the owner would.
- **`activeTab`**: a guest's selection is kept per view (presence needs it) but never sets the project's `activeTab`
  (`view-selections.ts` `setActive`, the `viewGone` handback) nor `lastActing` (server mode's overlay holder), or
  Discuss and plugins would retarget to the guest's click.
- **`typed`**: a write guest's input sets `typed` and the room draft bit (both protect a human typing from a plugin
  paste) **[D-3]**. Tab flags, room marks, Pause, Resume and Remove stay the owner's; a guest sees a flag's colour,
  never its note.

## 8. Terminals

- **Read guests**: nothing reaches the pty (keys, mouse and focus reports refused in `TabManager.viewInput`), never
  take the size (`ViewSizes` `measured` dep drops their reports, `tabs.fit` refused), never answer or size a terminal
  overlay.
- **No turn-taking in v1** **[D-7]**: input from several people interleaves as today; presence shows who is typing and
  who typed last. The double-answer hazard at a permission prompt is accepted and named in the docs.
- **Write guests and size** **[D-14]**: only explicit acts take the size (typing, the debounced take; "Fit to this
  screen"); implicit takes (page load, select, pointer press, refocus) are refused for guest views in main. The fallback (`view-sizes.ts`) prefers owner views; guest views
  are dropped from `groups.area` (D5), so a small guest screen never vetoes the owner's split.
- **Scrollback**: sharing a tab shares its existing scrollback (the mirror's snapshot); the invite dialog warns **[D-13]**.
- **Backpressure**: per-view bounds exist (`VIEW_HIGH_WATER`, 32 MiB close). Add: one resync per tab per 2 s per guest
  view, 2 views per guest device; measure with `scripts/web-terminal-bench.mjs` plus throttled guest views.

## 9. Approvals, downloads, overlays, Discuss

- The "link" approval in code (`links.ask`) is the `ccc plugin link` confirm: installing code as the owner. **Never a
  guest's** **[D-4]**. A link a guest clicks opens in the guest's own browser.
- OAuth paste, close project, device and web access asks: owner only, never shown to guests.
- Trash asks: shown to write guests only when started from a shared tab or a visible plugin; on a desktop host a
  guest may only Deny, in server mode a write guest may Allow **[D-10]**; the role is re-checked at answer time;
  guests are left out of the "every live view declined" count.
- Downloads go to the guest's own device: write guests may use Files' Download and accept `ccc download` offers started
  from a shared tab, on any host; read guests never **[D-23]**.
- Terminal and HTML overlays: shown to a guest only when a `ccc` call from a shared tab or a visible plugin opened them
  (the open carries its origin, `CliCall.tabId` or the plugin; §18 item 16).
- Discuss: write guests only, from a visible plugin's overlay, into a shared tab, through the send gate.
- Quick chat and Ask Claude (the owner's account and quota): never for read guests; allowed for write guests
  **[D-22]**.

## 10. Presence and the UIs

- **Presence** (main, never saved, never given to plugins in v1): per person (owner = all owner devices; a guest),
  name, role, colour, the tab they look at, "typing" (keys in the last 2 s), live / away / reconnecting. Whole
  `presence.changed` snapshots, at most 4 a second; 5 s reconnect grace; guest sockets pinged every 10 s. The owner's
  name is a Web access setting, default "Host" **[D-24]**. `tabs.typed` names a person to guests, never a device.
- **Owner UI** (core): top-bar "Live" chip → guest list (name, role, tab, typing; Read-only / Write; Kick) and
  Invite…; the invite dialog (name, role, all or selected tabs, expiry, plugins shown with a link to Settings, the
  write warning). Avatars on tabs.
- **Write warning** (shipped verbatim, `renderer/guests/invite-model.ts`): "**<name> can run anything as you.** Typing in a shared tab runs
  commands here as you: they can read your files, mail and plugin data from a shell and give themselves lasting access
  (a new device, an SSH key). Kicking ends their session, not what they ran. Invite only someone you would hand your
  unlocked laptop." Plus: "Scrollback from before now is visible in shared tabs."
- **Guest UI**: a banner "Guest · read-only — <owner>'s cc-cockpit" with the Live list; no +, settings, layout
  actions or Fit for read guests; hidden panels absent, not greyed. "Nothing shared right now" when the scope is empty.
- **Kick** closes with a new final close code: "<owner> removed you", terminals cleared (today a revoke reads as signed
  out). **Role switch** closes the guest's views with `roleChanged`; the page reconnects to a fresh `ready` under the
  new role (one path up and down; costs a blink; a downgrade warns the owner about the guest's unsaved edits).

## 11. The guest's own cc-cockpit app

Remote servers' **Direct** window is a sandboxed Chromium page running the host's web client: it sends `Origin` and
keeps the cookie and key as for a server, so design-web.md's planned bearer handshake for a desktop client is dropped. Changes: the Direct parser accepts
`#i=` (today only `#t=`); the record carries `guest: true` ("Guest at <origin>") with no reopen, machine poll or
re-pair; scoped answers from `/api/projects`; no picker landing (a "host ended the session" page instead); a `kicked`
close shows "removed by the host". Direct against a desktop (non-server-mode) host was proved by a spike first (loopback, LAN http,
self-signed TLS).

## 12. Server mode

- New `ccc web` commands (all `HOST_ONLY_COMMANDS`): `invite --project <id|path> --name <n> --role read|write
  [--tabs all|<ids>] [--expires 24h]` (prints the link, never logged), `guests [--json]`, `kick <guest>|--invite <id>`,
  `role <guest> read|write`. On a desktop host `ccc web` answers `guests`, `kick` and `role … read` only **[D-25]**.
- In server mode every owner view is a browser: an owner view may invite and upgrade to write behind an armed confirm
  **[D-11]**; guests never.

## 13. Reach and docs

- A desktop binds loopback by default; a LAN guest needs a network bind plus TLS, or the plain-http confirm (which
  sends the guest's cookie and keystrokes in clear) **[D-5]**. Invites need Link, Password or Desktop confirm
  **[D-1]**. No invite can be made without a non-loopback way in
  (the dialog says how).
- Tunnels: docs recipe for Tailscale Funnel, cloudflared and ngrok; `checkOrigin` already accepts the request's own
  origin; docs say TLS ends at cloudflared and ngrok (they see the cookie and terminal text), at the host for Funnel.

## 14. Kick, switch and lifetimes

- **Kick** (owner only): revokes the guest's devices, deletes its invites and record, closes sockets and port relays,
  kills `/p/` `/o/` tokens, cuts `/d/` streams, drops webview viewers, size ownership, overlay holds and queued texts.
  Acceptance: any guest frame after a kick fails within 1 s. Output already shown cannot be recalled (docs say so).
- **Downgrade in flight**: pty bytes stay, the next input is refused, queued Discuss texts drop, awaiting handlers
  re-check.
- **Lifetimes**: picked at invite, 1 day / 7 days / until removed, default 1 day; the grant's end acts like a kick;
  guests survive a host restart **[D-12]**. Also: Revoke all includes guests; web access off closes guest sockets;
  a project closed on the host ends its guests' views ("the host closed this project") and a forgotten project kicks
  them; a re-invite after a kick makes a new guest id.
- Not built in v1: a notice, when a write guest leaves, listing the devices added and plugins linked meanwhile.

## 15. Where it lives

- Shared rules and shapes: `src/shared/guests.ts` (records, `GuestAccess`, limits), `views.ts` (`Who`),
  `guest-class.ts` (`GUEST_CLASS`, `GUEST_SAFE_COMMANDS`), `guest-filter.ts` (the pure T, S, P, G and project
  filters, `tabVisible`, `askInfo`), `guest-access.ts` (plugin visibility, `guestPort`), `guest-exposure.ts` (the
  Plugins page text), `web-protocol.ts` (redeem, close codes, `guestCloseText`).
- Main: `main/web/guests.ts` (`GuestStore`: invites, redeem, kick, role, scope, lifetimes, tombstones),
  `guest-events.ts` (`GUEST_EVENT`, `guestSnapshot`), `presence.ts`, `connection.ts` (`hello`, the sink, follow),
  `gateway.ts` (`/auth/invite`, guest routes, the guest heartbeat), `devices.ts` (sign-in mode `guest`);
  `main/ipc/router.ts` (`isOwner`, `checkGuest`), `main/ipc/guest-deps.ts`, `main/views/view-access.ts`,
  `main/settings/plugin-guest-access.ts` (`PluginGuestAccessStore`), `main/asks/guest-asks.ts`; Direct guest records
  and the certificate pin in `main/remote/` (`remote-service.ts`, `peer-certificate.ts`, `electron-remote-window.ts`).
- Renderer: `src/renderer/guests/` (Share / Live chip, guest list, invite dialog, presence, banner),
  `renderer/web/guest-pages*.ts` (redeem and end pages), the Plugins page's Guests control, the picker's certificate
  prompt.
- CLI: `ccc web invite|guests|kick|role` (`src/cli/guide/cli.md`).

## 16. Interfaces (binding)
Choices the sections above left open are marked **DECIDED HERE**.

### 1. Shared types

```ts
// src/shared/views.ts
export type Who = 'owner' | { readonly guest: string }          // frozen on the WebCaller at hello
export type GuestRole = 'read' | 'write'
export type ViewAccess = 'owner' | GuestRole

// src/shared/guests.ts (new)
export type GuestScope = 'all' | readonly string[]                 // TabRecord ids, remapped on restore like group leaves
export type GuestLifetime = '1d' | '7d' | 'forever'                // D-12
export const INVITE_UNUSED_MS = 24 * 3600_000                      // unused invite expiry, fixed
export const MAX_GUEST_TABS = 4                                     // D-21
export interface InviteRecord {
  id: string; hash: string /* sha256 hex of the token */; guestId: string
  name: string; role: GuestRole; projectId: string; scope: GuestScope; lifetime: GuestLifetime
  createdAt: number; expiresAt: number
}
export interface GuestRecord {
  id: string; name: string; role: GuestRole; projectId: string; scope: GuestScope
  createdAt: number; until: number | null                           // null: until removed
  openedTabs: string[]                                              // TabRecord ids (D-9, D-21)
}
export type GuestAccess =
  | { kind: 'owner' }
  | { kind: 'guest'; id: string; name: string; role: GuestRole; projectId: string; scope: GuestScope }
  | { kind: 'revoked' }
export interface GuestView {                                         // owner UI, `ccc web guests --json`
  id: string; name: string; role: GuestRole; projectId: string; scope: GuestScope
  state: 'pending' | 'live' | 'away' | 'offline'; until: number | null; inviteId?: string; inviteExpiresAt?: number
}
```

**DECIDED HERE**: `GuestAccess` is tagged (`kind`). `GuestStore.access(who: Who): GuestAccess` is the only lookup;
`isOwner(view: CallView)` (router) is `access(view.who).kind === 'owner'`.

**Devices** (`src/main/web/devices.ts`): `DeviceSignIn = 'link' | 'add' | 'password' | 'confirm' | 'guest'`;
`DeviceRecord` and `WebDevice` gain `guestId?: string`, required iff `mode === 'guest'` (else `recordOf` drops it).
`revokeSignedInWith` never matches `'guest'`; Revoke all includes guests.

**Plugin guest visibility** (`app.json` and the project record):

```ts
export type GuestVisibility = 'hidden' | 'shown'
// app.json:        pluginGuestAccess?: Record<pluginId, GuestVisibility>
// project record:  pluginGuestAccess?: Record<pluginId, GuestVisibility>   (absent key = use global)

// src/shared/guest-access.ts
export interface GuestAccessInput {
  manifest: Pick<PluginManifest, 'guests' | 'access'>
  appValue: GuestVisibility | undefined
  projectValue: GuestVisibility | undefined
}
export interface GuestAccessResult {
  effective: GuestVisibility; source: 'project' | 'app' | 'default'
  aware: boolean; blocked?: 'all-windows'
}
export function guestVisibility(input: GuestAccessInput): GuestAccessResult
export function guestPort(r: GuestAccessResult, role: GuestRole): 'none' | 'oneWay' | 'full'   // D-17
```

**DECIDED HERE**: a plugin with `access.sessions: 'all-windows'` that is not `guests.aware` is `blocked`
(always hidden): its panel can show other projects.

### 2. New IPC channels and changed shapes

New invokes (all `GUEST_CLASS: no`):

| Channel | Request → response | REMOTE_CLASS |
|---|---|---|
| `guests.list` | `void` → `GuestView[]` | adapted: owner views |
| `guests.invite` | `{ name, role, scope, lifetime }` → `{ ok: true; link: string; inviteId: string } \| { ok: false; error: string }` | adapted: desktop page; server mode an owner browser behind the armed confirm (D-11) |
| `guests.revokeInvite` | `{ inviteId }` → `boolean` | adapted: owner views |
| `guests.kick` | `{ guestId }` → `boolean` | adapted: owner views, any host |
| `guests.setRole` | `{ guestId, role }` → `boolean` | adapted: `read` from any owner view; `write` as `guests.invite` |
| `guests.setScope` | `{ guestId, scope }` → `boolean` | adapted: narrowing from any owner view; widening as `guests.invite` |
| `settings.pluginGuestAccessSet` | `{ pluginId, target: 'app' \| 'project', value: GuestVisibility \| null }` → `PluginView` | adapted: `hidden`/`null`-to-hidden from any owner view; `shown` as `guests.invite` |
| `presence.get` | `void` → `PresenceSnapshot` | yes (GUEST_CLASS `read`, filtered) |

**DECIDED HERE**: narrowing (kick, revoke, read, scope down, hide) is allowed from an owner browser on a desktop host
too, like §9.6's revoke; every widening follows D-11. `guests.invite`'s project is the caller's.

New events: `guests.changed: GuestView[]` (REMOTE adapted: owner views only; GUEST `drop`), `presence.changed:
PresenceSnapshot` (REMOTE yes; GUEST filter, §7).

Changed shapes:
- `TabInfo` + `openedByGuest?: string` (guest name) and `sharedWith?: string[]` (guest ids; stripped for guests).
- `PluginView` + `guestAccess: GuestAccessResult & { appValue?: GuestVisibility; projectValue?: GuestVisibility }`.
- `WebSnapshot` + `guest?: { name: string; role: GuestRole; ownerName: string }` (present only on a guest view).
- `app.linkNotice` + `to?: string`. **DECIDED HERE**: the sink cannot tell `toView` from a broadcast, so main stamps
  the target view; guests get only `to === viewId`.
- `CallView.who: Who` (type widens), `WebAccessView` and its patch + `ownerName: string` (D-24, default `"Host"`).

### 3. GUEST_CLASS, GUEST_EVENT, target extractors

```ts
// src/shared/guest-class.ts
export type GuestTarget =
  | { tab: string } | { panel: string } | { plugin: string } | { frame: string }
  | { overlay: string } | { group: string } | { ask: string }      // ask: a requestId shown to this view
type TargetField = 'tabId' | 'panelKey' | 'pluginId' | 'frameId' | 'overlayId' | 'groupId' | 'requestId'
type Names<R> = R extends object ? Extract<keyof R, TargetField> : never
export type GuestRule<C extends InvokeChannel> = [Names<Req<C>>] extends [never]
  ? { cls: 'no' | 'read' | 'write' }
  : { cls: 'no' } | { cls: 'read' | 'write'; target: (req: Req<C>) => GuestTarget[] }
export const GUEST_CLASS: { readonly [C in InvokeChannel]: GuestRule<C> }
export function guestClassOf(channel: string): GuestRule<InvokeChannel>   // Object.hasOwn, unknown = { cls: 'no' }

// src/main/web/guest-events.ts
export interface GuestFilterContext {
  viewId: ViewId; access: Extract<GuestAccess, { kind: 'guest' }>
  tabVisible(tabId: string): boolean; pluginVisible(pluginId: string): boolean
  overlayVisible(overlayId: string): boolean; personOf(viewId: string | null): string | undefined
}
export type GuestEventRule<E extends EventChannel> =
  'drop' | 'pass' | ((p: IpcEventMap[E], g: GuestFilterContext) => IpcEventMap[E] | undefined)
export const GUEST_EVENT: { readonly [E in EventChannel]: GuestEventRule<E> }
```

Router order: `remoteAllowed` → `GUEST_CLASS` (role ≥ cls) → targets (`tab` in scope; `panel`/`frame`/`plugin`
visible; `overlay` visible; `group` all members visible; `ask` shown to this view) → handler. **DECIDED HERE**: rules in
`shared/` beside `REMOTE_CLASS`, event filters in `main/web/`. `OverlayManager` keeps an internal
`origin: { tabId?; pluginId? }` per overlay (never on the wire) for `overlayVisible`.

Every existing channel (inv = invoke, ev = event). Filters: **T** only tabs in scope (`toIndex` recomputed); **S** strip
`env`, `room`, `sharedWith`, flag note (colour kept), `typedBy.device` → person name; **P** only visible plugins' items;
**G** the D-16 projection.

| Channels | REMOTE | GUEST_CLASS | GUEST_EVENT |
|---|---|---|---|
| `window.info` inv | yes | read | — |
| `window.reopen`, `window.state`, `projects.*`, `remote.*` | no / adapted | no | drop |
| `app.openExternal` inv | adapted | read (notice to own view) | — |
| `updates.*` | mixed | no | drop |
| `theme.get`, `theme.scheme` inv; `theme.changed` ev | adapted | read | pass |
| `prefs.get` inv; `prefs.changed` ev | yes | read | pass |
| `sessions.list` inv; `sessions.snapshot` ev | yes | read | T on `own`; drop `room`, `held` |
| `sessions.cancelQueued` | yes | write, tab | — |
| `sessions.closeAsk`, `closeSettled` ev; `closeAnswer` inv | yes | no | drop (**DECIDED HERE**: guests are left out of close asks and of the "all declined" count) |
| `links.ask`, `links.settled` ev; `links.answer` inv | yes/adapted | no (D-4) | drop |
| `trash.ask` ev; `trash.settled` ev; `trash.answer` inv | yes | write, ask (desktop host: Allow ignored, D-10) | `ask`: write guest and (`pluginId` visible); `settled`: pass |
| `downloads.start`, `failed`, `settled` ev | yes | — | pass (sent to one view) |
| `downloads.offer` ev; `downloads.answer`, `downloads.accept` inv | yes/adapted | write, ask (D-23) | `offer`: write guest and offer's tab in scope |
| `app.linkNotice` ev | yes | — | pass iff `to === viewId` |
| `oauth.signInEnded` ev; `oauth.paste` inv | yes/adapted | no | drop |
| `project.updated` ev | yes | — | pass |
| `project.goto` ev | adapted | — | drop |
| `layout.get` inv; `layout.updated` ev | yes | read | P on `panels`, zones, `appSlots`; `reveal` dropped if hidden |
| `layout.set` | adapted | no | — |
| `commands.list` inv; `commands.updated` ev | yes | read | P; drop `tabCommand`; core commands kept (shell disables by role) |
| `commands.run` | yes | write, plugin of the id (core ids: shell-safe set only) | — |
| `commands.trigger` ev | no | — | drop |
| `panels.connect` | yes | read, panel | — |
| `panels.action` | yes | write, panel | — |
| `panels.reload` ev | yes | — | P on `pluginIds`; empty → drop |
| `plugins.restart`, `plugins.limits.*`, `plugins.globalLimits.*` | yes/adapted | no | — |
| `slots.connect`, `slots.disconnect`, `slots.height` | yes | read, frame | — |
| `pageTabs.src`, `pageTabs.connect`, `pageTabs.disconnect` | yes | read, tab + its plugin | — |
| `pageTabs.unsaved` | yes | read | — |
| `pageTabs.dirty`, `pageTabs.discuss` | yes | write, tab | — |
| `settingsPage.*` | yes | no | drop |
| `settings.*` (web access, devices, ccc included) | yes/no/adapted | no | — |
| `notify.chime` ev, `notify.soundData` inv | adapted | no | drop |
| `notices.show`, `notices.gone` ev; `notices.click`, `notices.dismiss` inv | adapted | no | drop (**DECIDED HERE**: `PageNotice` has no source on the wire; no notices to guests in v1) |
| `webAccess.state` inv, `webAccess.changed` ev, `webAccess.confirmAnswer`, `ccc.offer` | no/adapted | no | drop |
| `overlays.list` inv; `overlays.updated` ev | yes | read | keep `overlayVisible`; P on `typeButtons`; `discuss` dropped for read |
| `overlays.data` ev | yes | — | pass iff `overlayVisible` |
| `overlays.ack` | yes | read, overlay | — |
| `overlays.input`, `overlays.resize`, `overlays.close`, `overlays.result`, `overlays.button`, `overlays.discuss` | yes | write, overlay | — |
| `overlays.message` (both), `overlays.ready`, `overlays.loaded`, `overlays.take` | yes | no | drop (**DECIDED HERE**: a guest never holds an html overlay; it sees the "Open on <device>" note) |
| `overlays.bounds`, `webviews.placement` | no | no | — |
| `webviews.current`, `webviews.place` | adapted | read, panel | — |
| `webviews.step`, `fit`, `input`, `insertText`, `selectChoose` | adapted | write, panel | — |
| `webviews.navigated`, `cursor`, `selection`, `select` ev | adapted | — | pass iff panel's plugin visible |
| `tabs.list` inv; `tabs.added` ev | adapted/yes | read | T, S |
| `tabs.create` | yes | write (cap 4; kinds `claude`, `shell`; `beside` only a visible tab) | — |
| `tabs.commands` | yes | no (**DECIDED HERE**: no command tabs from the owner's menu) | — |
| `tabs.close` | yes | write, tab (own tab; else the owner is asked, D-9) | — |
| `tabs.restart`, `tabs.input`, `tabs.resize`, `tabs.fit` | yes | write, tab (D-14 rules in `ViewSizes`) | — |
| `tabs.visibility` | yes | read | — |
| `tabs.ack`, `tabs.selected` | adapted | read, tab (`selected` never sets `activeTab`) | — |
| `tabs.reorder`, `tabs.rename`, `tabs.flag`, `tabs.toggleFlag`, `tabs.roomMark` | yes/adapted | no | — |
| `tabs.screen` inv; `tabs.screenAsk`, `tabs.data` ev | no/adapted | no | drop |
| `tabs.typed`, `tabs.exit`, `tabs.removed`, `tabs.select` ev | yes | — | T (`typed`: `device` → person name) |
| `tabs.moved` ev | yes | — | T, `toIndex` over visible tabs |
| `tabs.exitFocus` ev | yes | — | pass iff both ids visible |
| `rooms.*` | mixed | no | drop |
| `groups.get` inv; `groups.changed` ev | yes | read | G |
| `groups.place`, `remove`, `dissolve`, `resize`, `rename`, `area` | yes | no | — |

A tab leaving a guest's scope sends that view `tabs.removed`; one entering, `tabs.added`.

### 4. HTTP and WebSocket

`POST /auth/invite` (Host and Origin checks, own `AttemptLimiter`, D-19). Body `{ "token": string }` (43 base64url
chars). Answers: 200 `{ ok: true, key, project }` + `Set-Cookie` (consumed in the same synchronous step); 400
`bad request`; 404 `invalid`; 410 `used` | `expired`; 409 `owner-device` | `none-mode` (D-1); 429 `busy`. Errors are
`{ ok: false, error }`.

Guest answers of existing routes: `GET /` and assets as today; `GET SESSION_PATH` adds `guest: { name, role,
project }`; `GET /api/projects` → own project only (or `[]`); `GET /api/sessions`, `POST /api/projects`, `/api/folders`
→ 404 (D-26); `/p/`, `/o/` → 404 unless visible; `/d/` minted only for a write guest; `hello` naming another project →
close 4403.

New close codes (`CLOSE` in `shared/web-protocol.ts`), page texts:

- 4403 `guestProject` "This invite is for another project." (final)
- 4460 `kicked` "<owner> removed you." (final, terminals cleared)
- 4461 `roleChanged` "<owner> made you a read-only / write guest." (reconnect at once)
- 4462 `projectClosed` "The host closed this project." (retried with backoff)
- 4463 `accessEnded` "Your access ended." (final, lifetime over)

**DECIDED HERE**: a role switch gives the guest new view ids, so a view's `access` never changes during its life.

### 5. SDK and plugin API

```ts
// src/sdk/types.ts
export type ViewAccess = 'owner' | 'read' | 'write'
onMessage(panelId, listener: (message: JsonValue, from: { view: string; access: ViewAccess }) => void): Disposer
interface PageTabInstance { readonly access: ViewAccess }   // and SlotInstance
readonly views: {
  // undefined once the view is gone; fixed for a view's life
  access(view: string): ViewAccess | undefined
  onChange(listener: (e: { view: string; access: ViewAccess | undefined }) => void): Disposer
}
```

`access` comes from main's port tag (`PanelPortPayload` + `access`), never the page. `ccPanel.view.access` (shell's
`cc-plugin.port` message, from `WebSnapshot.guest`) is a UI hint only. A one-way port (D-17): main drops page→host
messages in `PortRelay.fromPage`, logged once per (plugin, view).

Manifest: top-level `"guests": { "aware": boolean }`, schema strict inside (`additionalProperties: false`), tolerated
by older apps (top level is open, `manifest.ts:286`). `PluginManifest.guests?: { aware?: boolean }`;
`isGuestAware(m)`. Guide: new topic section "Guests" in `src/cli/guide/` plus the drift test.

### 6. `ccc web` commands

All four join `HOST_ONLY_COMMANDS` (`web.invite`, `web.guests`, `web.kick`, `web.role`). Exit 0 on success, 1 with one
line on stderr when refused.

- `ccc web invite --project <id|path> --name <name> --role read|write [--tabs all|<id>,<id>] [--lifetime 1d|7d|forever]
  [--json]`: prints the link (`--json`: `{ link, inviteId, guestId, expiresAt }`). Server mode only (D-25). **DECIDED HERE**: `--lifetime` is D-12's
  guest lifetime (default `1d`); the unused invite always expires after 24 h (design §12's `--expires` dropped).
- `ccc web guests [--json]`: a row per guest and pending invite (id, name, role, project, scope, state, until);
  `--json`: `GuestView[]`. Both hosts.
- `ccc web kick <guest-id|name> | --invite <invite-id>`: both hosts; a name matching two guests is refused.
- `ccc web role <guest> read|write`: `read` on both hosts; `write` server mode only.

### 7. `presence.changed`

```ts
export interface PresencePerson {
  id: string                         // 'owner' or the guest id
  name: string                       // owner: the D-24 setting
  role: ViewAccess
  color: number                      // palette index 0..7, stable per id
  state: 'live' | 'away' | 'reconnecting'
  tabId: string | null               // the tab its most recently active view shows
  elsewhere?: true                   // guest filter: on a tab this guest cannot see
  typing: boolean                    // keys in the last 2 s
}
export interface PresenceSnapshot { seq: number; people: PresencePerson[]; lastTyped: Record<string, string> } // tabId → person id
```

At most 4 a second. Guest filter: an invisible `tabId` → `null` + `elsewhere`; `lastTyped` only for visible tabs.

### 8. Review additions (details in §18)

- `src/shared/guest-filter.ts`: `GuestFilterContext`, pure filters T, S, P, G, the project filter (D-33),
  `askVisible` (built as `askInfo`), `tabVisible(access, tab, openedTabs, pluginVisible)`; used by the connection's
  sink and snapshot and by the router's invoke answers (§18 item 3).
- `src/main/ipc/guest-deps.ts`: `GuestService`, `PluginGuestAccessService`, `PresenceService` with the methods in
  §18 item 4; `ViewRegistry.addRemote(..., who)` and `whoOf(viewId)` (§18 item 5).
- D-9 channels `tabs.guestCloseAsk` / `tabs.guestCloseAnswer`, `tabs.close` → `{ asked: true }` (§18 item 6).
- `guests.shareTab`, `GuestView.unsaved`, `WebSnapshot.guest.id`, `GUEST_SAFE_COMMANDS`, invite error codes and
  `warning`, `PanelPortPayload.oneWay`, close code `4464 accessChanged`, `onAction`'s `from`, `/auth/session`
  `guestEnded`, `DownloadOffer` origin tab, overlay `origin`, invite link `c=` certificate pin (D-29).
- Extractors take `unknown` and fail closed; `Req` lives in `ipc.ts` (§18 item 7).

## 17. Decisions

Settled; where the sections above disagree, these win.

**Amendments to the first brief**

### D-1: No guests under None mode
Options: refuse invites under None; build a guest-only listener. Picked: refuse. Why: `authorize()` returns the
anonymous owner when no cookie matches (auth.ts:464), so a guest who drops their cookie becomes the owner. Invites need Link, Password or Desktop confirm.

### D-2: Read guests read files only in page tabs shared with them
Options: shared page tabs only; a per-view file viewer (new mechanism). Picked: shared page tabs only; read guests
cannot open new ones. Why: page tabs are project-wide (`TabManager.createPage`).

### D-3: A write guest's typing sets `typed`
Why: `typed` protects a human typing from a plugin paste. Flags, room marks, Pause, Resume, Remove stay owner-only.

### D-4: The plugin-link approval is never a guest's
The only `links.ask` is the `ccc plugin link` confirm (code installed as the owner); a remote view's link already opens
on the viewer's side. Write guests' approvals are trash and downloads (D-11, D-23).

### D-5: LAN is not "out of the box"
A LAN guest needs a network bind plus TLS, or the plain-http confirm; the invite dialog says how.

### D-6: A kick stops further output; what was seen cannot be recalled
Docs say so.

**Product decisions**

### D-7: No turn-taking in v1
Options: a per-tab keyboard floor with an answer guard; none, presence shows who typed last.
Picked: none. Input from several people interleaves as today; presence shows who is typing and who typed last. The
double-answer hazard at a permission prompt is accepted for v1 and named in the docs.

### D-8: Team becomes guest-aware
`bronos.team` (its own repo) declares `guests.aware`; read guests get team state and room docs; every Team
action (start, hire, fire, invite, end, ...) is refused for any guest.

### D-9: Write guests close only tabs they opened
Closing one of the owner's tabs from a write guest asks the owner.

### D-10: Approvals keep today's rule
On a desktop host a guest may only Deny an approval (as the owner's own browser today: `!view.remote || server`); in
server mode a write guest may Allow trash asks and their own download offers.

### D-11: Server mode: the owner's browser may invite and upgrade to write, behind an armed confirm
A deliberate exception to "a remote view cannot add or widen access", only for an owner view (`isOwner`), through
`ApprovalDialog`-style arming.

### D-12: Guest lifetime picked at invite
1 day / 7 days / until removed, default 1 day; guests survive a host restart.

### D-13: Sharing a tab shares its scrollback
The invite dialog says "Scrollback from before now is visible in shared tabs."

**Picks that stood**

### D-14: Write guests and terminal size
Read guests never size. Write guests take the size only by explicit acts (typing, the debounced take; "Fit to this
screen"); implicit takes (page load, select, pointer press, refocus) are refused for guest views in main. The fallback
prefers owner views; guest views are dropped from `groups.area`.

### D-15: Owner switching to None with guests in or invites pending is refused, naming the guests

### D-16: A hidden split-group member is removed from the guest's projection, shares renormalised
The group's name is hidden if any member is.

### D-17: Plugins that are not guest-aware
Read guests: one-way (display-only) port, their messages dropped and logged once. Write guests: full messages.

### D-18: The outbound filter sits at the guest connection's sink, `WebConnection.event`
Snapshot, `paths` and ports are filtered at their own points.

### D-19: Invite redemption has its own failed-attempt bucket
So guessing invites on a public tunnel cannot slow the owner's sign-in.

### D-20: One device per invite
A second device is another invite for the same guest.

### D-21: A write guest's new tab
In that guest's scope and every all-tabs guest's, not other selected-tabs guests'; tagged `openedByGuest`; stays when
the guest leaves; at most 4 per guest.

### D-22: Quick chat and Ask Claude: write guests yes, read guests never

### D-23: Downloads
The file goes to the guest's own device: write guests may download (Files menu `/d/`, and accept `ccc download` offers
started from a shared tab) on any host; read guests never. Trash stays Deny-only for guests on a desktop host (D-10).

### D-24: The owner's name in presence is a Web access setting, default "Host"

### D-25: `ccc web` on a desktop host: `guests`, `kick`, `role … read` only
`invite` and `role … write` are refused there (minting stays on the desktop page).

### D-26: Gateway refusals to guests answer 404, not 403

**From the review of the interfaces** (§18)

### D-27: Plugin-opened tabs give guests nothing extra
Options: hint-based (a tab a plugin opens from a write guest's view joins that guest's scope); no widening. Picked: no
widening. Main never rests a check on the origin-view hint.

### D-28: Server mode becomes a macOS feature of its own
Designed and built as its own feature. The guest build does not wait: the guest
design keys on the `server` flag, not the platform. The server-mode guest e2e specs are written now and run once macOS
server mode lands.

### D-29: The guest's own app may trust a self-signed certificate, pinned by the invite link
Options: accept and document; a trust prompt. Picked: trust prompt, pinned: the invite link carries `c=<sha256 of the
host's TLS certificate>`; the guest's app accepts only that certificate, after a one-time prompt showing origin and
fingerprint, and saves the pin; any other certificate error is refused as today; a changed certificate is never a
question (refused, fixed by Forget).

### D-30: Any scope or visibility change for a live guest reconnects it
Close code `4464 accessChanged`, reconnect at once to a fresh `ready`; page tokens dropped.

### D-31: A guest joining never changes the owner's own dialogs
`chooseAsk`'s "a remote view is attached" counts owner views only.

### D-32: Guest end pages and landing
`/auth/session` answers `guestEnded` for a cookie of an ended guest (hash tombstone, 7 days, capped); guest pages have
no picker link; a guest at `/` goes to its project.

### D-33: The host's path and project record never reach guests
`window.info` and `project.updated` are `{ id, name, colour }` for guests.

### D-34: Bundled plugins for guests
Sessions stays blocked; Usage unchanged and hidden by default (the Plugins page shows only the generic exposure text
from `src/shared/guest-exposure.ts`, no special case for a `cockpit.*` id; the docs say Usage shows the account's
spend); Files and Editor per §18 item 19; Team per item 20.

### D-35: Inviting on loopback only is a warning, not a refusal

## 18. Review answers

The answers to the review of the interfaces, numbered as the code cites them ("spec-review n"); items about
work split and tests (1, 2, 26, 28 to 32) are left out: item 1 gave each file one owner (and is where `restore.ts`'s
`onRestored(projectId, idMap)` hook comes from, which `GuestStore.remap` consumes), item 29 put the guest test fixtures
and `__ccTest` hooks in `test/fixtures` and `main/test-hooks.ts`.

3. **Where invoke answers are filtered, and the one visibility predicate**. Pure functions in
   `src/shared/guest-filter.ts`, used by the connection's sink and snapshot and by the router's handlers (`tabs.list`, `sessions.list`,
   `layout.get`, `commands.list`, `overlays.list`, `groups.get`, `pageTabs.unsaved`, the `TabInfo` of `tabs.create` and
   `tabs.restart`): `GuestFilterContext`, the T, S, P, G filters, the project filter (item 8), `askVisible`, and
   `tabVisible(access, tab: {id, openedBy?, page?: {pluginId}}, openedTabs, pluginVisible)`. `GuestService` wraps
   them with live data (`tabVisible(guestId, tabId)`, `pluginVisible(projectId, pluginId)`).
4. **The deps' methods**. `src/main/ipc/guest-deps.ts`:
   `GuestService { access(who); whoAccess(viewId); tabVisible(guestId, tabId); pluginVisible(projectId, pluginId);
   openedTabs(guestId); noteOpenedTab(guestId, tabId); list(); invite(projectId, req); revokeInvite(id); kick(id);
   setRole(id, role); setScope(id, scope); shareTab(id, tabId, shared); remap(projectId, idMap); unsaved(id);
   onChange(listener) }`, `PluginGuestAccessService { visible(projectId, pluginId); port(projectId, pluginId, role);
   set(pluginId, target, value, projectId?); onChange(listener) }`, `PresenceService { snapshotFor(viewId) }`.
   The router checks "widening only from an owner view" (adapted class); the services take no caller.
5. **The view's role from a bare `ViewId`**: `ViewRegistry.addRemote(windowId, viewId, sink, who)` and
   `whoOf(viewId)`; `connection.ts` passes `who`; the role is read live through `GuestService.access`.
6. **D-9 has no channel**: `tabs.guestCloseAsk` (event, owner views only, GUEST `drop`),
   `tabs.guestCloseAnswer` (invoke, owner views, GUEST `no`), on `SharedAsks` (an `ApprovalDialog` in every owner view;
   timeout 60 s denies); `tabs.close` answers a guest `{ asked: true }`; the guest sees "Asked <owner>", then the tab
   closes or "<owner> kept the tab open".
7. **Target extraction**: extractors take `unknown` and fail closed (malformed = refused); explicit entries for
   `commands.run` (`id` = `plugin/cmd`), `tabs.create.beside.tabId`, Discuss `target.tabId`, `overlays.button.pluginId`,
   one unit test each; `Req` moves from `router.ts` to `ipc.ts`.
8. **The host's path and the project record reach guests**: `window.info` and `project.updated` are
   filtered to `{ id, name, colour }` for guests (`path: ''`); no `serviceProviders`, plugin overrides or settings.
9. **Asks shown to a view**: `askVisible(kind, info, access, ctx)` decides both the sink drop and the answer
   check; `DownloadOffer` keeps a main-only origin tab (from `CliCall.tabId`) so D-23's "from a shared tab" holds.
10. **Smaller additions**: `WebSnapshot.guest.id`; `GuestView.unsaved?: string[]` (titles of
    that guest's dirty page tabs, from main's per-(tab, view) dirty;);
    `guests.shareTab { guestId, tabId, shared }` (the tab menu; `guests.changed` is the source of truth);
    `GUEST_SAFE_COMMANDS` (core command ids a write guest may run); `guests.invite` error codes
    `none-mode | name-taken | cap | full` plus `warning?: 'loopback-only'`; `PanelPortPayload.oneWay` set by main from
    `guestPort`, honoured by `PortRelay`.



11. **Plugin-opened tabs for guests**. D-27: no widening. A plugin-opened tab follows normal
    scope (all-tabs guests see it; selected-tabs guests once the owner shares it); never tagged or capped from the
    origin-view hint; bundled plugins refuse open actions for read guests.
12. **A plugin hidden or a tab unshared while a guest is in**: the guest's views close with a new
    `4464 accessChanged` (reconnect at once, fresh `ready`), the device's page tokens are dropped; an all-tabs guest's
    new tabs still arrive as filtered `tabs.added` (D-30).
13. **Owner unchanged when a guest joins**: `chooseAsk`'s `hasRemoteView` counts owner views only (D-31).
14. **Streamed webview size**: read guests are viewers, never size owners; write guests claim only by press, key
    or Fit, never by a first report while an owner viewer exists. The shell skips implicit `tabs.resize`/`fit` for read
    guests and for write guests until a key or Fit; main refuses them anyway (D-14).
15. **Room sites**: every `view.remote` site in `room-handlers.ts` becomes `isOwner`; router 1611 (ack) and 1836
    (`keepGeometry`) go on the grep test's allow list; 1475 and 1644 get guest branches.
16. **Overlay origin**: `OverlayManager.start/open` take `origin?: { tabId?, pluginId? }`; index.ts passes
    `CliCall.tabId`; an overlay with no origin is hidden from guests.
17. **Plugin API**: `ctx.views` learns views from port tags host-wide (gone when a view's last port closes);
    `onAction` listeners get `from: { view, access }` (additive).
18. **"What a plugin exposes"**: generic core text from `aware` and the port kind; no manifest text in
    v1.
19. **Bundled plugins**: Sessions stays blocked (`all-windows`); guests get Claude status from core's tab
    strip. Usage: no code change, hidden by default, the Plugins page warns that it shows the account's spend. Files:
    the expand set stays shared; `root` omitted for guest views; `reveal` and `open-system` refused for all guests.
    Editor: read guests refused save, rename, code actions, notes, quick chat, Ask Claude, `openFile`, `micro`, `close`;
    all guests refused `openFile.outside`; a write guest's quick-chat model pick is not saved app-wide.
20. **Team**: guest reads `hello/select/ping/activity/docs/doc`; every action refused for guests; `exportDir`
    stripped from guest state; `ccc team` from a shared tab is the write trust (out of scope).
21. **`/o/`, paths, `hello`, devices**: a guest's `paths` have `overlays: ''` and `/o/` 404s; `/p/` per project
    through `pluginVisible`, `pathsChanged` on visibility change; at `hello`, any other project closes 4403 (open or
    not: no oracle), its own project with no window 4462; redeem with the device store full answers 503 `full` and
    leaves the invite unspent; pruning a guest's device ends the guest; 2 views per guest device at `hello`; the redeem
    POST is keyed (an owner device gets 409, a browser with a guest cookie may redeem).
22. **Guest end pages**: the bridge keeps the last `WebSnapshot.guest`; guest pages have no picker link; 4461
    and 4464 reconnect with no backoff; `/auth/session` answers `guestEnded: true` for a cookie of an ended guest (main
    keeps a hash tombstone for 7 days, capped); a guest at `/` is sent to `?project=<id>` (D-32).
23. **D-11 arming and server-mode settings**: arming is the renderer's `ApprovalDialog`-style confirm (a
    hint); main's rule is `server && isOwner`; a name-only Web access patch (`ownerName`) is allowed from an owner
    browser (it grants nothing).
24. **Read vs write guest UI**: write guests see New tab (Claude and Shell only), Fit and Close; no other tab menu
    item; no settings gear for any guest.
25. **Loopback invites**: main does not refuse; `guests.invite` returns `warning: 'loopback-only'` and the dialog
    says how to get a non-loopback address (D-5 stays as text).

27. **Self-signed certificates in the guest's app**. D-29: add a trust prompt, pinned: the host adds
    `c=<sha256 of its TLS certificate>` to invite links when it serves TLS; the guest's app, on a certificate error for
    that origin, accepts only a certificate whose fingerprint equals the link's, after a one-time prompt showing origin
    and fingerprint, and saves the pin in the guest record; any other certificate error is refused as today; a changed
    certificate is never a question (refused, fixed by Forget).

## 19. Implementation notes (differences from the sections above)

- **Unused invites** expire after a fixed 24 h (`INVITE_UNUSED_MS`), not "at most 7 days" (§3); the guest's lifetime
  (D-12) counts from the redeem. `ccc web invite` takes `--lifetime 1d|7d|forever`; §12's `--expires` was dropped.
- **Loopback-only invites** are made with `warning: 'loopback-only'` (D-35), not refused as §13 says.
- **Bundled plugins** (§6): only Files and Editor declare `guests.aware`. Sessions is never shown to guests
  (`all-windows`, not aware: `blocked`), Usage is unchanged and hidden by default (D-34); guests get Claude status from
  core's tab strip.
- **Host paths** (D-33): `window.info` and `project.updated` reach a guest as `{ id, name, colour }` with `path: ''`
  (`project.updated` is "pass" in §16.3); a trash ask and a download offer reach a guest with the file name only.
- **Terminal follow** (§5): the shared-tab check is `canFollow` in `main/web/connection.ts`, not `ViewTerminals`.
- **Notices** (§5, §10): no notices reach guests in v1, plugin notices included (§16.3's `PageNotice` has no source).
- **Redeem answers** (§16.4): `bad-request` (hyphenated), and 503 `full` when the device store is full (the invite
  stays unspent). The invite answer also carries `guestId`, `expiresAt` and `warning?`. At most `MAX_GUESTS` (16)
  guests and pending invites app-wide (`cap`).
- **Ends and close codes** (§14, §16.4): a kick and a forgotten project close 4460; a lifetime's end and a revoke or
  idle expiry of the guest's device close 4463; a scope, share or plugin-visibility change closes 4464 and drops the
  device's page tokens (D-30). Every end closes the views before revoking the device and leaves a 7-day tombstone (D-32).
- **Heartbeat** (§10): guest sockets have their own 10 s ping (`GUEST_HEARTBEAT_MS`, `gateway.ts`); the owner's 30 s
  beat is unchanged.
- **D-29 check**: main reads the certificate the origin presents with its own TLS handshake that sends nothing
  (`main/remote/peer-certificate.ts`) and asks only when it equals the link's pin; the window's certificate verify proc
  refuses any other certificate for a pinned host. Not yet run in real Electron against a self-signed host.
- **Names**: `askVisible` is built as `askInfo` (`main/asks/guest-asks.ts`); the plugin visibility service is
  `PluginGuestAccessStore` (`main/settings/plugin-guest-access.ts`); `ViewRegistry.ownerRemoteViews` /
  `hasOwnerRemoteView` serve D-31.
- **Owner UI** (§10): with no guest or invite yet, the top bar shows a **Share** button (only while web access is on,
  and only where the view may invite) in place of the Live chip.
