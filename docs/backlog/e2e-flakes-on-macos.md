---
worth: yes
where: src/main/plugins/validate.ts:105
added: 2026-11-19
---
# what is left of the macOS e2e flakes after the 2026-11-20 pass

Every run of the 2026-11-20 pass (branch `backlog/e2e-flakes-2`) was made with the Mac's screen locked (since
22:03 the day before): no window could become key. What is left:

- **A bundled plugin is refused at start, about 1 start in 110.** Main logs `plugin cockpit.editor disabled:
  invalid plugin: plugin.json: is not a file`. Not reproduced in 699 bare starts (399 alone, 300 beside spec runs,
  all locked). The refusal now names the check that answered and what it saw: `(stat saw mode 0o…)` from
  resolveInside, `(open failed: <code> (errno n))` from the verified open, or `(fstat on fd N saw mode 0o…, inode
  d:i (the check saw d:i))`. An fstat on another inode than the check saw, with a FIFO or socket mode, would mean a
  descriptor closed twice elsewhere in main and reused under the read. `launchCockpit`'s `close()` prints any refused
  bundled plugin with that reason (`[e2e] bundled plugin … refused: …`) before the data dir goes, so the next
  sighting in a spec run carries it. A loop for it: a spec that calls `launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED:
  '' } })`, polls `hostStatus` for the six bundled ids for 15 s, run with `--repeat-each`; worth running unlocked.
- **macOS `win.blur()` moves the page's focus.** In the desktop page, `BrowserWindow.blur()` moved DOM focus from
  the terminal's textarea to the top strip's `Open project…` button, and `focus()` did not put it back (seen
  2026-11-19). Not measured: with the screen locked neither `win.blur()` nor the real paths moved anything. Unverified
  (from memory, not checked in Electron 45's `native_window_mac.mm`): `blur()` on macOS orders the window out and
  back, while a Cmd+Tab only takes key status and leaves the first responder in place. To settle it, unlocked and
  with the app frontmost: with `win.isFocused()` true before and false after each leave (Playwright's focus
  emulation keeps `document.hasFocus()` true, so it proves nothing), read `document.activeElement` after another
  window of the app takes key and gives it back, after `app.hide()` / `app.show()`, after minimize / restore, and,
  as the control, after `win.blur()` / `win.focus()`, which must still move it to the button. If a real path moves
  it, restore the terminal's focus on the window's focus when the page's focus went to the strip with no press or
  key, without a gesture (a gesture focus takes the terminal size) and from nothing a page can trigger.

Seen 2026-11-20 (overlays in every view release work):
- **Waits that prove nothing after a second Claude tab.** `qa-guest-edges.spec.ts:44` and `qa-guest-leak.spec.ts:66` wait
  for the FAKE-CLAUDE banner right after opening a second tab, which the first tab's pane already shows; neither types
  afterwards, so they pass, but the same pattern made `web-access-plugins.spec.ts:66` type into the wrong pane (fixed in
  b51a181 by addressing the new tab's own pane). Found by a pattern scan, not a check of every spec.
- **`folder-walk.test.ts` under load:** its `afterEach` `rmSync` hit vitest's 10 s timeout three times while an e2e run or
  another full run used the machine; it passes alone.
