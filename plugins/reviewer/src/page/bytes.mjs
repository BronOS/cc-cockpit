// A preview's bytes (an image, a PDF) as the host streams them after the page asks ({ type:
// 'content' }; host.js openPreview, review.previewChunks): `bytes-begin` { kind, mime, size, chunks },
// `bytes` { seq, b64 } in order, `bytes-end`. The page checks them against the begin message and
// against its own caps (the host's are the same, but the page does not count on that), and keeps
// the joined base64: every chunk but the last is a multiple of 3 bytes, so the strings join as is.
//
// Pure, so test/bytes.test.js runs it under node.

export const PAGE_CAPS = { image: 10 * 1024 * 1024, pdf: 25 * 1024 * 1024 }

// The types the page shows itself; anything else from the host is refused.
const MIMES = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
  pdf: new Set(['application/pdf']),
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The byte count of a base64 string (padding aware). */
export function b64Bytes(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - pad
}

/**
 * A collector for one transfer, or { error } when the begin message is not one the page takes.
 * collector.add(m) takes a `bytes` message and returns null or an error string; collector.end()
 * returns { b64, mime, kind, size } or { error }.
 */
export function startBytes(begin) {
  const kind = begin && begin.kind
  if (kind !== 'image' && kind !== 'pdf') return { error: 'unknown preview kind' }
  if (!MIMES[kind].has(begin.mime)) return { error: `unsupported type: ${String(begin.mime).slice(0, 60)}` }
  const size = begin.size
  const chunks = begin.chunks
  if (!Number.isInteger(size) || size < 0) return { error: 'bad size' }
  if (size > PAGE_CAPS[kind]) return { error: `too large: over ${PAGE_CAPS[kind] / 1024 / 1024} MiB` }
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > 1000) return { error: 'bad chunk count' }
  const parts = []
  let total = 0
  let failed = null
  const fail = (why) => (failed = failed || why)
  return {
    kind,
    mime: begin.mime,
    add(m) {
      if (failed) return failed
      if (!m || m.seq !== parts.length) return fail('chunks out of order')
      if (parts.length >= chunks) return fail('more chunks than announced')
      const b64 = m.b64
      if (typeof b64 !== 'string' || b64.length % 4 !== 0 || !B64.test(b64)) return fail('a chunk is not base64')
      // Only the last chunk may be padded: the strings are joined as they are.
      if (b64.includes('=') && parts.length !== chunks - 1) return fail('padding inside the data')
      total += b64Bytes(b64)
      if (total > size || total > PAGE_CAPS[kind]) return fail('more bytes than announced')
      parts.push(b64)
      return null
    },
    end() {
      if (failed) return { error: failed }
      if (parts.length !== chunks) return { error: 'chunks missing' }
      if (total !== size) return { error: 'size does not match' }
      return { kind, mime: begin.mime, size, b64: parts.join('') }
    },
  }
}

/** A human size: 512 B, 3.4 KiB, 12.0 MiB. */
export function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}
