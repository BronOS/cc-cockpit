---
worth: yes
where: src/main/webview/electron-offscreen-webview.ts
added: 2026-11-19
---
# streamed pages: clicks and keys never reach a cross-site iframe

Found while proving the off-screen cross-site frame hardening (2026-11-19, `scripts/offscreen-frames-check.mjs`): on
this Mac, `webContents.sendInputEvent`, which the off-screen view's `sendInput` uses for a browser's clicks and keys,
never reaches an out-of-process (cross-site) iframe; the top document gets the event with the iframe element as its
target. So in server mode's streamed Browser panel (and any streamed webview panel), a click into an embedded
cross-site frame (a video player, a sign-in widget, a payment form, a comment box) does nothing.

The DevTools-protocol fix this item first proposed does not work (T4 of `docs/plans/20261119-server-mode-mac.md`,
`scripts/offscreen-input-check.mjs`, macOS, Electron 45.1.0, GPU off and on alike):
- `Input.dispatchMouseEvent` on the **page's** session misses the iframe exactly as `sendInputEvent` does: no click,
  drag, wheel or hover cursor arrives there (all of them work in the top document).
- `Input.dispatchKeyEvent` and `Input.insertText` on the page's session **do** follow focus into the iframe, while
  `sendInputEvent` keys do not. Focus gets in by Tab (a `sendInputEvent` Tab from the top document moves it into the
  iframe's field); after that a plain key typed from a browser lands on the top document's body and is lost, while an
  edit chord (Ctrl/Cmd+A, Z, Shift+Z, Ctrl+Y: T4 sends them on the page's session) and committed text land in the
  iframe's field. Mixed today: keys typed into an iframe field reached by Tab are lost, chords and non-ASCII text work.
- The same commands on the **iframe's own** session (the auto-attached child target `webview-hardening.ts` already
  holds), with the point in the iframe's own coordinates, reach it fully: click, keys, text, select all, drag, wheel,
  the hand cursor.

So a fix is a router of main's own, a design decision for the lead: keys and text on the page's session (they follow
focus; cheap, and closes the Tab case), and pointer events to the session of the frame under the point, which main
would have to find (frame owner boxes through nested frames, scroll, transforms and clipping; pointer capture during a
drag that leaves the frame; the select hit-test and the selection read are top-document only too, `select-hit.ts` and
`SELECTION_SCRIPT`). Keep the lane's order (`webview-input.ts`) and the clipboard-chord rule (never forwarded).

Unknown: whether Linux behaves the same; run `node scripts/offscreen-input-check.mjs` there (it exits 0 on the top
document and prints each road's iframe row).
