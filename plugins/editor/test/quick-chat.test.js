'use strict'
// Quick chat's host half (dist/lib/quick-chat.js) against a fake `claude` (fixtures/fake-claude.mjs):
// the exact argv, the refusal when `claude --help` lacks a flag, the stream-json parse, the prompt as
// data, proposal extraction, follow-ups on the same process, and the kill on close. No real Claude runs.
const test = require('node:test')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const qc = require('../dist/lib/quick-chat.js')

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.mjs')

const tmpDirs = []
function tmp(prefix = 'qc-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** ctx.processes.spawn's shape over node:child_process, running the fake for argv[0] === FAKE. */
function makeSpawn(env = {}) {
  const calls = []
  const children = []
  const spawn = (argv, { cwd }) => {
    calls.push(argv)
    const c = cp.spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    c.stdin.on('error', () => {})
    children.push(c)
    return {
      pid: c.pid,
      write: (b) => c.stdin.write(b),
      end: () => c.stdin.end(),
      onData: (fn) => c.stdout.on('data', fn),
      onStderr: (fn) => c.stderr.on('data', fn),
      onExit: (fn) => c.on('close', (code, signal) => fn({ code, signal })),
      kill: () => c.kill(),
    }
  }
  return { spawn, calls, children }
}

function fakeTab() {
  const posted = []
  const closers = []
  return { posted, post: (m) => posted.push(m), onClose: (fn) => closers.push(fn), close: () => closers.forEach((f) => f()) }
}

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out waiting')
}

const exited = (c) => c.exitCode !== null || c.signalCode !== null

function project() {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n')
  return root
}

const START = { t: 'chat-start', id: 1, question: 'Why?', sel: { startLine: 2, endLine: 2, text: 'two' }, before: 'one\n', after: '' }

function serve(opts = {}) {
  qc._helpChecks.clear()
  const root = opts.root || project()
  const log = path.join(tmp(), 'prompts.log')
  const sp = makeSpawn({ FAKE_CLAUDE_LOG: log, ...(opts.env || {}) })
  const tab = fakeTab()
  const warnings = []
  const handle = qc.serveChat(tab, {
    spawn: sp.spawn,
    root,
    rel: 'rel' in opts ? opts.rel : 'src/a.txt',
    defaults: () => ({ model: opts.model || 'sonnet', effort: opts.effort || 'default' }),
    log: { warn: (w) => warnings.push(w) },
    bin: FAKE,
    limits: opts.limits,
  })
  const prompts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  return { ...sp, tab, handle, prompts, warnings }
}

test('chatArgv: the fixed argv, the model from a closed list', () => {
  assert.deepEqual(qc.chatArgv('/usr/bin/claude', 'sonnet'), [
    '/usr/bin/claude',
    '-p',
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    'Read,Grep,Glob',
    '--permission-prompts',
    'none',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    'sonnet',
  ])
  for (const bad of ['--dangerously-skip-permissions', 'claude-sonnet-4', '', undefined]) assert.throws(() => qc.chatArgv('claude', bad))
  // Every flag the argv uses is one the help check asks for.
  const flags = qc.chatArgv('claude', 'opus').filter((a) => a.startsWith('-'))
  assert.deepEqual([...flags].sort(), [...qc.REQUIRED_FLAGS].sort())
})

test('modelOf: the setting when it is on the list, else sonnet; the manifest offers the same list', () => {
  assert.equal(qc.modelOf({ quickChatModel: 'haiku' }), 'haiku')
  assert.equal(qc.modelOf({ quickChatModel: '--model=x' }), 'sonnet')
  assert.equal(qc.modelOf({}), 'sonnet')
  assert.equal(qc.modelOf(undefined), 'sonnet')
  const prop = require('../plugin.json').contributes.settings.app.properties.quickChatModel
  assert.deepEqual(prop.enum, qc.CHAT_MODELS)
  assert.equal(prop.default, qc.DEFAULT_MODEL)
  assert.equal(prop.pattern, undefined)
})

const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110'

