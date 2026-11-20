---
worth: yes
where: src/main/webview/webview-hardening.ts:114
added: 2026-11-20
---
# off-screen pages: a page stuck in a script loop can never be reloaded or navigated

In server mode a streamed page (`OffscreenWebviewFactory`) whose script spins forever (`while (true) {}`) stays stuck:
a reload or a cross-site navigation fires `did-start-navigation` and then nothing, for as long as it was watched
(45 s): no `did-navigate`, no `unresponsive`, no `render-process-gone`, no debugger `detach`, the same renderer pid
throughout. The old renderer has to run its unload before the navigation commits, and it never yields. The panel
keeps showing the frozen page and takes no input; only closing the panel ends it. A desktop Chrome would offer
"Page unresponsive: Exit page"; nobody is at the server's screen and Electron raises no event off-screen.

Seen in real Electron 45 on macOS by the hung-page case of `scripts/offscreen-input-check.mjs` (router branch
`server-mac/iframe-input`, 2026-11-19), which reports (a) reload and (b) cross-site navigation as this known
limitation. Case (c), `forcefullyCrashRenderer()` then reload, works: the new renderer commits, and the input router's
full reset on renderer gone (ruling #11) lets typing reach it in about 100 ms. So the likely fix is a watchdog in main:
a navigation the person started (reload, address bar, back) that has not committed within a few seconds while the page
answers no probe gets `forcefullyCrashRenderer()` and is retried, with a notice to the viewer. Not caused by the
router (a navigation never goes through it), though only the router branch's script was run, not master.
