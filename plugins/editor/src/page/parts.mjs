// A message too large for one port message (1 MiB cap) crosses in parts `{ part, parts, text? }`
// under one req: chunkText cuts the page's side (a save, a language server's copy of the document),
// partsCollector joins the host's (a read, a change on disk). The host has its own copy of the cut
// (dist/lib/files.js chunkText): the page bundle cannot load the host's CommonJS.

/** Text per save message, in UTF-16 units: the host's own chunk size (files.js CHUNK_CHARS), under the 1 MiB cap. */
export const CHUNK_CHARS = 128 * 1024

/** `text` in parts of at most `size` units, never splitting a surrogate pair. At least one part. */
export function chunkText(text, size = CHUNK_CHARS) {
  const parts = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + size, text.length)
    // A high surrogate at the cut would leave half a character in each part: harmless once the host
    // joins them, but no part should be broken UTF-16 on its own.
    if (end < text.length) {
      const c = text.charCodeAt(end - 1)
      // Size 1: stepping back would leave an empty part and loop forever, so take the whole pair.
      if (c >= 0xd800 && c <= 0xdbff) end = end - 1 > i ? end - 1 : end + 1
    }
    parts.push(text.slice(i, end))
    i = end
  }
  return parts.length ? parts : ['']
}

/**
 * Collects a message sent in parts ({ part, parts, text? }) under one req. `add` answers the head
 * (part 0's message) and the joined text (undefined when the parts carry none, a binary file) once
 * every part came, else null.
 */
export function partsCollector() {
  let head = null
  const texts = []
  let got = 0
  return {
    add(m) {
      const i = Number.isInteger(m.part) && m.part >= 0 ? m.part : 0
      if (i === 0 || head === null) head = m
      if (!(i in texts)) got++
      texts[i] = typeof m.text === 'string' ? m.text : undefined
      const parts = Number.isInteger(m.parts) && m.parts >= 1 ? m.parts : 1
      if (got < parts) return null
      const all = texts.length === parts && texts.every((t) => typeof t === 'string')
      return { head, text: all ? texts.join('') : undefined }
    },
  }
}