test('chatArgv: --effort and --resume as separate elements after the model, only when given', () => {
  const base = qc.chatArgv('claude', 'opus')
  assert.deepEqual(qc.chatArgv('claude', 'opus', 'default'), base)
  assert.deepEqual(qc.chatArgv('claude', 'opus', 'high'), [...base, '--effort', 'high'])
  assert.deepEqual(qc.chatArgv('claude', 'opus', 'max', UUID), [...base, '--effort', 'max', '--resume', UUID])
  assert.deepEqual(qc.chatArgv('claude', 'opus', 'default', UUID), [...base, '--resume', UUID])
  for (const bad of ['--model=x', 'turbo', '', null]) assert.throws(() => qc.chatArgv('claude', 'opus', bad), /effort must be one of/)
  for (const bad of ['--help', 'fake-session', UUID.toUpperCase().replace('F', 'G'), `${UUID} `]) assert.throws(() => qc.chatArgv('claude', 'opus', 'low', bad), /session id/)
})

test('isSessionId: a UUID only, so --resume never takes a flag', () => {
  assert.equal(qc.isSessionId(UUID), true)
  assert.equal(qc.isSessionId(UUID.toUpperCase()), true)
  for (const bad of ['', '--resume', `-${UUID.slice(1)}`, UUID.replace(/-/g, 'x'), `${UUID}0`, 42, null, undefined]) assert.equal(qc.isSessionId(bad), false, String(bad))
})

test('checkPick: the page values when on the host lists, the fallback when absent, anything else refused', () => {
  const fallback = { model: 'sonnet', effort: 'default' }
  assert.deepEqual(qc.checkPick({ model: 'opus', effort: 'xhigh' }, fallback), { model: 'opus', effort: 'xhigh' })
  assert.deepEqual(qc.checkPick({}, fallback), fallback)
  assert.deepEqual(qc.checkPick({ effort: 'low' }, fallback), { model: 'sonnet', effort: 'low' })
  assert.deepEqual(qc.checkPick({ model: 'haiku' }, { model: 'opus', effort: 'max' }), { model: 'haiku', effort: 'max' })
  for (const model of ['--dangerously-skip-permissions', 'claude-opus-4', '', null, 3, ['opus']]) {
    assert.throws(() => qc.checkPick({ model }, fallback), /the model must be one of haiku, sonnet, opus, fable/)
  }
  for (const effort of ['turbo', '', '--effort', null, 1]) {
    assert.throws(() => qc.checkPick({ effort }, fallback), /the effort must be one of default, low, medium, high, xhigh, max/)
  }
})

test('effortOf, defaultsMessage: the settings, the default for anything off the list; the manifest offers the same list', () => {
  assert.equal(qc.effortOf({ quickChatEffort: 'high' }), 'high')
  assert.equal(qc.effortOf({ quickChatEffort: '--x' }), 'default')
  assert.equal(qc.effortOf({}), 'default')
  assert.equal(qc.effortOf(undefined), 'default')
  assert.deepEqual(qc.defaultsOf({ quickChatModel: 'opus', quickChatEffort: 'low' }), { model: 'opus', effort: 'low' })
  assert.deepEqual(qc.defaultsMessage({}), { t: 'chat-defaults', model: 'sonnet', effort: 'default', models: qc.CHAT_MODELS, efforts: qc.EFFORT_CHOICES })
  const prop = require('../plugin.json').contributes.settings.app.properties.quickChatEffort
  assert.deepEqual(prop.enum, qc.EFFORT_CHOICES)
  assert.equal(prop.default, qc.DEFAULT_EFFORT)
})

// The plugin cannot import core's src/shared/session-options.ts (plugins use the public API only), so
// its lists are copies: this keeps them in step.
test("the model and effort lists match core's session-options.ts", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'shared', 'session-options.ts'), 'utf8')
  const listOf = (name) => {
    const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))
    assert.ok(m, `${name} not found`)
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  }
  assert.deepEqual(qc.CHAT_MODELS, listOf('SESSION_MODELS'))
  assert.deepEqual(qc.CHAT_EFFORTS, listOf('SESSION_EFFORTS'))
})

