'use strict'
// "Open with" rules (app setting `openWith`): which files a tree click opens some other way than the
// project's file opener (the reviewer by default). A rule is
//   { extensions: "pdf" | "json, jsonl" | ".tar.gz …", action: "system" | "terminal" | "default",
//     command?: "jq -C . {file}", where?: "overlay" | "tab", waitForKey?: boolean }
// A click takes the first rule whose extensions match; the context menu lists every matching rule.
// Pure functions (no ctx), so test/open-with.test.js runs them under node.
//
// The command is the person's own text, but the file name is not: any repo can hold a file named
// `$(curl x|sh).md`. So the command is split into words here (quotes group, nothing else is shell
// syntax), and the path only ever replaces a word that is exactly `{file}`, as one argv element. A
// `{file}` inside a larger word is refused: once argv[0] is a shell (`sh -c "glow {file} | less"`),
// a substituted word is shell text and the file name would run. Pipes are written with the path as
// a positional argument: `sh -c 'glow "$1" | less -R' sh {file}`.

const MAX_RULES = 30
const MAX_COMMAND = 2048
const MAX_WORDS = 64
const ACTIONS = new Set(['system', 'terminal', 'default'])
const WHERES = new Set(['overlay', 'tab'])
const EXT_RE = /^[a-z0-9_+~-]+(\.[a-z0-9_+~-]+)*$/

/** The extensions of a rule as lower-case suffixes without the leading dot: "pdf", "tar.gz". */
function parseExtensions(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase().replace(/^\*?\./, '')
    if (e && EXT_RE.test(e) && !out.includes(e)) out.push(e)
  }
  return out
}

/** True when the file name ends in `.<ext>` (and is more than the extension: `.pdf` alone is a dot file). */
function nameMatches(name, ext) {
  const n = name.toLowerCase()
  return n.length > ext.length + 1 && n.endsWith(`.${ext}`)
}

/**
 * Splits a command line into words: whitespace separates, '…' and "…" group (no escapes inside
 * single quotes; `\"` and `\\` inside double quotes; `\x` outside quotes is x). No other shell
 * syntax: `|`, `$`, `;`, `>` are ordinary characters. Throws on an unclosed quote.
 */
function splitCommand(line) {
  const words = []
  let cur = null
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i]
      else cur += c
      continue
    }
    if (/\s/.test(c)) {
      if (cur !== null) words.push(cur)
      cur = null
      continue
    }
    if (cur === null) cur = ''
    if (c === "'" || c === '"') quote = c
    else if (c === '\\' && i + 1 < line.length) cur += line[++i]
    else cur += c
  }
  if (quote) throw new Error('the command has an unclosed quote')
  if (cur !== null) words.push(cur)
  return words
}

/**
 * A rule as the plugin uses it, or { error } for one it cannot run (shown in the menu and logged,
 * never silently skipped by a click). `label` names it in the context menu.
 */
function checkRule(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not a rule' }
  const extensions = parseExtensions(raw.extensions)
  if (!extensions.length) return { error: 'no extensions' }
  const action = ACTIONS.has(raw.action) ? raw.action : 'default'
  if (action === 'system') return { extensions, action, label: 'System app' }
  if (action === 'default') return { extensions, action, label: 'Default opener' }
  // A terminal rule that cannot run still has a menu label (the item says it is not runnable).
  const bad = (error) => ({ extensions, action, label: 'Terminal command', error })
  const text = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (!text) return bad('the command is empty')
  if (text.length > MAX_COMMAND) return bad(`the command is longer than ${MAX_COMMAND} characters`)
  let words
  try {
    words = splitCommand(text)
  } catch (e) {
    return bad(e.message)
  }
  if (!words.length) return bad('the command is empty')
  if (words.length > MAX_WORDS) return bad(`the command has more than ${MAX_WORDS} words`)
  if (words.some((w) => w.includes('\0'))) return bad('the command contains a NUL')
  if (words.some((w) => w !== '{file}' && w.includes('{file}'))) {
    return bad('{file} must be a word of its own (for a pipe: sh -c \'cmd "$1" | less\' sh {file})')
  }
  if (words[0] === '{file}') return bad('the command cannot start with {file}')
  const where = WHERES.has(raw.where) ? raw.where : 'overlay'
  const waitForKey = raw.waitForKey !== false
  return { extensions, action, words, where, waitForKey, label: `${words[0]} (${where === 'tab' ? 'new tab' : 'terminal'})` }
}

/** The checked rules of the setting, at most MAX_RULES, in order. */
function rulesOf(setting) {
  return (Array.isArray(setting) ? setting : []).slice(0, MAX_RULES).map(checkRule)
}

/** The rules matching a project-relative path, in order (each with its index in the setting). */
function matchRules(rel, rules) {
  const name = String(rel).split('/').pop()
  const out = []
  rules.forEach((r, index) => {
    if (r.extensions && r.extensions.some((e) => nameMatches(name, e))) out.push({ ...r, index })
  })
  return out
}

// After the program ends: say how it ended and wait for Enter, so the output stays readable (a
// terminal overlay closes with its program, and a command tab that exits 0 closes too). The path is
// still an argument ("$@"), never part of this script.
const WAIT_SCRIPT = '"$@"; s=$?; printf "\\n[exit %s, press Enter to close]" "$s"; read -r _'

/**
 * The argv of a terminal rule for a project-relative path: each `{file}` word becomes the path as
 * one element (a path starting with `-` as `./-…`, so no program reads it as an option), wrapped
 * for waitForKey.
 */
function buildArgv(rule, rel) {
  if (!rule.words) throw new Error('not a terminal rule')
  const file = rel.startsWith('-') ? `./${rel}` : rel
  const argv = rule.words.map((w) => (w === '{file}' ? file : w))
  return rule.waitForKey ? ['sh', '-c', WAIT_SCRIPT, 'sh', ...argv] : argv
}

module.exports = { MAX_RULES, parseExtensions, splitCommand, checkRule, rulesOf, matchRules, buildArgv, WAIT_SCRIPT }
