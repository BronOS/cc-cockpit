'use strict'
// Splitting a child's byte stream into items (rg's NUL-separated paths and JSON lines, claude's
// stream-json lines): one splitter for search.js and quick-chat.js.

/**
 * Splits a byte stream on `sep` (0 or 10), across chunks. `onItem(bytes)` per complete item;
 * an item over `maxBytes` is dropped whole (its rest is skipped up to the next separator).
 */
function splitter(sep, onItem, maxBytes = Infinity) {
  let held = []
  let heldBytes = 0
  let skipping = false
  return {
    push(chunk) {
      let start = 0
      for (let i = chunk.indexOf(sep); i !== -1; i = chunk.indexOf(sep, start)) {
        const piece = chunk.subarray(start, i)
        if (!skipping) {
          const item = held.length ? Buffer.concat([...held, piece]) : Buffer.from(piece)
          if (item.length <= maxBytes) onItem(item)
        }
        held = []
        heldBytes = 0
        skipping = false
        start = i + 1
      }
      if (start < chunk.length && !skipping) {
        const rest = chunk.subarray(start)
        heldBytes += rest.length
        if (heldBytes > maxBytes) {
          held = []
          heldBytes = 0
          skipping = true
        } else held.push(Buffer.from(rest))
      }
    },
    /** The last item, when the stream did not end with a separator. */
    end() {
      if (!skipping && held.length) onItem(Buffer.concat(held))
      held = []
      heldBytes = 0
    },
  }
}

module.exports = { splitter }