test('missingFlags: a flag counts only as a word of its own', () => {
  const help = ['  -p, --print   Print', '  --restricted  x', '  --safe-mode   x', '  --strict-mcp-config', '  --tools <tools...>', '  --permission-prompts <t>', '  --input-format <f>', '  --output-format <f>', '  --verbose', '  --include-partial-messages', '  --model <model>'].join('\n')
  assert.deepEqual(qc.missingFlags(help), [])
  assert.deepEqual(qc.missingFlags(help.replace('--restricted  x', '--restricted-mode  x')), ['--restricted'])
  assert.deepEqual(qc.missingFlags(help.replace('-p, --print', '--print')), ['-p'])
  assert.deepEqual(qc.missingFlags(''), qc.REQUIRED_FLAGS)
  assert.deepEqual(qc.missingFlags(undefined), qc.REQUIRED_FLAGS)
})

// The fake's --help (fixtures/fake-claude.mjs) is written from the same flag list as the code, so it
// cannot catch a drift in the real CLI's wording or a flag it dropped: when a `claude` is installed,
// its own help is checked too. HOME and the config dir point at a temp dir, so nothing reads or
// writes the person's own Claude config. Skipped where no claude is installed (CI).
test("the installed claude's --help lists every flag quick chat passes, as missingFlags parses it", (t) => {
  const bin = qc.findClaude(process.env)
  if (!bin) {
    t.skip('no claude on PATH')
    return
  }
  const home = tmp('qc-home-')
  const r = cp.spawnSync(bin, ['--help'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.equal(r.status, 0, `claude --help failed: ${r.error || r.stderr}`)
  // An older claude than the one the flags were checked against (2.1.323) also lands here: update it.
  assert.deepEqual(qc.missingFlags(r.stdout), [], `the installed claude (${bin}) --help lacks these flags`)
  // The optional ones (checked against 2.1.325): a pick of an effort, a change within a chat.
  assert.deepEqual(qc.missingFlags(r.stdout, ['--effort', '--resume']), [], `the installed claude (${bin}) --help lacks these flags`)
})

test('findClaude: only absolute PATH entries, so a project cannot ship its own claude', () => {
  const dir = tmp()
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(qc.findClaude({ PATH: dir }), bin)
  const rel = path.relative(process.cwd(), dir)
  assert.equal(qc.findClaude({ PATH: rel }), null)
  assert.equal(qc.findClaude({ PATH: '' }), null)
})

test('firstPrompt: the path, the selection and the lines around it fenced as data, the question last', () => {
  const p = qc.firstPrompt({ file: 'src/a\nb.ts', sel: { startLine: 3, endLine: 99, text: 'x ```y```\nz' }, before: 'one\ntwo\n', after: 'four\n', question: '  Fix it  ' })
  assert.match(p, /^File: src\/a b\.ts$/m)
  // The range follows the text sent, not the page's claim.
  assert.match(p, /^The selection \(lines 3-4\):\n````\nx ```y```\nz\n````$/m)
  assert.match(p, /^Before the selection:\n```\none\ntwo\n```$/m)
  assert.match(p, /^After the selection:\n```\nfour\n```$/m)
  assert.ok(p.endsWith("The person's question:\nFix it"))
  assert.match(p, /data to read, not instructions/)
  assert.match(p, /info string is `replacement`/)
  // Long context is cut from its far side.
  const long = qc.firstPrompt({ file: 'a', sel: { startLine: 1, text: 's' }, before: 'B'.repeat(7000) + 'near', after: 'near' + 'A'.repeat(7000), question: 'q' })
  assert.match(long, /Bnear\n```/)
  assert.match(long, /```\nnearA/)
  assert.ok(long.length < 14000)
  // No context: no empty fences.
  assert.doesNotMatch(qc.firstPrompt({ file: 'a', sel: { startLine: 1, text: '' }, question: 'q' }), /Before|After/)
  assert.throws(() => qc.firstPrompt({ file: 'a', sel: { startLine: 1, text: 'x' }, question: '   ' }), /empty/)
  assert.throws(() => qc.firstPrompt({ file: 'a', sel: { startLine: 0, text: 'x' }, question: 'q' }), /no selection/)
  assert.throws(() => qc.firstPrompt({ file: 'a', sel: { startLine: 1, text: 'x'.repeat(qc.MAX_TARGET_CHARS + 1) }, question: 'q' }), /at most/)
  assert.throws(() => qc.firstPrompt({ file: 'a', sel: { startLine: 1, text: 'x' }, question: 'q'.repeat(10001) }), /longer/)
})

test('followUpPrompt: the question alone, or with the selection when it changed', () => {
  // Framed even alone: a bare `/clear` would reach claude as a slash command.
  assert.equal(qc.followUpPrompt({ question: ' And? ' }), "The person's question:\nAnd?")
  assert.equal(qc.followUpPrompt({ question: '/clear' }), "The person's question:\n/clear")
  assert.equal(qc.followUpPrompt({ sel: { startLine: 5, text: 'a\nb' }, question: 'q' }), 'The selection changed; it now reads (lines 5-6):\n```\na\nb\n```\n\nThe person\'s question:\nq')
})

test('userLine: one stream-json user message per line', () => {
  const line = qc.userLine('a\nb')
  assert.ok(line.endsWith('\n'))
  assert.equal(line.indexOf('\n'), line.length - 1)
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a\nb' }] } })
})

test('extractProposal: the last complete replacement block, its fence respected', () => {
  assert.equal(qc.extractProposal('Do this:\n```replacement\nconst a = 1\n```\nDone.'), 'const a = 1')
  assert.equal(qc.extractProposal('```Replacement\nA\n```\n\n```replacement\nB\n```'), 'B')
  // A longer fence holds a shorter one; a tilde fence works too.
  assert.equal(qc.extractProposal('````replacement\nx\n```\ny\n````'), 'x\n```\ny')
  assert.equal(qc.extractProposal('~~~replacement\na\n~~~'), 'a')
  // An empty replacement (delete the selection) is a proposal.
  assert.equal(qc.extractProposal('```replacement\n```'), '')
  // Not a replacement, unclosed (a cut answer), or a fence in another block: none.
  assert.equal(qc.extractProposal('```ts\nx\n```'), null)
  assert.equal(qc.extractProposal('```replacement\nhalf of it'), null)
  assert.equal(qc.extractProposal('````md\n```replacement\nx\n```\n````'), null)
  assert.equal(qc.extractProposal('```replacement\r\nx\r\n```\r\n'), 'x')
  assert.equal(qc.extractProposal(undefined), null)
  // The opener's indentation comes off the body lines, as CommonMark does (up to it, no more).
  assert.equal(qc.extractProposal('  ```replacement\n  a\n    b\n c\n  ```'), 'a\n  b\nc')
})

test('lineSplitter: lines across chunks; an overlong line is skipped, the next one kept', () => {
  const got = []
  const push = qc.lineSplitter((l) => got.push(l), 10)
  push(Buffer.from('ab'))
  push(Buffer.from('c\nde'))
  push(Buffer.from('f\n0123456789'))
  push(Buffer.from('ABC\nok\n'))
  assert.deepEqual(got, ['abc', 'def', 'ok'])
})

test('lineSplitter: a line split inside a multibyte character; a long line in many chunks', () => {
  const got = []
  const push = qc.lineSplitter((l) => got.push(l), 1000)
  const bytes = Buffer.from('é€😀\n', 'utf8')
  for (let i = 0; i < bytes.length; i++) push(bytes.subarray(i, i + 1))
  assert.deepEqual(got, ['é€😀'])
  got.length = 0
  const big = Buffer.alloc(900, 'x')
  for (let i = 0; i < 9; i++) push(Buffer.from(big.subarray(0, 100)))
  push(Buffer.from('\n'))
  assert.deepEqual(got, [big.toString()])
})

test('a chat: help check, the exact argv, streamed text, a tool, the proposal, a follow-up on the same process', async () => {
  const s = serve()
  s.handle({ ...START, question: 'PROPOSE something', path: '/etc/passwd' })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-answer'))
  // `claude --help` first, then the chat with the fixed argv (the fake refuses any other).
  assert.deepEqual(s.calls[0], [FAKE, '--help'])
  assert.deepEqual(s.calls[1], qc.chatArgv(FAKE, 'sonnet'))
  assert.equal(s.calls.length, 2)
  const kinds = s.tab.posted.map((m) => m.t)
  assert.deepEqual(kinds.slice(0, 2), ['chat-state', 'chat-state'])
  assert.deepEqual(s.tab.posted[0], { t: 'chat-state', id: 1, state: 'starting', model: 'sonnet', effort: 'default' })
  assert.deepEqual(s.tab.posted[1], { t: 'chat-state', id: 1, state: 'thinking', model: 'sonnet', effort: 'default' })
  // The tool shows project-relative; the subagent's text never reaches the answer.
  assert.deepEqual(s.tab.posted.find((m) => m.t === 'chat-tool'), { t: 'chat-tool', id: 1, name: 'Read', detail: 'a.txt' })
  const text = s.tab.posted.filter((m) => m.t === 'chat-delta').map((m) => m.text).join('')
  assert.equal(text, 'Here it is:\n\n````replacement\nNEW ```x```\nline 2\n````')
  const answer = s.tab.posted.find((m) => m.t === 'chat-answer')
  assert.deepEqual(answer, { t: 'chat-answer', id: 1, text, proposal: 'NEW ```x```\nline 2' })
  // The prompt names the tab's own path, never the page's.
  const [first] = s.prompts()
  assert.match(first, /^File: src\/a\.txt$/m)
  assert.doesNotMatch(first, /passwd/)
  assert.match(first, /The selection \(line 2\):\n```\ntwo\n```/)

  // A follow-up goes to the same process: the fake counts turns.
  await waitFor(() => s.tab.posted.at(-1).t === 'chat-state' && s.tab.posted.at(-1).state === 'ready')
  s.handle({ t: 'chat-say', id: 1, question: 'and now?', sel: { startLine: 2, text: 'TWO' } })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 2)
  assert.equal(s.tab.posted.filter((m) => m.t === 'chat-answer')[1].text, 'turn 2: ok')
  assert.equal(s.tab.posted.filter((m) => m.t === 'chat-answer')[1].proposal, null)
  assert.equal(s.calls.length, 2)
  assert.match(s.prompts()[1], /^The selection changed; it now reads \(line 2\):\n```\nTWO\n```/)

  // Closing kills the process; no message after.
  const n = s.tab.posted.length
  s.handle({ t: 'chat-close', id: 1 })
  await waitFor(() => exited(s.children[1]))
  assert.equal(s.tab.posted.length, n)
  assert.equal(qc._pluginChats.running, 0)
})

test('refused when claude --help lacks a flag; nothing else runs', async () => {
  const s = serve({ env: { FAKE_CLAUDE_OLD: '1' } })
  s.handle(START)
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  const end = s.tab.posted.find((m) => m.t === 'chat-end')
  assert.equal(end.error, true)
  assert.match(end.message, /lacks --restricted, --safe-mode/)
  assert.match(end.message, /claude update/)
  assert.deepEqual(s.calls, [[FAKE, '--help']])
  assert.equal(qc._pluginChats.running, 0)
  // The failure is not cached: an updated claude is checked again.
  assert.equal(qc._helpChecks.size, 0)
})

test("a chat's model and effort: the page's pick, else the settings; a bad one is refused before anything runs", async () => {
  const s = serve({ model: 'haiku', effort: 'low' })
  s.handle({ ...START, model: 'opus', effort: 'high' })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-answer'))
  assert.deepEqual(s.calls[1], qc.chatArgv(FAKE, 'opus', 'high'))
  assert.deepEqual(s.calls[1].slice(-4), ['--model', 'opus', '--effort', 'high'])
  assert.deepEqual(s.tab.posted[0], { t: 'chat-state', id: 1, state: 'starting', model: 'opus', effort: 'high' })
  s.tab.close()

  // Absent: the settings.
  const d = serve({ model: 'haiku', effort: 'low' })
  d.handle(START)
  await waitFor(() => d.tab.posted.some((m) => m.t === 'chat-answer'))
  assert.deepEqual(d.calls[1], qc.chatArgv(FAKE, 'haiku', 'low'))
  d.tab.close()

  // The default effort: no --effort at all.
  const n = serve()
  n.handle({ ...START, effort: 'default' })
  await waitFor(() => n.tab.posted.some((m) => m.t === 'chat-answer'))
  assert.equal(n.calls[1].includes('--effort'), false)
  n.tab.close()

  for (const bad of [{ model: '--dangerously-skip-permissions' }, { effort: 'turbo' }, { model: 'claude-opus-4' }, { effort: '' }]) {
    const b = serve()
    b.handle({ ...START, ...bad })
    await waitFor(() => b.tab.posted.some((m) => m.t === 'chat-end'))
    const end = b.tab.posted.find((m) => m.t === 'chat-end')
    assert.equal(end.error, true)
    assert.match(end.message, /^Quick chat: the (model|effort) must be one of/)
    assert.deepEqual(b.calls, [], 'nothing spawned, not even the help probe')
    assert.equal(qc._pluginChats.running, 0)
  }
  await waitFor(() => s.children.concat(d.children, n.children).every(exited))
})

test('an effort the installed claude has no --effort for is refused; the default effort still runs', async () => {
  const s = serve({ env: { FAKE_CLAUDE_NO_EFFORT: '1' } })
  s.handle({ ...START, effort: 'high' })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  assert.match(s.tab.posted.find((m) => m.t === 'chat-end').message, /has no --effort; pick the default effort or update it/)
  assert.deepEqual(s.calls, [[FAKE, '--help']])
  assert.equal(qc._pluginChats.running, 0)
  // The help passed the required flags, so it stays cached; the default effort needs no --effort.
  s.handle({ ...START, id: 2 })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-answer' && m.id === 2))
  assert.deepEqual(s.calls[1], qc.chatArgv(FAKE, 'sonnet'))
  s.tab.close()
  await waitFor(() => s.children.every(exited))
})

test('a follow-up with another model or effort resumes the session in a new claude; the old one is killed', async () => {
  const s = serve()
  s.handle(START)
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-state' && m.state === 'ready'))
  // The same pick: the same process.
  s.handle({ t: 'chat-say', id: 1, question: 'again', model: 'sonnet', effort: 'default' })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 2)
  assert.equal(s.tab.posted.filter((m) => m.t === 'chat-answer')[1].text, 'turn 2: ok')
  assert.equal(s.calls.length, 2)

  s.handle({ t: 'chat-say', id: 1, question: 'deeper', model: 'opus', effort: 'max' })
  // A second question while it switches is ignored, not an ended chat.
  s.handle({ t: 'chat-say', id: 1, question: 'twice' })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 3)
  assert.deepEqual(s.calls[2], qc.chatArgv(FAKE, 'opus', 'max', UUID))
  assert.equal(s.calls.length, 3, 'the help check was cached')
  assert.equal(exited(s.children[1]), true, 'the old claude is gone before the new one runs')
  // The new process answered (its own turn count), and its exit or the old one's ends nothing.
  assert.equal(s.tab.posted.filter((m) => m.t === 'chat-answer')[2].text, 'turn 1: ok')
  assert.deepEqual(s.tab.posted.filter((m) => m.t === 'chat-state').at(-1), { t: 'chat-state', id: 1, state: 'ready', model: 'opus', effort: 'max' })
  assert.equal(s.tab.posted.some((m) => m.t === 'chat-end'), false)
  assert.deepEqual(s.prompts().slice(-1), ["The person's question:\ndeeper"])

  // Absent in a follow-up: the chat's own (opus, max), not the settings.
  s.handle({ t: 'chat-say', id: 1, question: 'more' })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 4)
  assert.equal(s.calls.length, 3)

  // A bad pick: an error answer, nothing spawned, the chat goes on.
  s.handle({ t: 'chat-say', id: 1, question: 'x', effort: '--dangerously-skip-permissions' })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 5)
  assert.deepEqual(s.tab.posted.filter((m) => m.t === 'chat-answer')[4], { t: 'chat-answer', id: 1, text: 'Quick chat: the effort must be one of default, low, medium, high, xhigh, max', proposal: null, error: true })
  assert.equal(s.calls.length, 3)

  s.handle({ t: 'chat-close', id: 1 })
  await waitFor(() => s.children.every(exited))
  assert.equal(qc._pluginChats.running, 0)
})

