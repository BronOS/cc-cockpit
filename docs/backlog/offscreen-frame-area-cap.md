---
worth: later
where: src/main/webview/electron-offscreen-webview.ts:129
added: 2026-11-12
---
# off-screen pages: no frame area cap or frame-rate budget for huge animating pages

An off-screen page paints at a fixed `OFFSCREEN_FRAME_RATE` at whatever size its owner browser asked for
(clamped per view), and every paint is JPEG-encoded for its viewers. A large page that animates all over
(a canvas game, a video) at a big size costs main and the encoder steadily, multiplied by the pages open
(4 per project, 12 per app). The bench (`scripts/web-terminal-bench.mjs`) covers 1920x1080 for one page.
Found in the security review of the streamed webviews (server mode).

Suggested fix: a total painted-area budget across live off-screen pages; past it, lower
`wc.setFrameRate` for the largest or least recently used ones (or cap the area per page), and restore it
when under budget. Unknown that settles the value: whether a real server with several such pages open
stalls main or the terminals in practice; measure with the bench at 4-12 animated pages first.
