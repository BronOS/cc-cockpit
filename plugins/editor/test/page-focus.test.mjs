// The editor page never takes the keyboard by itself when a file loads (docs/design-split-pages.md §4):
// a sandboxed frame calling focus() takes the keyboard from the shell, so a file pane loading beside
// the Claude pane would pull the person's keys into the editor. No page test loads file.js's DOM
// (CodeMirror, the SDK), so this reads its source: load() calls no view.focus(), and the one refocus
// it keeps runs only while the frame's document already holds the keyboard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/page/file.js', import.meta.url), 'utf8')

/** The body of the top-level `function <name>(...) {...}`, up to the closing brace at column 0. */
function bodyOf(name) {
  const start = source.indexOf(`\nfunction ${name}(`)
  assert.notEqual(start, -1, `no function ${name} in file.js`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `no end of function ${name}`)
  return source.slice(start, end)
}

/** The code of a body without its line comments (they may name what the code must not do). */
const code = (body) =>
  body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')

test('load() calls no view.focus(): a file that loads never takes the keyboard from the shell', () => {
  const body = code(bodyOf('load'))
  // Any call form: `.focus()`, `.focus({ preventScroll })`, `.focus?.()`, `["focus"]()`.
  assert.doesNotMatch(body, /\.focus\s*(\?\.)?\s*\(|\[\s*["'`]focus["'`]\s*\]/)
  // What it keeps: the frame that already holds the keyboard puts it in the new buffer.
  assert.match(body, /if \(document\.hasFocus\(\)\) refocusAfterInert\(\)/)
})

test('refocusAfterInert() moves the focus only inside the page, onto nothing focused', () => {
  const body = code(bodyOf('refocusAfterInert'))
  assert.match(body, /if \(at && at !== document\.body && at !== document\.documentElement\) return/)
})