test('a change within a chat is refused when claude has no --resume; the chat goes on as it was', async () => {
  const s = serve({ env: { FAKE_CLAUDE_NO_RESUME: '1' } })
  s.handle(START)
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-state' && m.state === 'ready'))
  s.handle({ t: 'chat-say', id: 1, question: 'deeper', model: 'opus' })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 2)
  const refused = s.tab.posted.filter((m) => m.t === 'chat-answer')[1]
  assert.equal(refused.error, true)
  assert.match(refused.text, /no --resume, so the model or effort cannot change within a chat/)
  assert.equal(s.calls.length, 2)
  assert.equal(exited(s.children[1]), false)
  s.handle({ t: 'chat-say', id: 1, question: 'then sonnet', model: 'sonnet' })
  await waitFor(() => s.tab.posted.filter((m) => m.t === 'chat-answer').length === 3)
  assert.equal(s.tab.posted.filter((m) => m.t === 'chat-answer')[2].text, 'turn 2: ok')
  s.tab.close()
  await waitFor(() => s.children.every(exited))
})

test('a bad selection or a file outside the project is refused before anything runs', async () => {
  const s = serve({ rel: undefined })
  s.handle(START)
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  assert.match(s.tab.posted.find((m) => m.t === 'chat-end').message, /files of the project/)
  const t = serve()
  t.handle({ ...START, sel: { startLine: 1, text: 'x'.repeat(qc.MAX_TARGET_CHARS + 1) } })
  await waitFor(() => t.tab.posted.some((m) => m.t === 'chat-end'))
  assert.match(t.tab.posted.find((m) => m.t === 'chat-end').message, /at most 20,000/)
  assert.equal(s.calls.length + t.calls.length, 0)
})

