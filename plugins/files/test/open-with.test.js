'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ow = require('../dist/lib/open-with')

test('parseExtensions: separators, dots, case, multi-part, junk dropped', () => {
  assert.deepEqual(ow.parseExtensions('pdf'), ['pdf'])
  assert.deepEqual(ow.parseExtensions(' .JSON, jsonl;  *.Tar.GZ '), ['json', 'jsonl', 'tar.gz'])
  assert.deepEqual(ow.parseExtensions('pdf pdf ../x a/b $x'), ['pdf'])
  assert.deepEqual(ow.parseExtensions(''), [])
  assert.deepEqual(ow.parseExtensions(undefined), [])
})

test('matchRules: last or multi-part extension, any case, first match first; a dot file is not its extension', () => {
  const rules = ow.rulesOf([
    { extensions: 'pdf', action: 'system' },
    { extensions: 'json', action: 'terminal', command: 'jq -C . {file}' },
    { extensions: 'tar.gz', action: 'terminal', command: 'tar tzf {file}', where: 'tab' },
    { extensions: 'PDF', action: 'default' },
  ])
  assert.deepEqual(ow.matchRules('docs/Spec.PDF', rules).map((r) => [r.index, r.action]), [[0, 'system'], [3, 'default']])
  assert.deepEqual(ow.matchRules('a/b.json', rules).map((r) => r.index), [1])
  assert.deepEqual(ow.matchRules('x.tar.gz', rules).map((r) => r.index), [2])
  assert.deepEqual(ow.matchRules('x.gz', rules), [])
  assert.deepEqual(ow.matchRules('.pdf', rules), [])
  assert.deepEqual(ow.matchRules('README', rules), [])
  assert.deepEqual(ow.matchRules('a.json', ow.rulesOf(null)), [])
  assert.equal(ow.rulesOf(Array(40).fill({ extensions: 'x', action: 'system' })).length, ow.MAX_RULES)
})

test('splitCommand: quotes group, backslashes, no other shell syntax', () => {
  assert.deepEqual(ow.splitCommand(`jq -C . {file}`), ['jq', '-C', '.', '{file}'])
  assert.deepEqual(ow.splitCommand(`sh -c 'glow "$1" | less -R' sh {file}`), ['sh', '-c', 'glow "$1" | less -R', 'sh', '{file}'])
  assert.deepEqual(ow.splitCommand(`a "b \\"c\\" d" e\\ f ''`), ['a', 'b "c" d', 'e f', ''])
  assert.deepEqual(ow.splitCommand(`x|y;z $HOME`), ['x|y;z', '$HOME'])
  assert.throws(() => ow.splitCommand(`a 'b`), /unclosed quote/)
})

test('checkRule: what a click can run, and why not', () => {
  assert.equal(ow.checkRule({ extensions: 'md', action: 'terminal', command: '' }).error, 'the command is empty')
  assert.match(ow.checkRule({ extensions: 'md', action: 'terminal', command: 'sh -c "glow {file} | less"' }).error, /word of its own/)
  assert.match(ow.checkRule({ extensions: 'md', action: 'terminal', command: 'cat --in={file}' }).error, /word of its own/)
  assert.match(ow.checkRule({ extensions: 'md', action: 'terminal', command: '{file}' }).error, /cannot start with/)
  assert.match(ow.checkRule({ extensions: 'md', action: 'terminal', command: "a 'b" }).error, /unclosed/)
  assert.equal(ow.checkRule({ extensions: '', action: 'system' }).error, 'no extensions')
  assert.equal(ow.checkRule(null).error, 'not a rule')
  const r = ow.checkRule({ extensions: 'json', action: 'terminal', command: 'jq . {file}' })
  assert.deepEqual([r.where, r.waitForKey, r.label], ['overlay', true, 'jq (terminal)'])
  assert.equal(ow.checkRule({ extensions: 'json', action: 'terminal', command: 'jq . {file}', where: 'tab', waitForKey: false }).label, 'jq (new tab)')
  // An unknown action is the default opener, never a command.
  assert.equal(ow.checkRule({ extensions: 'x', action: 'rm', command: 'rm {file}' }).action, 'default')
})

test('buildArgv: {file} as one element, ./ before a leading dash, the wait wrapper', () => {
  const r = ow.checkRule({ extensions: 'json', action: 'terminal', command: 'jq -C . {file}', waitForKey: false })
  assert.deepEqual(ow.buildArgv(r, 'a b/$(x).json'), ['jq', '-C', '.', 'a b/$(x).json'])
  assert.deepEqual(ow.buildArgv(r, '-rf.json'), ['jq', '-C', '.', './-rf.json'])
  const w = ow.checkRule({ extensions: 'json', action: 'terminal', command: 'jq . {file}' })
  assert.deepEqual(ow.buildArgv(w, 'x.json'), ['sh', '-c', ow.WAIT_SCRIPT, 'sh', 'jq', '.', 'x.json'])
  assert.throws(() => ow.buildArgv(ow.checkRule({ extensions: 'x', action: 'system' }), 'a.x'), /not a terminal rule/)
})

test('injection: a file named like a command substitution, through sh -c and the wrapper, runs nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-'))
  const name = '$(touch pwned)`touch pwned2`;touch pwned3.md'
  fs.writeFileSync(path.join(dir, name), 'hello\n')
  for (const waitForKey of [false, true]) {
    const r = ow.checkRule({ extensions: 'md', action: 'terminal', command: `sh -c 'cat "$1"' sh {file}`, waitForKey })
    const argv = ow.buildArgv(r, name)
    const out = execFileSync(argv[0], argv.slice(1), { cwd: dir, input: '\n' }).toString()
    assert.match(out, /^hello\n/)
  }
  assert.deepEqual(fs.readdirSync(dir), [name])
})
