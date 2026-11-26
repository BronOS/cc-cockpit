#!/usr/bin/env node
// The Ask gate (shared tasks 01; shared/design.md §5, decisions D2, D11, D12, D14): real `claude` proves what main's Ask
// argv (src/main/ask/ask-argv.ts) relies on and no unit test can, since a unit test runs the fake `claude`:
//
//   1. guest mode (D12) has no tools at all and runs no hooks: the stream's init line lists no tool and no MCP server,
//      and none of the project's hooks ran;
//   2. owner mode (D2) is a regular session: the same project hooks DO run (else check 1 proves nothing: hooks that
//      never fire in this setup would pass it too);
//   3. a kept session resumes (D14): `-p --resume <id>` from the same folder recalls the first question.
//   4. A hand step, printed at the end: `claude --resume <id>` in a terminal at that folder opens the conversation
//      (what Continue in a tab does). Not automated: it needs a terminal and a person.
//
// It uses the real login of whoever runs it and spends one haiku turn per run (four in all). It never touches
// ~/.claude's settings: the hooks live in a temp folder's .claude/settings.json and settings.local.json (the project
// layers), which is where a document's folder would put them. Usage: node scripts/ask-guest-check.mjs [claude]
// Exits 0 when every check passed; 1 when `claude` is missing, a flag is missing from `claude --help`, a run gives
// no init line, or any check fails (never a silent pass).
//
// The flags are written out here (a .mjs cannot import the TS module); src/main/ask/ask-argv.ts must stay the same,
// and test/unit/ask-argv.test.ts compares the two lists with this file's text.

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- the argv (keep in step with src/main/ask/ask-argv.ts) -------------------------------------------------------
// ASK-GATE-OWNER-FLAGS-BEGIN
const OWNER_FLAGS = ['-p', '--permission-prompts', 'none', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
// ASK-GATE-OWNER-FLAGS-END
// ASK-GATE-GUEST-FLAGS-BEGIN
const GUEST_FLAGS = ['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', '']
// ASK-GATE-GUEST-FLAGS-END
const REQUIRED = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--tools', '--permission-prompts', '--input-format', '--output-format', '--verbose', '--include-partial-messages', '--model', '--resume']
const MODEL = 'haiku'
const RUN_TIMEOUT_MS = 180_000

const bin = process.argv[2] || 'claude'
const failures = []
const fail = (what) => {
  failures.push(what)
  console.log(`FAIL  ${what}`)
}
const pass = (what) => console.log(`ok    ${what}`)

// The env of a tab minus what would tie these runs to it (this script is often run from a cockpit tab): no tab token
// or socket, and no marker that says "inside Claude Code".
function runEnv() {
  const env = { ...process.env }
  for (const k of ['APP_TAB_TOKEN', 'CC_COCKPIT_SOCK', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k]
  return env
}

/** Runs `argv` in `cwd` with `stdin` written and closed; resolves { code, out, err } (never rejects). */
function run(argv, cwd, stdin, timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: runEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, out: '', err: String(e && e.message ? e.message : e) })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, out, err: err + String(e.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

/** One user message on stream-json input. */
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

/** The JSON lines of a stream (a line that does not parse is skipped). */
function events(out) {
  const list = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    try {
      list.push(JSON.parse(line))
    } catch {
      // Not JSON: a warning line.
    }
  }
  return list
}

const initOf = (evs) => evs.find((e) => e && e.type === 'system' && e.subtype === 'init')
const resultOf = (evs) => evs.find((e) => e && e.type === 'result')

/** A fresh project folder whose two settings layers each run three hooks that leave a file per event and layer. */
function projectWithHooks() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ask-gate-')))
  const marks = join(dir, 'marks')
  mkdirSync(marks)
  mkdirSync(join(dir, '.claude'))
  for (const layer of ['settings', 'settings.local']) {
    const hook = (event) => [{ matcher: '*', hooks: [{ type: 'command', command: `touch '${join(marks, `${layer}-${event}`)}'` }] }]
    const settings = { hooks: { SessionStart: hook('SessionStart'), UserPromptSubmit: hook('UserPromptSubmit'), PreToolUse: hook('PreToolUse') } }
    writeFileSync(join(dir, '.claude', `${layer}.json`), JSON.stringify(settings, null, 2))
  }
  return { dir, marks }
}

const marksIn = (marks) => (existsSync(marks) ? readdirSync(marks) : [])