test('a turn that fails is an error answer; the chat goes on', async () => {
  const s = serve()
  s.handle({ ...START, question: 'FAIL please' })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-answer'))
  assert.deepEqual(s.tab.posted.find((m) => m.t === 'chat-answer'), { t: 'chat-answer', id: 1, text: 'API Error: overloaded', proposal: null, error: true })
  s.tab.close()
  await waitFor(() => exited(s.children[1]))
})

test('claude crashing ends the chat with its stderr', async () => {
  const s = serve()
  s.handle({ ...START, question: 'CRASH' })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  const end = s.tab.posted.find((m) => m.t === 'chat-end')
  // The project's location is cut out (the page may be a browser view).
  assert.match(end.message, /exited with code 3: fake claude: boom in <project>$/)
  assert.equal(qc._pluginChats.running, 0)
  // A follow-up to an ended chat is told so.
  s.handle({ t: 'chat-say', id: 1, question: 'hello?' })
  assert.match(s.tab.posted.at(-1).message, /has ended/)
})

test('a turn past its deadline ends the chat and kills claude', async () => {
  const s = serve({ limits: { turnMs: 300 } })
  s.handle({ ...START, question: 'HANG' })
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  assert.match(s.tab.posted.find((m) => m.t === 'chat-end').message, /did not finish/)
  await waitFor(() => exited(s.children[1]))
})

