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

- Same-site (same-process) iframes: a `<select>` inside one is still keyboard-only (`hitScript`'s `elementFromPoint`
  stops at the frame element, and the router's route for that press is the top document's), and text selected inside
  one is not copied (`SELECTION_SCRIPT` reads the top document's own selection). Doing it: descend same-origin
  `contentDocument`s in the two scripts, the point mapped through the frame element's box (its border, padding and
  transform) for the hit test.
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
