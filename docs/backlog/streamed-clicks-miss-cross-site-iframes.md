---
worth: yes
where: src/main/webview/electron-offscreen-webview.ts
added: 2026-11-19
---
# streamed pages: clicks and keys may never reach a cross-site iframe

Found while proving the off-screen cross-site frame hardening (2026-11-19, `scripts/offscreen-frames-check.mjs`): on
this Mac, `webContents.sendInputEvent`, which the off-screen view's `sendInput` uses for a browser's clicks and keys,
never reaches an out-of-process (cross-site) iframe; the top document gets the event with the iframe element as its
target. So in server mode's streamed Browser panel (and any streamed webview panel), a click into an embedded
cross-site frame (a video player, a sign-in widget, a payment form, a comment box) may do nothing.

Unknown: whether Linux (where server mode streams today) behaves the same; check there first with the same script.
If it does, the likely fix is to dispatch input through the DevTools protocol (`Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent` on the page's session, which Chromium routes to the frame under the point) instead of
`sendInputEvent`, keeping the input lane's order (`webview-input.ts`) and the clipboard-chord rule (never forwarded).
The macOS server mode plan's T4 (`docs/plans/20261119-server-mode-mac.md`) already moves the edit chords to
`Input.dispatchKeyEvent`; do the two together.
