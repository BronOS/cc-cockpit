'use strict'
// The page's side of a preview transfer (src/page/bytes.mjs) against what the host sends (review.previewChunks).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const review = require('../dist/lib/review')

const load = () => import(path.join(__dirname, '../src/page/bytes.mjs'))

function run(startBytes, msgs) {
  const t = startBytes(msgs[0])
  if (t.error) return t
  for (const m of msgs.slice(1, -1)) {
    const err = t.add(m)
    if (err) return { error: err }
  }
  return t.end()
}

test('a transfer from the host joins back to the bytes', async () => {
  const { startBytes } = await load()
  const bytes = Buffer.from(Array.from({ length: 2 * 999 + 7 }, (_, i) => i % 256))
  const r = run(startBytes, review.previewChunks('image', 'image/png', bytes, 999))
  assert.equal(r.error, undefined)
  assert.deepEqual(Buffer.from(r.b64, 'base64'), bytes)
  assert.deepEqual([r.kind, r.mime, r.size], ['image', 'image/png', bytes.length])
  // An empty file is a valid (empty) image transfer.
  assert.equal(run(startBytes, review.previewChunks('image', 'image/gif', Buffer.alloc(0))).b64, '')
})

test('out of order, missing, extra, padded inside, not base64, size mismatch: refused', async () => {
  const { startBytes } = await load()
  const bytes = Buffer.alloc(3000, 1)
  const ok = review.previewChunks('pdf', 'application/pdf', bytes, 999)
  const [begin, c0, c1, c2, c3, end] = ok
  assert.equal(ok.length, 6)
  assert.match(run(startBytes, [begin, c1, c0, c2, c3, end]).error, /out of order/)
  assert.match(run(startBytes, [begin, c0, c1, c2, end]).error, /missing/)
  assert.match(run(startBytes, [{ ...begin, chunks: 3 }, c0, c1, c2, c3, end]).error, /more chunks|more bytes/)
  assert.match(run(startBytes, [begin, { ...c0, b64: 'QQ==' }, c1, c2, c3, end]).error, /padding/)
  assert.match(run(startBytes, [begin, { ...c0, b64: '****' }, c1, c2, c3, end]).error, /not base64/)
  assert.match(run(startBytes, [{ ...begin, size: 2000 }, c0, c1, c2, c3, end]).error, /more bytes than announced/)
  assert.match(run(startBytes, [{ ...begin, size: 4000 }, c0, c1, c2, c3, end]).error, /size does not match/)
  // After a failure, later chunks change nothing.
  const t = startBytes(begin)
  t.add(c1)
  assert.match(t.add(c0), /out of order/)
  assert.match(t.end().error, /out of order/)
})

test('the page caps and types: over the cap, an unknown kind or type is refused at begin', async () => {
  const { startBytes, PAGE_CAPS } = await load()
  assert.match(startBytes({ kind: 'image', mime: 'image/png', size: PAGE_CAPS.image + 1, chunks: 1 }).error, /too large/)
  assert.equal(startBytes({ kind: 'pdf', mime: 'application/pdf', size: PAGE_CAPS.image + 1, chunks: 20 }).error, undefined)
  assert.match(startBytes({ kind: 'pdf', mime: 'application/pdf', size: PAGE_CAPS.pdf + 1, chunks: 50 }).error, /too large/)
  assert.match(startBytes({ kind: 'image', mime: 'text/html', size: 1, chunks: 1 }).error, /unsupported type/)
  assert.match(startBytes({ kind: 'image', mime: 'application/pdf', size: 1, chunks: 1 }).error, /unsupported type/)
  assert.match(startBytes({ kind: 'video', mime: 'video/mp4', size: 1, chunks: 1 }).error, /unknown preview kind/)
  assert.match(startBytes({ kind: 'image', mime: 'image/png', size: 1, chunks: 0 }).error, /bad chunk count/)
  assert.match(startBytes(null).error, /unknown preview kind/)
})

test('formatSize', async () => {
  const { formatSize, b64Bytes } = await load()
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(3482), '3.4 KiB')
  assert.equal(formatSize(12 * 1024 * 1024), '12.0 MiB')
  assert.deepEqual(['', 'QQ==', 'QUI=', 'QUJD'].map(b64Bytes), [0, 1, 2, 3])
})