async function main() {
  // 0. The binary and its flags.
  const help = await run([bin, '--help'], tmpdir(), '', 30_000)
  if (help.code !== 0) {
    fail(`${bin} --help did not run (${help.code === null ? help.err.trim() || 'not found' : `exit ${help.code}`})`)
    return
  }
  const has = (flag) => new RegExp(`(^|[\\s,])${flag.replace(/-/g, '\\-')}([\\s,=]|$)`, 'm').test(help.out)
  const missing = REQUIRED.filter((f) => !has(f))
  if (missing.length) {
    fail(`${bin} --help lacks ${missing.join(', ')}`)
    return
  }
  pass(`${bin} --help lists every flag Ask needs`)
  const version = await run([bin, '--version'], tmpdir(), '', 30_000)
  console.log(`      ${version.out.trim()}`)

  const folders = []
  try {
    // 1. Guest mode: no tools, no MCP servers, no hooks.
    const guest = projectWithHooks()
    folders.push(guest.dir)
    const g = await run([bin, ...OWNER_FLAGS, ...GUEST_FLAGS, '--model', MODEL], guest.dir, userLine('Reply with the single word: ok'))
    const gEvents = events(g.out)
    const gInit = initOf(gEvents)
    if (!gInit) fail(`guest: no init line (exit ${g.code}; ${(g.err || g.out).trim().slice(0, 300)})`)
    else {
      const tools = Array.isArray(gInit.tools) ? gInit.tools : ['(no tools field)']
      const servers = Array.isArray(gInit.mcp_servers) ? gInit.mcp_servers : ['(no mcp_servers field)']
      if (tools.length) fail(`guest: the init line lists tools: ${JSON.stringify(tools).slice(0, 300)}`)
      else pass('guest: the init line lists no tools')
      if (servers.length) fail(`guest: the init line lists MCP servers: ${JSON.stringify(servers).slice(0, 300)}`)
      else pass('guest: the init line lists no MCP servers')
    }
    if (!resultOf(gEvents)) fail(`guest: the turn did not end with a result line (exit ${g.code})`)
    const gMarks = marksIn(guest.marks)
    if (gMarks.length) fail(`guest: hooks ran: ${gMarks.join(', ')}`)
    else pass('guest: no hook ran')

    // 2. Owner mode: a regular session, so the same hooks run (the setup is live).
    const owner = projectWithHooks()
    folders.push(owner.dir)
    const o = await run([bin, ...OWNER_FLAGS, '--model', MODEL], owner.dir, userLine('Reply with the single word: ok'))
    const oEvents = events(o.out)
    if (!initOf(oEvents)) fail(`owner: no init line (exit ${o.code}; ${(o.err || o.out).trim().slice(0, 300)})`)
    const oMarks = marksIn(owner.marks)
    if (!oMarks.length) fail('owner: no hook ran (the gate setup is not live, so the guest check proves nothing)')
    else pass(`owner: the project hooks ran (${oMarks.sort().join(', ')})`)

    // 3. Resume (D14): the first run's session, resumed from the same folder, recalls its question.
    const resume = projectWithHooks()
    folders.push(resume.dir)
    const first = await run([bin, ...OWNER_FLAGS, '--model', MODEL], resume.dir, userLine('My first question: what is the capital of Peru? Answer in one word.'))
    const fInit = initOf(events(first.out))
    const sessionId = fInit && typeof fInit.session_id === 'string' ? fInit.session_id : ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      fail(`resume: the first run gave no UUID session_id (${JSON.stringify(sessionId)}; exit ${first.code})`)
    } else {
      pass(`resume: first run's session ${sessionId}`)
      const second = await run(
        [bin, ...OWNER_FLAGS, '--model', MODEL, '--resume', sessionId],
        resume.dir,
        userLine('What was my first question in this conversation? Quote it.')
      )
      const r = resultOf(events(second.out))
      const text = r && typeof r.result === 'string' ? r.result : ''
      if (/peru/i.test(text)) pass('resume: the resumed session recalls the first question')
      else fail(`resume: the answer does not recall it (exit ${second.code}): ${JSON.stringify(text.slice(0, 300))}`)
      console.log('')
      console.log('Hand step 4 (record the outcome in the report): in a terminal, run')
      console.log(`    cd '${resume.dir}' && claude --resume ${sessionId}`)
      console.log('and check that the conversation about Peru opens. Then delete the folder.')
      folders.pop() // kept for the hand step
    }
  } finally {
    for (const dir of folders) rmSync(dir, { recursive: true, force: true })
  }
}

main()
  .catch((e) => fail(`the gate threw: ${e && e.stack ? e.stack : e}`))
  .finally(() => {
    console.log(failures.length ? `\nASK GATE FAILED (${failures.length})` : '\nASK GATE PASSED')
    process.exit(failures.length ? 1 : 0)
  })
