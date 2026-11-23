'use strict'
// Where a drop of device files on the Files panel goes, and which drags the page takes
// (design-upload §5.1). Split out of the page so node:test checks the rules with no page
// (test/drop.test.js). A classic <script src="../dist/lib/drop.js"> sets the global `ccFilesDrop`.
;(function (root) {
  /**
   * The project-relative folder a drop over `row` goes to: a folder row itself, a file row's folder,
   * else ('' when `row` is null: the list's empty space) the project folder. `row` is the page's
   * `{ rel, kind }`; `rel` is the tree's own `a/b` path, so the last `/` splits it whatever the names
   * hold (spaces, unicode).
   */
  function dropFolder(row) {
    if (!row) return ''
    if (row.kind === 'dir') return row.rel
    const i = row.rel.lastIndexOf('/')
    return i < 0 ? '' : row.rel.slice(0, i)
  }

  /**
   * A drag the page takes: it carries device files (`types` has 'Files'), the app has the upload API
   * (`upload`: `typeof ccPanel.upload?.files === 'function'`, so an older app never takes a drag it
   * could not finish) and the viewer may write (`access` is not 'read'; the host refuses by main's
   * word anyway). Any other drag is left to the SDK, which cancels a Files drag.
   */
  function takesDrag({ types, upload = false, access = 'owner' }) {
    return upload === true && access !== 'read' && Array.from(types || []).includes('Files')
  }

  const api = Object.freeze({ dropFolder, takesDrag })
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ccFilesDrop = api
})(typeof globalThis === 'object' ? globalThis : this)
