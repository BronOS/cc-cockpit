---
worth: yes
where: src/main/sessions/session-registry.ts:518
added: 2026-11-19
---
# keep the computer awake while a Claude session is working

Oleg's request (2026-11-19): the computer must not go to sleep while any Claude tab is working, on macOS, Linux and
Windows. It is a setting, on by default.

Shape: main subscribes to the session registry (`onChange`) and holds one Electron
`powerSaveBlocker.start('prevent-app-suspension')` while at least one tab of any window is `working` (decide whether
`needs-permission` counts: a prompt waiting for an answer is not work, but a long turn paused on it may want the machine
up), and stops it when the last one leaves `working`. A short release delay (a turn's gaps between tools) avoids churn.
`prevent-app-suspension` keeps the system from idle sleep and lets the display sleep; it does not stop a lid close or a
manual Sleep (say so in the docs).

- `powerSaveBlocker` goes behind an adapter like the other Electron-only modules (`main/power/electron-power.ts`, a fake
  in tests; a grep test that nothing else imports it), with the logic in a plain module.
- An app-wide core setting (Settings, General: "Keep the computer awake while Claude is working", default on), in
  `app.json`; a remote view may not change it if the setting's channel would widen anything (`REMOTE_CLASS`).
- Server mode on macOS holds its own blocker for the whole run (`docs/plans/20261119-server-mode-mac.md`, decision 4);
  the two must not release each other's (separate ids, or one owner that keeps a count).
- Per platform, what Electron does: macOS an IOPM assertion (`pmset -g assertions` shows it), Windows
  `SetThreadExecutionState`, Linux the session bus inhibitor (logind or the desktop's screensaver service; on a
  headless server with no session bus it may do nothing: check and say so).
- Tests: the logic with a fake blocker (start on the first `working`, one blocker for several tabs, stop after the
  delay, setting off releases at once, setting on with a working tab starts at once); docs in `docs/features.md`.
