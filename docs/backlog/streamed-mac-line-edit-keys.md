---
worth: later
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
- A Linux server was not run. A key down carrying a command runs the command instead of Blink's own key binding, so
  no action should double, but run `node scripts/offscreen-input-check.mjs` there (its line-key and editing-key rows
  fail on a miss).
