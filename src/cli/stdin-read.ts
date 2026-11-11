// Reading stdin, capped and bounded: `ccc hook`'s payload, a plugin command's stdin and `ccc web
// password`'s pipe. Every wait in the CLI has a deadline (CLAUDE.md): an open pipe nobody closes
// (`sleep 999 | ccc …`, a tool runner that leaves stdin attached) must end in an answer, not a hang.
import type { Readable } from 'node:stream'
import { errorText } from '../shared/error-text'

/** What a capped read got; `error` only when the stream failed (then `text` is what came before it). */
export interface StdinRead {
  text: string
  truncated: boolean
  error?: string
}

/**
 * Read at most `cap` bytes of `stream`. `truncated` is true when more was available: the text is
 * then cut off (possibly mid-character) and is not worth parsing. Resolves on end, close or error;
 * the caller's own deadline covers a stream that never ends. On an error `error` holds its
 * message and `text` is only what arrived before it: a hook still goes out with that (it must
 * never fail), but a plugin command refuses to run on a partial payload (runPlugin).
 */
export function readStdinCapped(stream: Readable, cap: number): Promise<StdinRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (truncated: boolean, error?: unknown): void => {
      if (done) return
      done = true
      stream.off('data', onData)
      stream.pause()
      const text = Buffer.concat(chunks).subarray(0, cap).toString('utf8')
      resolve(error === undefined ? { text, truncated } : { text, truncated, error: errorText(error) })
    }
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      chunks.push(buf)
      size += buf.length
      if (size > cap) finish(true)
    }
    stream.on('data', onData)
    stream.once('end', () => finish(false))
    stream.once('close', () => finish(false))
    // An error is followed by `close`, never preceded by it (stream.destroy(err) emits both in
    // that order), so a failed read is never taken for a clean end.
    stream.once('error', (err: unknown) => finish(false, err ?? new Error('read failed')))
  })
}

/**
 * `readStdinCapped` raced against `timeoutMs`: `timedOut` when the stream did not end in time. The
 * timer goes once the read is over; an abandoned read is left to the caller's exit.
 */
export async function readStdinBounded(stream: Readable, cap: number, timeoutMs: number): Promise<StdinRead | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return await Promise.race([
    readStdinCapped(stream, cap),
    new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}
