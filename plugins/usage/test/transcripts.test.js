'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tr = require('../dist/lib/transcripts')
const f = require('./fixtures')

const TS = Date.parse('2026-11-08T10:00:00Z')

test('projectRoots: CLAUDE_CONFIG_DIR (a comma list too), else ~/.claude', () => {
  assert.deepEqual(tr.projectRoots({}, '/home/me'), [path.join('/home/me', '.claude', 'projects')])
  assert.deepEqual(tr.projectRoots({ CLAUDE_CONFIG_DIR: '/c1' }, '/home/me'), [path.join('/c1', 'projects')])
  assert.deepEqual(tr.projectRoots({ CLAUDE_CONFIG_DIR: ' /c1 , /c2,/c1' }, '/home/me'), [path.join('/c1', 'projects'), path.join('/c2', 'projects')])
  assert.deepEqual(tr.projectRoots({ CLAUDE_CONFIG_DIR: ' , ' }, '/home/me'), [path.join('/home/me', '.claude', 'projects')])
})

test('parseUsageLine: an assistant line with usage; key from message id and request id', () => {
  const line = f.assistant({ id: 'msg_1', req: 'req_1', ts: TS, sessionId: 'abc', cwd: '/w' }).trim()
  const m = tr.parseUsageLine(line)
  assert.equal(m.key, 'msg_1:req_1')
  assert.equal(m.model, 'claude-opus-5-5')
  assert.equal(m.ts, TS)
  assert.equal(m.sessionId, 'abc')
  assert.equal(m.cwd, '/w')
  assert.equal(m.usage.output_tokens, 100)
  // No id at all: counted, never deduplicated.
  const bare = JSON.parse(line)
  delete bare.message.id
  delete bare.requestId
  assert.equal(tr.parseUsageLine(JSON.stringify(bare)).key, null)
})

test('parseUsageLine: anything else is null, a torn line included', () => {
  assert.equal(tr.parseUsageLine('{"type":"user","message":{"usage":{}}}'), null)
  assert.equal(tr.parseUsageLine('{"type":"assistant","message":{"id":"m"},"timestamp":"2026-11-08T10:00:00Z"}'), null)
  assert.equal(tr.parseUsageLine('{"type":"assistant","message":{"usage":{}},"timestamp":"nope"}'), null)
  assert.equal(tr.parseUsageLine('{"type":"assistant","message":{"usa'), null)
  assert.equal(tr.parseUsageLine('null'), null)
  // The model `<synthetic>` and a missing one are kept as names (priced as unknown later).
  const syn = JSON.parse(f.assistant({ id: 'm', req: 'r', ts: TS, model: '<synthetic>' }))
  assert.equal(tr.parseUsageLine(JSON.stringify(syn)).model, '<synthetic>')
  delete syn.message.model
  assert.equal(tr.parseUsageLine(JSON.stringify(syn)).model, 'unknown')
})

test('parseTitleLine: the first line of a typed prompt, never markup, meta or tool results', () => {
  assert.equal(tr.parseTitleLine(f.userPrompt('Fix the login bug\nand add a test')), 'Fix the login bug')
  assert.equal(tr.parseTitleLine(f.userPrompt('<command-name>/clear</command-name>')), null)
  assert.equal(tr.parseTitleLine(f.userPrompt('Caveat: the messages below')), null)
  assert.equal(tr.parseTitleLine(f.userPrompt('hello', { meta: true })), null)
  const blocks = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } })
  assert.equal(tr.parseTitleLine(blocks), null)
  const text = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Write the docs' }] } })
  assert.equal(tr.parseTitleLine(text), 'Write the docs')
  const long = tr.parseTitleLine(f.userPrompt('x'.repeat(200)))
  assert.equal(long.length, tr.TITLE_MAX)
  assert.ok(long.endsWith('…'))
})

test('discover: sessions and their subagents, the subagent under its parent session', async () => {
  const config = f.tempConfig()
  f.append(f.transcriptPath(config, '-work-alpha', 'sess-a'), '')
  f.append(f.transcriptPath(config, '-work-alpha', 'sess-a', 'x1'), '')
  f.append(f.transcriptPath(config, '-work-beta', 'sess-b'), '')
  fs.writeFileSync(path.join(config, 'projects', '-work-beta', 'notes.txt'), '')
  fs.writeFileSync(path.join(config, 'projects', 'stray.jsonl'), '')
  const found = (await tr.discover([path.join(config, 'projects'), path.join(config, 'missing')])).map((x) => [path.relative(config, x.path), x.sessionId, x.sidechain, x.projectDir]).sort()
  assert.deepEqual(found, [
    [path.join('projects', '-work-alpha', 'sess-a.jsonl'), 'sess-a', false, '-work-alpha'],
    [path.join('projects', '-work-alpha', 'sess-a', 'subagents', 'agent-x1.jsonl'), 'sess-a', true, '-work-alpha'],
    [path.join('projects', '-work-beta', 'sess-b.jsonl'), 'sess-b', false, '-work-beta']
  ])
})

test('readLines: complete lines only, a partial last line left for the next read; pace is called', async () => {
  const config = f.tempConfig()
  const file = path.join(config, 'x.jsonl')
  fs.writeFileSync(file, 'one\ntwo\nthr')
  const lines = []
  let paced = 0
  const size = fs.statSync(file).size
  let offset = await tr.readLines(file, 0, size, (l) => lines.push(l), async () => paced++)
  assert.deepEqual(lines, ['one', 'two'])
  assert.equal(offset, 8)
  assert.ok(paced >= 1)
  fs.appendFileSync(file, 'ee\nfour\n')
  offset = await tr.readLines(file, offset, fs.statSync(file).size, (l) => lines.push(l), async () => {})
  assert.deepEqual(lines, ['one', 'two', 'three', 'four'])
  assert.equal(offset, fs.statSync(file).size)
})

test('readLines: a line across chunk boundaries and a multi-byte character are kept whole', async () => {
  const config = f.tempConfig()
  const file = path.join(config, 'big.jsonl')
  const long = 'é'.repeat(tr.CHUNK) // 2 bytes each: the line spans three chunks
  fs.writeFileSync(file, `a\n${long}\nb\n`)
  const lines = []
  await tr.readLines(file, 0, fs.statSync(file).size, (l) => lines.push(l), async () => {})
  assert.equal(lines.length, 3)
  assert.equal(lines[1], long)
  assert.equal(lines[2], 'b')
})

test('readLines: shouldStop ends at the last complete line', async () => {
  const config = f.tempConfig()
  const file = path.join(config, 'x.jsonl')
  const line = 'y'.repeat(1000)
  fs.writeFileSync(file, `${line}\n`.repeat(tr.CHUNK / 500))
  const lines = []
  const offset = await tr.readLines(file, 0, fs.statSync(file).size, (l) => lines.push(l), async () => {}, () => lines.length > 0)
  assert.equal(offset, lines.length * 1001)
  assert.ok(offset < fs.statSync(file).size)
})
