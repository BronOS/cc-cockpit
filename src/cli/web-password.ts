// `ccc web password` (design-web.md §9.4): where the password comes from. Never argv (argv shows in
// `ps` to every user of the machine): stdin, or on a terminal a no-echo prompt asked twice.
//
// The prompt is read before the request starts (the 40 s deadline covers the round trip, not a
// person typing), and has a deadline of its own all the same: every wait in the CLI is bounded
// (CLAUDE.md), and a prompt left open in a forgotten terminal must end. A pipe is read capped, under
// the plugin commands' stdin deadline: an open pipe nobody closes ends in an error, not a hang.
//
// The password is only ever returned to the caller: never written to stdout or stderr, never in an
// error text (each names the rule, not the value).
import type { Readable } from 'node:stream'

/** client.ts's `readStdinCapped`, passed in (this file is imported by client.ts). */
export type ReadCapped = (stream: Readable, cap: number) => Promise<{ text: string; truncated: boolean; error?: string }>

/** Most bytes read from a pipe: 256 characters (main's limit) of up to four bytes, and a newline. */
export const MAX_PASSWORD_STDIN_BYTES = 1100
/** How long the no-echo prompt waits for each of its two answers. */
export const PROMPT_TIMEOUT_MS = 5 * 60 * 1000

/** A terminal stdin: `setRawMode` is what turns echo off. */
interface TtyInput extends Readable {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
}

export type PasswordRead = { password: string } | { error: string }

/**
 * One line typed with no echo. Raw mode delivers keys as typed: Enter ends, Backspace takes one
 * character back, Ctrl-C (and Ctrl-D on an empty line) cancels, other control keys and escape
 * sequences (arrows, `ESC [ A`) are dropped. Over `cap` characters is refused rather than cut.
 */
export function readHidden(input: TtyInput, write: (text: string) => void, prompt: string, timeoutMs: number, cap: number): Promise<PasswordRead> {
  return new Promise((resolve) => {
    let chars: string[] = []
    let done = false
    const finish = (result: PasswordRead): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      input.off('data', onData)
      try {
        input.setRawMode?.(false)
      } catch {
        // the terminal went away: nothing to restore
      }
      input.pause()
      chars = []
      // The Enter was not echoed either: end the prompt's line.
      write('\n')
      resolve(result)
    }
    const timer = setTimeout(() => finish({ error: `no password typed within ${Math.round(timeoutMs / 60000)} minutes` }), timeoutMs)
    // 0: text; 1: after ESC; 2: inside a CSI/SS3 sequence (`ESC [ A`), until its final byte.
    let escape = 0
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0
        if (escape === 1) {
          escape = ch === '[' || ch === 'O' ? 2 : 0
          continue
        }
        if (escape === 2) {
          if (code >= 0x40 && code <= 0x7e) escape = 0
          continue
        }
        if (ch === '\r' || ch === '\n') return finish({ password: chars.join('') })
        if (ch === '\u0003' || (ch === '\u0004' && chars.length === 0)) return finish({ error: 'cancelled' })
        if (ch === '\u0004') return finish({ password: chars.join('') })
        if (ch === '\u007f' || ch === '\b') {
          chars.pop()
          continue
        }
        // An escape sequence (an arrow key, Alt plus a key) is a key, not text.
        if (ch === '\u001b') {
          escape = 1
          continue
        }
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
        chars.push(ch)
        if (chars.length > cap) return finish({ error: `the password may have at most ${cap} characters` })
      }
    }
    if (typeof input.setRawMode !== 'function') {
      resolve({ error: 'this terminal cannot turn echo off; pipe the password on stdin instead' })
      return
    }
    write(prompt)
    input.setRawMode(true)
    input.on('data', onData)
    input.resume()
  })
}

/**
 * The password for `ccc web password`: on a terminal asked twice with no echo (the two must match:
 * an unseen typo would lock the person out), else the whole of stdin, one line (a final newline is
 * dropped, `echo pw | ccc web password` works). `maxChars` is main's limit, checked again there.
 */
export async function readPassword(
  stdin: Readable,
  stderr: (text: string) => void,
  options: { maxChars: number; stdinTimeoutMs: number; promptTimeoutMs?: number; readCapped: ReadCapped }
): Promise<PasswordRead> {
  const input = stdin as TtyInput
  if (input.isTTY === true) {
    const timeout = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS
    const first = await readHidden(input, stderr, 'New web access password: ', timeout, options.maxChars)
    if ('error' in first) return first
    if (first.password === '') return { error: 'no password typed' }
    const again = await readHidden(input, stderr, 'Type it again: ', timeout, options.maxChars)
    if ('error' in again) return again
    return again.password === first.password ? first : { error: 'the two passwords differ; nothing changed' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = await Promise.race([
    options.readCapped(stdin, MAX_PASSWORD_STDIN_BYTES),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), options.stdinTimeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
  if (read === undefined) return { error: `stdin was not closed within ${Math.round(options.stdinTimeoutMs / 1000)} s` }
  if (read.error !== undefined) return { error: `reading stdin failed: ${read.error}` }
  if (read.truncated) return { error: `the password on stdin is over ${MAX_PASSWORD_STDIN_BYTES} bytes` }
  let text = read.text
  if (text.endsWith('\n')) text = text.slice(0, -1)
  if (text.endsWith('\r')) text = text.slice(0, -1)
  if (text === '') return { error: 'no password on stdin' }
  if (text.includes('\n') || text.includes('\r')) return { error: 'the password on stdin must be one line' }
  return { password: text }
}
