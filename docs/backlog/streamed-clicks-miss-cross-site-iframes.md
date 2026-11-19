---
worth: maybe
where: src/main/webview/page-input.ts
added: 2026-11-19
---
# streamed pages: select popups and copy inside cross-site iframes; the input router on Linux

Clicks, keys, drags, wheel and the hover cursor reach cross-site (out-of-process) iframes of a streamed page now: main
routes each pointer event to the DevTools session of the deepest cross-site frame under the point and sends keys and
text on the page's session, which follow focus (`main/webview/page-input.ts`, design-web-browser.md §4.1; proven on
macOS, Electron 45.1.0, 2026-11-19, by `scripts/offscreen-input-check.mjs`). Left:

- The `<select>` hit-test and choice (`select-hit.ts`) and the selection read for copy (`SELECTION_SCRIPT`) run in
  the top document's isolated world only. A select inside a cross-site frame opens its popup unpainted (keyboard
  only, not checked that the keyboard works it there), and text selected inside such a frame is not copied. Doing it
  needs an isolated world per child session (`Page.createIsolatedWorld` on the frame's session, re-made after each
  navigation), the frame found by the router's hit test, and the select's rectangle mapped back to the top page.
- Linux was not run: run `node scripts/offscreen-input-check.mjs` there (it exits 1 on any miss).
- A frame under a perspective transform is not routed into (the router maps through three corners of its box, exact
  for translate, scale, rotate and skew only, and refuses a box that is no parallelogram): its parent takes the event.
  A homography inverse would route it.
- Not checked: a frame's scroll chaining to its parent at its end, drag and drop between frames, a page zoomed by its
  own CSS `zoom`.
- Cost: no hit-test cache. A page with cross-site frames pays four protocol round trips per frame level per pointer
  event (about 0.1 ms each here); a pointer event is answered in about one frame (16 ms) either way.