test('an idle chat ends after its limit', async () => {
  const s = serve({ limits: { idleMs: 200 } })
  s.handle(START)
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  const end = s.tab.posted.find((m) => m.t === 'chat-end')
  assert.equal(end.error, false)
  assert.match(end.message, /idle/)
  await waitFor(() => exited(s.children[1]))
})

test('the tab closing kills the chat; a new chat in the same tab ends the old one', async () => {
  const s = serve()
  s.handle({ ...START, question: 'HANG' })
  await waitFor(() => s.calls.length === 2)
  s.handle({ ...START, id: 2, question: 'HANG' })
  await waitFor(() => s.calls.length === 3)
  await waitFor(() => exited(s.children[1]))
  assert.equal(exited(s.children[2]), false)
  assert.equal(qc._pluginChats.running, 1)
  s.tab.close()
  await waitFor(() => exited(s.children[2]))
  assert.equal(qc._pluginChats.running, 0)
})

test('at most MAX_CHATS chats for the plugin, every tab together', async () => {
  const a = serve({ limits: { maxChats: 1 } })
  a.handle({ ...START, question: 'HANG' })
  await waitFor(() => a.calls.length === 2)
  const b = serve({ limits: { maxChats: 1 } })
  b.handle(START)
  await waitFor(() => b.tab.posted.some((m) => m.t === 'chat-end'))
  assert.match(b.tab.posted.find((m) => m.t === 'chat-end').message, /already run/)
  assert.equal(b.calls.length, 0)
  a.handle({ t: 'chat-close', id: 1 })
  await waitFor(() => exited(a.children[1]))
  assert.equal(qc._pluginChats.running, 0)
})

