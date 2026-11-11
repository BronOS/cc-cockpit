'use strict'
// Which items the Files panel's right-click menu has, as ids: panels/tree.js turns each into its
// label and action. Split out of the page so node:test checks the menus for each kind of row with no
// page (test/menu.test.js). A classic <script src="../dist/lib/menu.js"> sets the global `ccFilesMenu`.
//
// `remote` is the panel SDK's `ccPanel.view.remote`: the page is drawn in a web access browser
// view. There the host-only items go (Open with default app, Reveal): they act on the host's screen,
// and main refuses them from a browser view anyway (`files.reveal` / `files.openWithSystem`), so the
// flag only spares the person an item that would fail. Move to Trash and Open terminal here stay:
// main serves them to a browser view too.
;(function (root) {
  /**
   * The items for a row (`file`, `dir`) or the project folder (`root`), in order: a string id, or
   * `{ rule }` for an "Open with" rule matching the file; `'sep'` divides groups.
   * `system`: ctx.files.reveal and its siblings exist (the host's `reset` env); `shell`:
   * ctx.sessions.openShell exists; `rules`: the "Open with" rules matching a file.
   */
  function menuEntries({ kind, rules = [], system = false, shell = false, remote = false }) {
    // On the host's screen only: hidden in a browser view.
    const desktop = system && !remote
    const ids = []
    if (kind === 'file') {
      // With matching rules: one item per rule (the first is what a click does), then the project's
      // opener, so a rule never locks the Reviewer out.
      if (!rules.length) ids.push('open')
      for (const rule of rules) ids.push({ rule })
      if (rules.length) ids.push('open-viewer')
      if (desktop) ids.push('open-system')
      if (desktop) ids.push('reveal')
      ids.push('ask')
    } else {
      if (desktop) ids.push('reveal')
      if (kind === 'dir' && shell) ids.push('terminal')
      ids.push('new-file', 'new-folder')
    }
    ids.push('sep', 'copy-path')
    if (kind !== 'root') {
      ids.push('copy-relative', 'sep', 'rename')
      if (system) ids.push('trash')
    }
    return ids
  }

  const api = Object.freeze({ menuEntries })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ccFilesMenu = api
})(typeof globalThis === 'object' ? globalThis : this)
