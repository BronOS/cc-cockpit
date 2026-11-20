---
worth: later
where: src/main/webview/page-input.ts
added: 2026-11-20
---
# streamed pages: the input router's known leftovers

The router (`PageInputRouter`, merged 2026-11-20) was reviewed against its contract (`docs/design-web-browser.md` §4.1)
by four codex merge-bar passes and a seeded fuzz in which every external await can hang (50,000 seeds pass). The hunt
was stopped after the fourth pass, by a rule set beforehand: only input into the wrong frame, across a reconnect, out of
order, or growing without bound blocked the merge. These were found and left:

- A parked pointer step is put back with an unconditional `unshift`, so the queue can hold 513 steps (cap + 1) with no
  press record (codex pass 4). Bounded; admission could count the step in flight.
- A late call's warning shares the `stalled` warn key (6a5912a), so it can hide the page-stall warning. A log line only.
- After a reset, the step that was running keeps waiting on its stale command until that command's deadline (up to
  500 ms) before new input runs.
- A delivery, query or call hung forever on a live renderer that neither answers nor goes away parks what follows it,
  capped at 512 (accepted in the contract). The page itself cannot be reloaded then either:
  `docs/backlog/offscreen-hung-page-cannot-reload.md`.
- A key or button can stay down after a reconnect in the middle of a click, or when the page refuses a key-up.
- Accepted as browser behaviour, not defects: a page that covers or moves a frame while a hit test is in flight gets
  the event where the viewer's picture showed the frame; keys follow the page's own focus into another frame.

The value call is open: none has a user-visible symptom seen so far; one that shows up in real use settles it.
