'use strict'
// Claude Code's transcripts, read the cheap way. Layout (Claude Code 2.x):
//
//   <config>/projects/<encoded cwd>/<sessionId>.jsonl                       a session
//   <config>/projects/<encoded cwd>/<sessionId>/subagents/agent-<id>.jsonl  its subagents
//
// `<config>` is $CLAUDE_CONFIG_DIR (a comma-separated list is read as several, as Claude Code's own
// tools do), else ~/.claude. One JSON object per line; an `"type":"assistant"` line carries the API
// message's `usage`. One API message is written as several lines (one per content block: thinking,
// text, tool_use) that repeat the same `message.id`, `requestId` and usage, so a message is counted
// once by that pair (store.js keeps the keys).
//
// The files are large (hundreds of MB in all) and only grow, so they are read incrementally from a
// remembered byte offset, streamed in chunks, and a line is parsed only when its raw text contains
// `"usage"` (or, until a session has its title, `"type":"user"`). A line is consumed only once its
// newline is on disk: Claude Code appends a line with one write, but a scan can land between the
// bytes of a long one.
const nodeCrypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Bytes read per chunk. */
const CHUNK = 256 * 1024
/** A line longer than this is skipped (it would only be a huge tool result, never usage worth the memory). */
const MAX_LINE = 64 * 1024 * 1024
/**
 * Bytes at a file's start whose hash notices a rewrite (same name and inode, same or larger size).
 * A line's first bytes are the same JSON keys in every line, so it takes enough to reach the first
 * line's ids and timestamp.
 */
const HEAD_BYTES = 4096
/** A session's title: the first prompt, cut to this many characters. */
const TITLE_MAX = 80

/** The `projects` folders to read, from the environment (never anything else). */
function projectRoots(env = process.env, home = os.homedir()) {
  const raw = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : ''
  const dirs = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const configs = dirs.length > 0 ? dirs : [path.join(home, '.claude')]
  return [...new Set(configs.map((d) => path.join(path.resolve(d), 'projects')))]
}

async function readdirSafe(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Every transcript under `roots`: `{ path, sessionId, sidechain, projectDir }`, the session id from
 * the file's place (a subagent's file is counted under its parent session), `projectDir` the encoded
 * folder (a fallback when a line has no `cwd`). Symlinks are not followed.
 */
async function discover(roots) {
  const out = []
  for (const root of roots) {
    for (const project of await readdirSafe(root)) {
      if (!project.isDirectory()) continue
      const dir = path.join(root, project.name)
      for (const entry of await readdirSafe(dir)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          out.push({ path: path.join(dir, entry.name), sessionId: entry.name.slice(0, -'.jsonl'.length), sidechain: false, projectDir: project.name })
        } else if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name, 'subagents')
          for (const agent of await readdirSafe(sub)) {
            if (agent.isFile() && agent.name.endsWith('.jsonl')) {
              out.push({ path: path.join(sub, agent.name), sessionId: entry.name, sidechain: true, projectDir: project.name })
            }
          }
        }
      }
    }
  }
  return out
}

/**
 * One assistant line's usage, or null for any other line (and for a line that is not JSON: a torn or
 * hand-edited file must not stop the scan). `key` is `message.id:requestId`, null when the line has
 * neither (then it cannot be deduplicated and is counted as is).
 */
function parseUsageLine(line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || o.type !== 'assistant') return null
  const m = o.message
  if (!m || typeof m !== 'object' || !m.usage || typeof m.usage !== 'object') return null
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  if (!Number.isFinite(ts)) return null
  const id = typeof m.id === 'string' ? m.id : ''
  const req = typeof o.requestId === 'string' ? o.requestId : ''
  return {
    key: id || req ? `${id}:${req}` : null,
    model: typeof m.model === 'string' && m.model ? m.model : 'unknown',
    ts,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
    cwd: typeof o.cwd === 'string' && o.cwd ? o.cwd : undefined,
    sidechain: o.isSidechain === true,
    usage: m.usage
  }
}

/**
 * The session's title from a user line: the person's first prompt, first line, cut. Null for a line
 * that is not a typed prompt: tool results, meta lines, a subagent's prompt, and Claude Code's own
 * markup (`<command-name>`, `<local-command-stdout>`, system reminders all start with `<`).
 */
function parseTitleLine(line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || o.type !== 'user' || o.isMeta === true || o.isSidechain === true) return null
  const c = o.message && o.message.content
  let text
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    const block = c.find((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    if (!block) return null
    text = block.text
  } else return null
  text = text.trim()
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return null
  const first = text.split('\n', 1)[0].trim()
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first
}

/** A hash of the first `length` bytes. */
async function readHead(handle, length) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, 0)
  return nodeCrypto.createHash('sha1').update(buf.subarray(0, bytesRead)).digest('base64')
}

/**
 * Read `file` from `from` up to `to` (both byte offsets), calling `onLine(text)` for each complete
 * line, and `await pace(bytes)` after each chunk (the caller's CPU budget: it yields or sleeps).
 * Resolves the offset just past the last newline read, so a partial last line is read next time.
 * `shouldStop()` true ends early at the last complete line.
 */
async function readLines(file, from, to, onLine, pace, shouldStop = () => false) {
  const handle = await fs.promises.open(file, 'r')
  try {
    let pos = from
    let consumed = from
    let carry = null
    let skipping = false
    const buf = Buffer.alloc(CHUNK)
    while (pos < to && !shouldStop()) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, to - pos), pos)
      if (bytesRead === 0) break
      let chunk = buf.subarray(0, bytesRead)
      const chunkStart = pos
      pos += bytesRead
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        if (skipping) {
          skipping = false
        } else {
          const piece = chunk.subarray(start, nl)
          const lineBuf = carry ? Buffer.concat([carry, piece]) : piece
          if (lineBuf.length > 0) onLine(lineBuf.toString('utf8'))
        }
        carry = null
        start = nl + 1
        consumed = chunkStart + start
      }
      if (start < chunk.length && !skipping) {
        const rest = Buffer.from(chunk.subarray(start))
        carry = carry ? Buffer.concat([carry, rest]) : rest
        if (carry.length > MAX_LINE) {
          carry = null
          skipping = true
        }
      }
      chunk = null
      await pace(bytesRead)
    }
    return consumed
  } finally {
    await handle.close()
  }
}

module.exports = { CHUNK, HEAD_BYTES, TITLE_MAX, projectRoots, discover, parseUsageLine, parseTitleLine, readHead, readLines }
