---
worth: yes
where: src/main/webview/webview-input.ts
added: 2026-11-19
---
# streamed pages on a macOS server: Cmd+arrows and Cmd+Backspace do nothing in a text field

T4 of `docs/plans/20261119-server-mode-mac.md` probed the editing keys a browser sends into a streamed page's text
field on a macOS server (`scripts/offscreen-input-check.mjs`, Electron 45.1.0, 2026-11-19). Backspace, Delete, the
arrows, Shift+arrows, Home, End, Option+Left/Right (word) and Option+Backspace (word) work. These do nothing:

- Cmd+Left and Cmd+Right (line start and end): the caret stays;
- Cmd+Shift+Left (select to line start): nothing selected;
- Cmd+Backspace (delete to line start): nothing deleted.

Same cause as the edit chords T4 fixed: on macOS Chromium takes them from the responder chain (`moveToBeginningOfLine:`,
`deleteToBeginningOfLine:`), which an off-screen page has not, so a `sendInputEvent` key down runs nothing. Likely fix:
the same road as `editCommandOf` (`shared/webview-keys.ts`), the key down as `Input.dispatchKeyEvent` with `commands`
(`moveToBeginningOfLine`, `moveToEndOfLine`, the `AndModifySelection` forms, `deleteToBeginningOfLine`), on every server
since the browser's OS is not the server's. Not probed yet: Cmd+Up/Down (document start and end), Ctrl+A/E/K (Emacs
keys in a Mac field), Cmd+Shift+Right. A Linux server may run some of them itself (blink's own key bindings), so check a
doubled action there before sending a command on every server.
