---
worth: now
where: src/main/server-mode.ts:62
added: 2026-11-19
---
# server mode on macOS (and its e2e specs on the dev Mac)

Development moved from the Linux VM to a Mac, where server mode and every spec built on it are skipped
(`server-mode`, `server-download`, `server-secrets`, `server-webview`, `remote-desktop`, parts of `rooms-view`
and `editor-split-web`; `test.skip(process.platform !== 'linux')`), and CI runs no e2e. So nothing exercises
server mode end to end any more. `decideServerMode` refuses off Linux because server mode renders through
Chromium's headless Ozone platform (`--ozone-platform=headless`), which exists only on Linux, and starts by
re-executing the image with those switches. Found in the guest-invite team run's spec review (decision D-28 there):
its server-mode half (`ccc web invite`, the server rules for guests) is covered by unit tests only.

Oleg's decision (2026-11-19): a real macOS feature (a headless cockpit on a Mac, reached from browsers), its own design
session, built alongside the guest-invite run, whose server-mode guest e2e waits for it. A feasibility spike
(guest-invite run, dev-alice, `spike/server-mode-darwin`) sizes it. Questions: what
replaces Ozone headless on macOS (hidden `BrowserWindow`s, off-screen rendering, which already streams webviews),
the re-exec and `--server-parent` path, the key-file secret store vs the keychain, `serverDialogs` (no SIGTRAP on
macOS?), launchd instead of systemd, and whether the e2e harness's `launchServer` can then run on darwin.

## Spike result (2026-11-19, dev-alice, guest-invite run)

Branch `spike/server-mode-darwin` (d9e2019, local, not pushed); full report
`~/Projects/team-runs/001-guest-invite/spike-server-mac.md`. With a test-run-only gate in `decideServerMode`
(darwin + `--server` + `isTestRun`, no re-exec, no Ozone switch) and one guard (`losingLaunchAsks`, second-launch.ts:92),
40 of 41 server e2e tests pass on macOS (6 test-only fixes: Mac chords, a goto race, an Ozone argv assertion). The one
failure is a product gap: edit chords (Cmd+A, Z, Shift+Z) in streamed pages do nothing on macOS (map them to
`webContents.selectAll/undo/redo`). What a real macOS server mode needs: `show: false` and no Dock icon for server
windows (the hidden page is a visible window today), `--server` run as a launchd LaunchAgent (a LaunchDaemon before
login is unknown, its own spike), `powerSaveBlocker('prevent-app-suspension')` plus a sleep/lid docs line, the key file
(works), a decision on one bundle running as desktop and server at once (LaunchServices routes to the running
instance), the edit chords. Size: about 1 day to enable the tests, 3-5 days for the real feature after a short design
session (LaunchAgent vs LaunchDaemon, the one-bundle question). The guest-invite run's server-mode guest e2e waits for it.
