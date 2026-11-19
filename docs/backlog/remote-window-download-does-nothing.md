---
worth: yes
where: src/main/remote/electron-remote-window.ts:447
added: 2026-11-19
---
# download in a remote window: verify the fix on a packaged Mac

Reported by Oleg (packaged 0.23.0 on macOS, Direct link to `http://10.0.20.115:7330`): Files › Download in the remote
window showed nothing and saved nothing, while the server sent the file.

Cause found and fixed: the click gate heard clicks through `input-event`, which sees the main frame's widget only. The
Files panel is a sandboxed plugin frame that Electron 45 runs out of process (checked: own pid, a DevTools click there
fires no `input-event` but does fire `before-mouse-event`), so every Download from a panel was refused as "no click".
The e2e passed only on its earlier main-frame click on the Files button. Now `before-mouse-event` feeds the download
click (`downloadClick`), every save and refusal is a log line and a notice in the window's page as well as the native
one, and a notification that fails is logged.

Still unverified (needs a real pointer on a packaged, ad-hoc signed build):
- the save itself on macOS: ~/Downloads access (TCC prompt, or a denial, which shows as "the download was interrupted"),
  the hard link into ~/Downloads;
- whether native notices show at all for the ad-hoc signed app (`a notification did not show: <error>` in the log says
  they do not).

Check: run `/Applications/cc-cockpit.app/Contents/MacOS/cc-cockpit` from Terminal (a Finder launch keeps no main log),
Download a file, and read the `remote <id>: ...download...` lines: `saving a download as`, then `saved a download as` or
`a download was not saved: <why>`, or `cancelled a download: <why>`. No line at all means `will-download` never fired.
Close this item when a Download lands in ~/Downloads with the in-window notice.
