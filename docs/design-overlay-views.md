# Overlays in every view (guests included)

Status: decided (Oleg, 2026-11-20, §7); independent review next, then a plan. Builds on design-web.md §5.4 (an html overlay's page in one view, Take
over) and design-guests.md §9 and §16.3 row `overlays.*` ("a guest never holds an html overlay").

## 1. Problem

A guest who may see a plugin (Settings › Plugins, shown to guests) gets nothing from its html overlays: the Reviewer's
diff, opened by the owner, shows the guest only "Open on Desktop". Found by Oleg sharing a project from his Mac to his
work Mac with the Reviewer shown (2026-11-20). The Reviewer has no panel, so showing it to guests gives them nothing.

Why it is so today (design-web.md §5.4): main keeps one `pageReady` flag and one outbox per overlay, `post` goes to the
holder view only, and plugins treat the page as one (the Reviewer posts `init` once and each page posts its whole
draft). So one view holds the page and the others show "Open on <device>" with Take over; guests are kept out of
holding (`overlays.take`, `.message`, `.ready`, `.loaded` are guest `no`).

The page's URL is not the obstacle: a plugin-file overlay loads from `/p/<token>/`, which a guest already has for every
plugin shown to it. The obstacles are the single holder and an overlay API that cannot tell views apart.

## 2. Idea

Make an html overlay work like a panel for plugins that say they can: **every view that shows the overlay loads its own
copy of the page**, each copy on its own line, and the plugin hears who sent each message and can answer one view or
all. Panels already work this way (`ctx.panels.onMessage(panelId, (m, { view, access }))`, `post(..., { view })`,
`ctx.views`), so the plugin side is a pattern plugin authors know.

Opt-in per plugin, because a plugin written for one page breaks with two (Reviewer: `init` once, whole-draft saves):

```json
"overlays": { "perView": true }
```

An older app ignores the key (unknown top-level keys are tolerated). A plugin without it keeps today's behaviour:
one holder, Take over among the owner's views, and a guest sees the note (reworded, §6).

## 3. Plugin API (additive)

On `OverlayHandle` (`src/sdk/types.ts`), for a `perView` plugin:

- `onMessage(listener: (message, from: ViewFrom) => void)`: `from.view` (`'desktop'` or `web:<n>`) and `from.access`
  (`'owner' | 'read' | 'write'`), filled by main from the connection it bound, never from the page.
- `post(message, { view? })`: no `view` = every copy; `{ view }` = that copy only.
- `onConnect(listener: (from: ViewFrom) => void)`: a copy is up (the per-view `init` point; a reload of one view
  connects again). `onDisconnect` when a copy goes (view closed, overlay hidden there, guest kicked).
- `onButton(id, listener(from))`, `onDiscuss(listener(from))`: which view pressed it, so the plugin answers from that
  copy (the Reviewer takes the draft of the view that pressed Discuss).

Non-`perView` plugins keep the current signatures' behaviour (the extra argument is simply present; no copy but the
holder exists).

## 4. Main

- `OverlayManager` keeps, per overlay, a map view → `{ pageReady, outbox }` instead of one holder for `perView`
  overlays; `post` with no view fans out to every ready copy (each outbox bounded as today: 100 messages / 8 MiB per
  copy, a copy over it is reloaded, not the others).
- Which views get a copy: every live view of the window that can see the overlay. Owner views always (see D-1), never
  server mode's hidden page (it never holds a page today either); a guest view when `overlayVisible` and the plugin's
  guest port is not `none`.
