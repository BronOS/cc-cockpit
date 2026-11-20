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
- **editor-split.spec.ts:274, the second click on a blurred frame.** "the shell decides which frame has the keys"
  failed 1 run in 4 to 8 (locked), at `focusedPanes … toHaveAttribute('data-focused-pane', file)`, with the
  2026-11-20 evidence rule and the one before it alike (old 2 of 8; new 1 of 8 and 1 of 3). Logged: the press goes
  into the frame although it lets the pointer through (`pointer-events: none`), so the window blurs; only the release
  reaches the shell's pane (`pointerout`, `pointerover`, `pointerup`), and that release is the only evidence. The
  check runs a task after the blur and Playwright's `mouse.up` is a separate call, so the check can decide before the
  release is seen, and refuse. Unknown whether it happens unlocked. Either the press should reach the pane (why the
  browser still routes it to the frame), or a check at a blur should wait for a press still down to end.
