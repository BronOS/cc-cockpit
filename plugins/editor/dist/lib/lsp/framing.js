'use strict'
// LSP base protocol framing (https://microsoft.github.io/language-server-protocol, "Base Protocol"):
// `Content-Length: <bytes>\r\n\r\n<JSON body>`. Content-Length counts BYTES of the UTF-8 body, which
// is why ctx.processes hands the host bytes, not text: a multi-byte character split across two
// chunks of stdout must not shift the count.
//
// The server is a program on the person's machine, not an attacker, but a broken or confused one
// (a server printing its banner on stdout, a version that logs there) must not grow the plugin
// host's memory without bound or wedge the parser: the header is capped, the body is capped, and
// anything that is not a well-formed frame is a protocol error the caller answers by stopping the
// server (a crash, with the restart backoff).

/** A header block longer than this is not LSP. */
const MAX_HEADER_BYTES = 8 * 1024
/** A body longer than this is refused: a server answering with 64 MiB of JSON is broken. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

const CRLFCRLF = Buffer.from('\r\n\r\n', 'latin1')

/** One message as the bytes to write in ONE call (ctx.processes has no backpressure: header and body together). */
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'latin1')
  return Buffer.concat([head, body])
}

/**
 * Feeds stdout chunks in, calls `onMessage(obj)` per complete frame and `onError(err)` once for a
 * malformed stream (after which it takes nothing more). Chunks are kept in a list and joined only
 * when a frame is complete, so a large body arriving in many small chunks costs one copy.
 */
class Decoder {
  constructor(onMessage, onError, { maxBody = MAX_BODY_BYTES } = {}) {
    this.onMessage = onMessage
    this.onError = onError
    this.maxBody = maxBody
    this.chunks = []
    this.size = 0
    /** The body length of the frame being read, once its header was parsed. */
    this.want = -1
    this.failed = false
  }

  push(bytes) {
    if (this.failed) return
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
    for (;;) {
      if (this.failed) return
      if (this.want < 0) {
        if (!this.readHeader()) return
      }
      if (this.size < this.want) return
      const all = this.take(this.want)
      this.want = -1
      let message
      try {
        message = JSON.parse(all.toString('utf8'))
      } catch (e) {
        return this.fail(new Error(`the server sent a body that is not JSON: ${e.message}`))
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return this.fail(new Error('the server sent a body that is not a JSON object'))
      }
      this.onMessage(message)
    }
  }

  /** Parses the header when it is complete; false while more bytes are needed. */
  readHeader() {
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size)
    this.chunks = [buf]
    const end = buf.indexOf(CRLFCRLF)
    if (end < 0) {
      if (buf.length > MAX_HEADER_BYTES) this.fail(new Error('the server sent a header that is too long (not LSP on stdout?)'))
      return false
    }
    if (end > MAX_HEADER_BYTES) {
      this.fail(new Error('the server sent a header that is too long'))
      return false
    }
    let length = -1
    for (const line of buf.subarray(0, end).toString('latin1').split('\r\n')) {
      const i = line.indexOf(':')
      if (i <= 0) {
        this.fail(new Error('the server sent a malformed header line (not LSP on stdout?)'))
        return false
      }
      const name = line.slice(0, i).toLowerCase()
      const value = line.slice(i + 1).trim()
      // A header name is a token: a server's banner glued to the first header is not one.
      if (!/^[a-z0-9-]{1,64}$/.test(name)) {
        this.fail(new Error('the server sent a malformed header line (not LSP on stdout?)'))
        return false
      }
      if (name === 'content-length') {
        if (!/^[0-9]{1,10}$/.test(value)) {
          this.fail(new Error('the server sent a bad Content-Length'))
          return false
        }
        length = Number(value)
      }
      // Content-Type (always utf-8 JSON in practice) and unknown headers are ignored.
    }
    if (length < 0) {
      this.fail(new Error('the server sent a header with no Content-Length'))
      return false
    }
    if (length > this.maxBody) {
      this.fail(new Error(`the server sent a message of ${length} bytes, over the ${this.maxBody} byte limit`))
      return false
    }
    this.take(end + CRLFCRLF.length)
    this.want = length
    return true
  }

  /** Removes and returns the first `n` buffered bytes. */
  take(n) {
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size)
    const out = buf.subarray(0, n)
    const rest = buf.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.size = rest.length
    return out
  }

  fail(err) {
    this.failed = true
    this.chunks = []
    this.size = 0
    this.onError(err)
  }
}

module.exports = { encode, Decoder }
