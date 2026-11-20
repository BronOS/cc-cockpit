---
worth: yes
where: src/main/webview/page-input.ts
added: 2026-11-19
---
# streamed pages: what the input router still misses in embedded frames

Pointer events, keys and text reach cross-site (out-of-process) iframes of a streamed page, and so do `<select>` popups
and copy: main runs its select hit test, the choice and the selection read in the frame the router picks (the press's
own route; the deepest focused cross-site frame for copy) through an isolated world made on that frame's DevTools
session (`main/webview/page-input.ts` `scriptAt` / `scriptIn` / `scriptInFocus`, design-web-browser.md §4.1 and §4.4;
proven on macOS and the Linux VM, Electron 45.1.0, 2026-11-20, by `scripts/offscreen-input-check.mjs`). Left:

- Same-site but cross-origin iframes (another port or subdomain of the page's site), and sandboxed ones without
  allow-same-origin that Chromium keeps in the parent's process: a `<select>` inside one is still keyboard-only and
  its selected text is not copied. Same-origin iframes work since 2026-11-20 (`hitScript` and `SELECTION_SCRIPT` step
  through `contentDocument`, design-web-browser.md §4.4), but the isolated world reads no cross-origin document, and
  the router's route for such a press is the parent document's. Doing it: in `page-input.ts`, when a script's
  document holds the press's (or the focus's) frame element and that element's `contentDocument` is null, resolve its
  `frameId` (`DOM.describeNode`, as the focus walk does), make the world in that frame by id on the owning session
  (`Page.createIsolatedWorld { frameId }`, the `loaderId` bracket read on the same frame id), map the point through
  the frame element's content quad (`DOM.getContentQuads`, the router's three-corner rule), and bind the popup's
  `ScriptFrame` to (lane, frame id, loaderId) so the choice runs there or nowhere.
- A sandboxed iframe (allow-scripts only) that Chromium isolates in its own process (Electron 45.1.0 does on macOS
  and Linux, `scripts/offscreen-input-check.mjs` D, 2026-11-20): copy works in it on both, and on macOS its select
  gets a popup, but on the Linux VM the press goes to the page (no popup). Not looked into; the check prints it.
- A same-origin iframe under a transform other than a translation (scale, rotation, skew, 3D, `zoom`, an SVG
  ancestor): the scripts refuse it (no popup; the press goes to the page), since the DOM gives no box corners to
  invert through. The route above (`DOM.getContentQuads` on the frame element) would map it exactly.
- A frame under a perspective transform is not routed into (the router maps through three corners of its box, exact
  for translate, scale, rotate and skew only, and refuses a box that is no parallelogram): its parent takes the event,
  and a select in it gets no popup. A homography inverse would route it.
- Not checked: a frame's scroll chaining to its parent at its end, drag and drop between frames, a page zoomed by its
  own CSS `zoom`.
- Cost: no hit-test cache. A page with cross-site frames pays four protocol round trips per frame level per pointer
  event (about 0.1 ms each here); a pointer event is answered in about one frame either way (16 ms on macOS, 33 ms on
  the Linux VM). A selection read there walks the focus first (up to six round trips per level, the frame's `loaderId`
  bracket included), then four for the read in a frame; a select's hit test or choice in a frame is four.
- Copy after the focus moves mid-walk: the walk finds frame A, a page script focuses B during the remaining round
  trips, and the read takes A's selection. That is text the person really selected in A. Later; the fix would be a
  re-check of the focus after the read (codex review, 2026-11-20).
- Accepted, not a bug: a frame that navigates between the route's hit test and the script gets the hit script in its
  replacement document at the same frame-relative point. A browser does the same (a press lands in whatever document
  the frame holds) (codex review, 2026-11-20).
