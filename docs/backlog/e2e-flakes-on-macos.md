---
worth: yes
where: src/main/plugins/validate.ts:105
added: 2026-11-19
---
# what is left of the macOS e2e and unit flakes after the 2026-11-19 sweep

The sweep (branch `backlog/e2e-mac`) fixed the specs that failed on this Mac: test timing in overlay-toolbar,
overlays, sessions-panel, files-menu, rooms, guest-views and the split fixture (`newTaggedShell`), the refocus
emulation in web-access-terminal, a short screen in split-plugin, and one product hole (frame-focus: a `pointerout`
at the recorded position revived pointer evidence). Left open:

- **A bundled plugin is refused at start, about 1 start in 110.** Main logs `plugin cockpit.editor disabled: invalid
  plugin: plugin.json: is not a file`, so the plugin is missing from `hostStatus` and a spec waiting 15 s for it
  fails (seen as bundled-plugins:129 with cockpit.sessions missing, editor:379 with cockpit.editor, and in a loop of
  110 bare starts with cockpit.files and cockpit.editor). The file is a plain regular file. `readInside` returns
  `root` or `not-file` (`resolveInside`'s stat, or `openVerified`'s open or fstat: an `ENXIO`/`EOPNOTSUPP`/-102
  open maps to `not-file` too). A loop of realpath, stat, and the verified open plus fstat on the six manifests,
  18,000 times in Node and in Electron 45 as Node, never failed. Next step: log which of the three paths answered
  (and the errno) when a manifest is refused, then loop bare starts (`launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })`
  and a poll on `hostStatus`) until it shows.
- **macOS `win.blur()` moves the page's focus.** In the desktop page, `BrowserWindow.blur()` moves DOM focus from the
  terminal's textarea to the top strip's `Open project…` button, and `focus()` does not put it back. Whether a real app
  switch (Cmd+Tab) does the same was not checked; if it does, a person coming back to the desktop finds the keys on
  that button, not in the terminal.
- **The frame-focus rule's blind spot.** A `pointerout` is ignored only at the last position the shell recorded; a
  pointer resting where the shell never saw it (inside a frame) still turns a re-layout's boundary event into a move.
- **lsp-host "initialize never answered"** (`plugins/editor/test/lsp-host.test.js`, a 150 ms initialize timeout):
  seen once under load in the guest-invite run, passed in every run since; cause unknown.
- **Checks skipped off Linux, for the macOS server-mode task to restore:** `marketplace-revoked.spec.ts` returns before
  its server-mode half when the platform is not Linux; `split-plugin.spec.ts` "a column of plugin panes" checks the
  exact six-pane column only when the window got about 1000 px of height (a 14" MacBook gives 865, and five fit).