test('endAll (the plugin stopping) ends every chat and frees its slot', async () => {
  const s = serve()
  s.handle({ ...START, question: 'HANG' })
  await waitFor(() => s.calls.length === 2)
  assert.equal(qc._pluginChats.running, 1)
  qc.endAll()
  assert.equal(qc._pluginChats.running, 0)
  await waitFor(() => exited(s.children[1]))
})

test('messages that are not chat-* are left to the other handlers', () => {
  const s = serve()
  assert.equal(s.handle({ t: 'open' }), false)
  assert.equal(s.handle(null), false)
  assert.equal(s.handle({ t: 'chat-close', id: 9 }), true)
})

test('the help probe runs from a neutral folder, not the project', async () => {
  qc._helpChecks.clear()
  const cwds = []
  const inner = makeSpawn().spawn
  await qc.checkClaude((argv, o) => (cwds.push(o.cwd), inner(argv, o)), FAKE, '/project/x')
  assert.deepEqual(cwds, [os.tmpdir()])
})

test('the help probe: a non-zero exit and a timeout reject, and are not cached', async () => {
  qc._helpChecks.clear()
  const exiting = () => ({ onData() {}, onStderr() {}, onExit: (fn) => setImmediate(() => fn({ code: 2 })), end() {}, kill() {} })
  await assert.rejects(qc.checkClaude(exiting, '/x/claude', '/p'), /exited with code 2/)
  assert.equal(qc._helpChecks.size, 0)
  qc._helpChecks.clear()
  let exitFn
  let killed = false
  const hanging = () => ({ onData() {}, onStderr() {}, onExit: (fn) => (exitFn = fn), end() {}, kill: () => ((killed = true), exitFn({ code: null })) })
  await assert.rejects(qc.checkClaude(hanging, '/x/claude', '/p', { timeoutMs: 30 }), /did not answer/)
  assert.equal(killed, true)
  assert.equal(qc._helpChecks.size, 0)
})

test('a chat ends when the init line lists a tool beyond Read, Grep, Glob', async () => {
  const s = serve({ env: { FAKE_CLAUDE_TOOLS: 'Read,Grep,Glob,Bash' } })
  s.handle(START)
  await waitFor(() => s.tab.posted.some((m) => m.t === 'chat-end'))
  const end = s.tab.posted.find((m) => m.t === 'chat-end')
  assert.equal(end.error, true)
  assert.match(end.message, /beyond Read, Grep and Glob/)
  await waitFor(() => exited(s.children[1]))
  assert.equal(qc._pluginChats.running, 0)
})
