---
worth: no
where: src/shared/webview-keys.ts
added: 2026-11-19
---
# streamed pages: a Mac field's Emacs keys, and the line keys on a Linux server

The Mac line keys are done (branch `server-mac/iframe-input`): Cmd+Left/Right, Cmd+Up/Down, each with Shift, and
Cmd+Backspace carry AppKit's command (`moveToLeftEndOfLine`, ..., `deleteToBeginningOfLine`; `editCommandOf` in
`shared/webview-keys.ts`), proven in a textarea with the caret mid-line by `scripts/offscreen-input-check.mjs` (macOS,
Electron 45.1.0, 2026-11-19). Left:

- Ctrl+E and Ctrl+K (a Mac field's end of line and delete to end of line) do nothing on a macOS server (the script
  probes them). Ctrl+A is select all and stays so (a Windows or Linux browser's Ctrl+A). Mapping Ctrl+E/K to
  `moveToEndOfParagraph` / `deleteToEndOfParagraph` on every server is a decision: from a Windows or Linux browser
  they mean something else, though Chrome and Firefox there keep both for their own search bar.
- On a Linux server (Debian VM, Electron 45.1.0, 2026-11-20, `scripts/offscreen-input-check.mjs` at ec8938d) every
  Cmd line key passes, but a Mac's Option word keys do not: Option+Left moved to 13 (a Mac's field gives 8),
  Option+Right to 0 (gives 3), Option+Backspace deleted nothing ("one two three", a Mac gives "one two "). On a Mac
  server Blink's own Mac key bindings do these; a Linux Blink has none for Alt. Mapping them to `moveWordLeft`,
  `moveWordRight`, `deleteWordBackward` needs the viewer's platform: from a Windows or Linux browser Alt+Left is
  Back. The decision is whether main may trust a viewer-reported platform for this (it only picks an edit command).

**Decided 2026-11-20 (Oleg): don't fix.** On a Linux server these keys keep the Linux meaning, and Ctrl+E / Ctrl+K stay
unmapped on every server; main does not take a viewer-reported platform for key handling. Kept so a review that finds the
same gap (the check script still probes them) does not reopen it; `docs/features.md` ("Server mode" › "The Browser
panel") states the limit.