- **Service-opened overlays (the `via` rule).** Today an overlay's origin plugin is the plugin whose host call opened it
  (`overlay-manager.ts:629`). When Gmail or Inbox opens a mail through the `reviewer` service, that is the Reviewer, so
  a guest shown the Reviewer but not Gmail already gets the overlay's title (the mail subject) in 0.24.0, and with
  copies would get the mail. Fix: the plugin host records the service caller chain of the call frame that opened the
  overlay (`ctx.services` already tracks the consumer per call, `caller`), main stores it as `origin.via` (never from
  the plugin's arguments), and `overlayVisible` requires the opener **and every plugin in `via`** to be visible to the
  guest. An overlay opened from a timer or later than the call frame has no `via` and stays as today. This also fixes
  the title leak for non-`perView` overlays.
- Guest rows (`shared/guest-class.ts`, `main/web/guest-events.ts`): `overlays.ready`, `.loaded`, `.message` become
  `read` with the overlay target for `perView` overlays only (the handler refuses a non-`perView` overlay to a guest,
  so the class can widen without widening old plugins); `overlays.message` events pass to a guest only for its own
  copy; `overlays.take` stays `no`. `overlays.close` stays `write` for guests: a write guest's ✕ closes the overlay for
  everyone, as today (D-2). A read guest's ✕ hides that guest's copy only, through a new guest `read` channel
  `overlays.hide` (per-view state, dropped when the overlay ends; the read guest can reopen nothing, the next open
  shows again).
  This reverses design-guests.md's "a guest never holds an html overlay" (§16.3, the `overlays.*` row, DECIDED HERE)
  for `perView` overlays; that doc gets amended with a pointer here.
- Read guests: like panels (D-17), a read guest of a plugin that is not `guests.aware` gets a one-way copy (it sees the
  page, its messages are dropped); an aware plugin hears them with `access: 'read'` and must not act on them as
  writes. `{ result }` (finishing the overlay, which resolves the opener's `open`) is accepted from owner views only;
  a guest's copy that sends one is treated as that guest's ✕ (a write guest's closes it for everyone with no result,
  a read guest's hides that copy).
- A plugin listener for a guest's message runs in that guest's view (`dispatchInView`, as today for remote views), so
  `ctx.sessions.focus` and the like act on the guest's screen. That dispatch is an origin-view hint with a 10 s cap,
  and main's checks never rest on it, so a plugin must decide by `from.access` / `from.view` (main's own ids), not by
  where its listener happens to run. `ctx.openExternal` for a guest's message must open on the guest's device or be
  refused, never on the owner's machine: the plan checks the current path and fixes it in core if needed.
- Inline overlays (`ccc overlay --html`, no plugin): unchanged, owner-only (no plugin to declare `perView`, and the
  `ccc` caller waits for one result).

## 5. The Reviewer

Declares `perView` and `guests.aware` (without `aware` a read guest's copy is one-way, and the page starts the
`content` handshake itself, so it would stay blank). Per copy: `init` on `onConnect` with the current draft, layout and
sides; the `content` handshake per view. The draft becomes shared state the host owns (D-3): a page sends note edits
(add, change, delete by note id) instead of the whole draft; the host applies them, saves, and posts the change to
every copy. Each note records who wrote it (owner or the guest's name). The overall comment (`global`) is one text,
last writer wins. Discuss takes the host's draft (the same for every copy) and is still write guests only.

What the host does with each page message, by `from.access` (the host decides, never the page):

| Page message | Owner | Write guest | Read guest |
|---|---|---|---|
| note edits, `global`, `draft-unsaved` | applied, saved, sent to all copies | same (D-3) | dropped |
| `layout`, `split` (the owner's app-wide prefs in `ctx.appStorage`) | saved | that copy only, not saved | that copy only, not saved |
| `content`, `retry` (load the page's content) | yes | yes | yes |
| `view` (Original / Reader for a mail; re-emitted on the service, where the consumer sees no `from`) | re-emitted | that copy only, not re-emitted | that copy only |
| `action` (a consumer's button: Gmail archive, Inbox Done; re-emitted on the service) | re-emitted | dropped (the consumer cannot tell who pressed; the button is not drawn in a guest's copy) | dropped, not drawn |
| `open-url`, `open-link` | as today | on the guest's own device only (§4), else dropped | same as write |
| `close` | closes the overlay | closes the overlay for everyone (D-2) | hides that copy |

## 6. Guests of plugins that are not perView

The note says why instead of only where: "Open on <owner>'s screen. <Plugin> does not show its windows to guests."
The Plugins page, where a plugin is shown to guests, says whether its windows (overlays) are shared too.

## 7. Decisions (Oleg, 2026-11-20)

- **D-1 Owner's other devices: every screen gets a copy.** With a `perView` plugin the owner's own views (desktop and
  browsers) each show their own live copy too; no Take over for that overlay. Take over stays for older plugins.
- **D-2 A guest's ✕: write guests close it for all.** A write guest's ✕ closes the overlay for everyone, the owner
  included; a read guest's ✕ hides only that guest's copy.
- **D-3 Reviewer notes: shared, write guests edit too.** Owner and write guests add and edit notes live, merged per
  note, each note with its author; read guests see them and cannot edit. Discuss sends the one shared set.

## 8. Not in this change

Inline overlays for guests; terminal overlays (already shown to guests by origin); a live cursor or presence inside an
overlay; `perView` for the hello example beyond a demo.
