# Overlays in every view (guests included)

Status: decided (Oleg, 2026-11-20, §8); revised after an independent review (codex sol/high, 12 findings, all taken:
§4 provenance, §5 lifecycle and limits, §6 the Reviewer). Next: a plan. Builds on design-web.md §5.4 (an html overlay's
page in one view, Take over) and design-guests.md §9 and §16.3 (the `overlays.*` row: "a guest never holds an html
overlay"), which this reverses for `perView` overlays; design-guests.md gets a pointer here.

## 1. Problem

A guest who may see a plugin (Settings › Plugins, shown to guests) gets nothing from its html overlays: the Reviewer's
diff, opened by the owner, shows the guest only "Open on Desktop". Found by Oleg sharing a project from his Mac to his
work Mac with the Reviewer shown (2026-11-20). The Reviewer has no panel, so showing it to guests gives them nothing.

Why it is so today (design-web.md §5.4): main keeps one `pageReady` flag and one outbox per overlay, `post` goes to the
holder view only, and plugins treat the page as one (the Reviewer posts `init` once and each page posts its whole
draft). So one view holds the page, the owner's other views show "Open on <device>" with Take over, and a guest gets the
note with no button (`overlays.take`, `.message`, `.ready`, `.loaded` are guest `no`).

The page's URL is not the obstacle: a plugin-file overlay loads from `/p/<token>/`, which a guest already has for every
plugin shown to it. The obstacles are the single holder and an overlay API that cannot tell views apart.

Found on the way, in 0.24.0: an overlay another plugin opens *through* the Reviewer (Gmail's mail via the `reviewer`
service) counts as the Reviewer's (`overlay-manager.ts:629`, origin = the plugin whose host call opened it), so a guest
shown the Reviewer but not Gmail gets that overlay's title (the mail subject). §4 fixes it for every overlay.

## 2. Idea

An html overlay works like a panel for plugins that say they can: **every view that shows the overlay loads its own
copy of the page**, each copy on its own line, and the plugin hears who sent each message and can answer one copy or
all. Panels already work this way (`ctx.panels.onMessage(panelId, (m, { view, access }))`, `post(..., { view })`,
`ctx.views`).

Opt-in per plugin, because a plugin written for one page breaks with two (the Reviewer: `init` once, whole-draft saves):

```json
"overlays": { "perView": true }
```

An older app ignores the key (unknown top-level keys are tolerated). A plugin without it keeps today's behaviour: one
holder, Take over among the owner's views, and a guest sees the note, reworded (§7). Inline overlays (`ccc overlay
--html`) stay owner-only: no plugin to opt in, and the `ccc` caller waits for one result.

## 3. Plugin API (additive)

On `OverlayHandle` (`src/sdk/types.ts`), for a `perView` plugin; every `from` is filled by main from the connection it
bound, never from a page or a payload:

- `ViewFrom` gains `person?: string`: a guest's name as the owner typed it in the invite, set by main; absent for the
  owner. The one trustworthy author for anything a plugin records (§6 notes).
- `onConnect(listener: (from: ViewFrom & { copy: string }) => void)` and `onDisconnect(listener(from))`: a copy is up or
  gone. `copy` is an opaque generation id main mints per load; a reload, a reconnect or a view returning is a new copy
  (disconnect of the old one first). The plugin sends each copy its starting state on connect.
- `onMessage(listener: (message, from) => void)`, `post(message, { copy? })`: no `copy` = every live copy; `{ copy }` =
  that one. A post to a gone copy is dropped.
- `onButton(id, listener(from))`, `onDiscuss(listener(from))`, and the by-type buttons other plugins add
  (`ctx.overlay.buttons(type, ...)`, `run(info, from)`): who pressed. Owner views included: today an owner browser's
  Discuss and buttons lose their view and act as the desktop (`overlay-manager.ts:1235`, `:1276`); the caller's view now
  travels router → manager → host for every overlay call.
- `ctx.openExternal(url, { view })`: open on that view's device. Main routes it to that view only (a browser view gets
  it as its own link open; the desktop page opens it with the system opener only when `view` is the desktop); a gone
  view or a guest's view never falls back to the system opener: refused. A plugin answering a page message passes
  `from.view`; it never relies on where its listener runs (the origin-view hint has a 10 s cap and expires to the owner's
  machine, `origin-view.ts:78`, `open-external.ts:93`).
- `handle.close()` stays "close for everyone"; a `perView` plugin calls it only for an owner's or a write guest's request
  (D-2). There is no plugin call to hide one copy: a read guest's hide is the shell's (§5).

Non-`perView` plugins see no change: the extra arguments are present and name the holder.

## 4. Provenance: whose content an overlay shows

An overlay is shown to a guest only when **every plugin whose content it carries** is visible to that guest (or it came
from a shared tab, as today). Main keeps that set per overlay as `origin.via`, only ever growing, never from a plugin's
arguments alone:

- The plugin host adds the service caller chain of the frame any overlay call is made in (`start`, `post`, buttons,
  title): `ctx.services` already binds the consumer per call (`caller`). Content that arrives in a service call and is
  shown in it is covered automatically.
- Deferred fills leave the frame (`caller` is empty once the call settles, `services.ts:819`; events never carry it,
  `:424`), so a provider that shows a consumer's content later attributes it itself: `handle.addSource(pluginId)`, with
  `pluginId` read from `ctx.services.caller` while the call was live. The Reviewer does this for `prepare` → `annotate`
  by key and for the page's `content` handshake (content is stored with the consumer that sent it).
- Fail closed: a `perView` overlay of a plugin that provides a service, opened outside any service frame and never
  attributed, is not shown to guests until its first content is attributed. The guide's provider rules say so; like
  `caller`, it is a contract between plugins in one host, not a boundary.
- The same set gates `overlays.updated` / `overlays.data` for non-`perView` overlays, which closes the 0.24.0 title leak.

## 5. Main and the shell

- **Copies.** `OverlayManager` keeps per `perView` overlay a map copy → `{ view, ready, outbox }`. Which views load one:
  every live view of the window that may see it (owner views always, D-1; a guest view by §4 and its guest port not
  `none`), **never server mode's hidden page** (render eligibility checked in the shell too: with no `heldBy` the hidden
  page would otherwise pass `shell-kind.ts:57`). A copy is registered on the page's port connect and released on unmount,
  reload, view gone or guest kicked (the shell tells main; main also drops a view's copies when the view goes), with the
  view joining and leaving `ctx.views` membership as panels do (`ui.ts:222`).
- **Limits.** Each copy's outbox (only while that copy is not ready) has today's bounds (100 messages, 8 MiB counted as
  today, by string length). Today an overflow throws to the plugin (`overlay-manager.ts:331`); for a fan-out that would
  let one slow copy fail every post, so a copy whose queue overflows is dropped and reloaded as a new copy (the plugin
  gets its disconnect and a new connect), and the post succeeds for the others. Connects per (overlay, view) are capped
  per minute as panel ports are (`panel-ports.ts:258`); past it the copy waits for the next window.
- **Guest rows** (`shared/guest-class.ts`, `main/web/guest-events.ts`): `overlays.ready`, `.loaded`, `.message` become
  `read` with the overlay target, and their handlers refuse a non-`perView` overlay to a guest, so the class widens
  nothing for old plugins; `overlays.message` events reach a guest for its own copies only; `overlays.take` stays `no`.
  Read guests follow the panel rule (D-17): a plugin that is not `guests.aware` gives a read guest a one-way copy.
- **✕ and results** (D-2). `overlays.close` stays guest `write`: a write guest's ✕ closes the overlay for everyone. A read
  guest's ✕ hides that guest's copies, in the shell: the copy unloads (main gets the release), the overlay leaves that
  view's stack, and it does not come back for that overlay. A page's `{ result }` is accepted from owner views only; in
  a read guest's shell it is turned into that hide before any channel (`overlays.result` stays `write`, so a forged one
  is refused by class); from a write guest it closes for everyone with no result.

## 6. The Reviewer

Declares `perView` and `guests.aware` (without `aware` a read guest's copy is one-way, and the page starts the `content`
handshake itself, so it would stay blank).

- **State per overlay, replayable.** The host keeps each overlay's current state: content and assets, hidden parts,
  status (loading, failed, error), layout, the draft. Today content is dropped after its first delivery and later
  assets are posted and forgotten (`host.js:818`, `:673`); a reload or a late copy must rebuild the same page from
  `onConnect`, prepared (loading or failed) overlays included.
- **Guest-safe payloads.** What a guest copy gets is projected: no host path (`sides` carries `root`, `host.js:472`,
  sent whole in `init`, `:643`; design-guests D-33), file names relative to the project only.
- **Shared notes** (D-3). The draft is the host's: a page sends note edits (add, change, delete by note id) and the host
  applies them, saves, and posts the change to every copy. Each note keeps `author` from `from.person` (absent = the
  owner), stored through the draft cleaning (`lib/review.js:133` keeps the field), never taken from the page. `global`
  is one text, last writer wins. Read guests' edits are dropped.
- **Discuss** sends the shared draft (write guests and the owner, as today). On delivery it removes only the notes it
  sent, unchanged since the snapshot; notes added or edited meanwhile stay (today it deletes the whole draft,
  `host.js:918`).

What the host does with each page message, by `from.access` (the host decides, never the page):

| Page message | Owner | Write guest | Read guest |
|---|---|---|---|
| note edits, `global`, `draft-unsaved` | applied, saved, sent to all copies | same, author = guest | dropped |
| `layout`, `split` (the owner's app-wide prefs in `ctx.appStorage`) | saved | that copy only, not saved | that copy only, not saved |
| `content` (load the page's content) | yes | yes, projected | yes, projected |
| `retry` (asks the consumer again: a service `action` with no `from`) | yes | dropped, button not drawn | dropped, not drawn |
| `view` (Original / Reader for a mail; re-emitted on the service) | re-emitted | that copy only | that copy only |
| `action` (a consumer's button: Gmail archive, Inbox Done; re-emitted on the service) | re-emitted | dropped, not drawn | dropped, not drawn |
| `open-url`, `open-link` | `ctx.openExternal(url, { view: from.view })` | same, on the guest's device | same, on the guest's device |
| `close` (the page's own close, the failure page's too, `host.js:261`) | `handle.close()` | `handle.close()` (D-2) | nothing (the shell's hide covers it) |

Toolbar buttons other plugins add by type (Inbox's Done on a mail) keep today's guest rule (shown to a guest only when
that plugin is visible to it, pressed only by a write guest) and now get `from`, so a plugin can decide more narrowly.

## 7. Guests of plugins that are not perView

The note says why instead of only where: "Open on <owner>'s screen. <Plugin> does not show its windows to guests." The
Plugins page, where a plugin is shown to guests, says whether its windows (overlays) are shown too.

## 8. Decisions (Oleg, 2026-11-20)

- **D-1 Owner's other devices: every screen gets a copy.** With a `perView` plugin the owner's own views (desktop and
  browsers) each show their own live copy; no Take over for that overlay. Take over stays for older plugins.
- **D-2 A guest's ✕: write guests close it for all.** A write guest's ✕ closes the overlay for everyone, the owner
  included; a read guest's ✕ hides only that guest's copy.
- **D-3 Reviewer notes: shared, write guests edit too.** Owner and write guests add and edit notes live, merged per
  note, each note with its author; read guests see them and cannot edit. Discuss sends the one shared set.

## 9. Not in this change

Inline overlays for guests; terminal overlays (already shown to guests by origin); a live cursor or presence inside an
overlay; `perView` for the hello example beyond a demo.
