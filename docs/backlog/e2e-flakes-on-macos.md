---
worth: yes
where: src/main/plugins/validate.ts:105
added: 2026-11-19
---
# what is left of the macOS e2e flakes after the 2026-11-20 pass

The 2026-11-20 pass (branch `backlog/e2e-flakes-2`) fixed the lsp-host initialize flake (the kill at 150 ms could
land before node ran the fake's first line, so its `.starts` file said 0; reproduced with a 5 ms timeout, the test
now counts the host's spawns), closed the frame-focus blind spot (a `pointerout` counts only with `relatedTarget`
null, a `pointerup` counts; measured: a re-layout under a pointer resting in a cross-site frame reports the last
position the shell saw), and made split-plugin's column check compute its count from the geometry main judged by. `marketplace-revoked.spec.ts`
already ran its server-mode half on macOS (only win32 returns early). Left open:

- **A bundled plugin is refused at start, about 1 start in 110.** Main logs `plugin cockpit.editor disabled: invalid
  plugin: plugin.json: is not a file`. Not reproduced in 699 bare starts on 2026-11-20 (399 on an idle
  Mac, 300 beside spec runs, screen locked). The refusal now says which check answered and what it saw, in the logged reason and in `plugins.json`'s state: `(stat saw mode 0o…)` from resolveInside,
  `(open failed: <code> (errno n))` from the verified open, or `(fstat on fd N saw mode 0o…, inode d:i (the check saw
  d:i))`. An fstat on another inode than the check saw, with a FIFO or socket mode, would mean a descriptor closed
  twice elsewhere in main and reused under the read. Next time it shows, read the reason in the run's `plugins.json`
  or main's stderr. A loop for it: a spec that calls `launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })`, polls
  `hostStatus` for the six bundled ids for 15 s and records `plugins.json`, run with `--repeat-each`.
- **macOS `win.blur()` moves the page's focus.** In the desktop page, `BrowserWindow.blur()` moved DOM focus from the
  terminal's textarea to the top strip's `Open project…` button, and `focus()` did not put it back (seen 2026-11-19).
  Not settled: on 2026-11-20 the screen was locked, no window could become key (`isFocused()` false throughout), and
  neither `win.blur()` nor the real paths moved anything. Electron's `blur()` on macOS orders the window out and back
  (`orderOut` + `orderBack`); a Cmd+Tab only takes key status and leaves the window and its first responder in place,
  so it is probably not the same, but that is reasoning. To settle it on an unlocked Mac with the app frontmost: one
  spec that checks, with `win.isFocused()` true before and false after each leave (Playwright's focus emulation keeps
  `document.hasFocus()` true, so it proves nothing), where `document.activeElement` is after another window of the
  app takes key and gives it back, after `app.hide()` / `app.show()`, after minimize / restore, and, as the control,
  after `win.blur()` / `win.focus()` (which must still move it to the button). If a real path moves it, restore the
  terminal's focus on the window's focus when the page's focus went to the strip with no press or key, without a
  gesture (a gesture focus takes the terminal size) and from nothing a page can trigger.
- **editor-split.spec.ts:274, the second click on a blurred frame.** "the shell decides which frame has the keys"
  fails about 1 run in 4 to 8 on this Mac at `focusedPanes ... toHaveAttribute('data-focused-pane', file)`, with the
  2026-11-20 rule and with the one before it alike (old rule 2 of 8, new 1 of 8 plus 1 of 3). Logged: the press is
  routed into the frame although it lets the pointer through (`pointer-events: none`), so the window blurs; only the
  release reaches the shell's pane (`pointerout`, `pointerover`, `pointerup`), and that release is the only evidence.
  The check runs a task after the blur, and Playwright's `mouse.up` is a separate call, so the check can run before the
  release is seen and refuse. Either the press should reach the pane (why the browser still routes it to the frame), or
  the check at a blur should wait for a press that is still down to end before it decides.
