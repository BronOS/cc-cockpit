#!/usr/bin/env node
// A fake `claude` for quick chat's tests (test/quick-chat.test.js): no network, no ~/.claude.
//
//   fake-claude.mjs --help        prints a help text that lists quick chat's flags; with
//                                 FAKE_CLAUDE_OLD=1 it lacks --restricted and --safe-mode
//   fake-claude.mjs <quick chat's argv minus the program>
//                                 refuses (exit 2) any other argv; then speaks stream-json on
//                                 stdin/stdout the way `claude -p` 2.1.323 does: an init line, and
//                                 per user line stream events, assistant messages and a result
//
// What a turn answers depends on the user text: CRASH exits 3 with a message on stderr, HANG never
// answers, FAIL ends the turn with an error result, PROPOSE reads a file (a tool_use) and answers
// with a `replacement` block; anything else answers "turn <n>: ok". FAKE_CLAUDE_LOG names a file each
// user text is appended to (one JSON string per line), so a test sees the exact prompt.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

if (args.includes('--help')) {
  const old = process.env.FAKE_CLAUDE_OLD === '1'
  const lines = [
    'Usage: claude [options] [command] [prompt]',
    '',
    'Options:',
    '  --include-partial-messages            Include partial message chunks as they',
    '  --input-format <format>               Input format (only works with --print)',
    '  --mcp-config <configs...>             Load MCP servers from JSON files',
    '  --model <model>                       Model for the current session.',
    '  --output-format <format>              Output format (only works with --print)',
    '  --permission-prompts <target>         Who answers permission prompts with',
    '  -p, --print                           Print response and exit',
    ...(old ? [] : ['  --restricted                          Restricted mode: removes the built-in', '  --safe-mode                           Start with all customizations']),
    '  --strict-mcp-config                   Only use MCP servers from --mcp-config,',
    '  --tools <tools...>                    Specify the list of available tools from',
    '  --verbose                             Override verbose mode setting from',
  ]
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(0)
}

const expected = ['-p', '--restricted', '--safe-mode', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-prompts', 'none', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model']
const models = ['haiku', 'sonnet', 'opus', 'fable']
if (args.length !== expected.length + 1 || expected.some((a, i) => args[i] !== a) || !models.includes(args.at(-1))) {
  process.stderr.write(`fake claude: unexpected argv ${JSON.stringify(args)}\n`)
  process.exit(2)
}

const session = 'fake-session'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, tools: process.env.FAKE_CLAUDE_TOOLS ? process.env.FAKE_CLAUDE_TOOLS.split(',') : ['Glob', 'Grep', 'Read'], mcp_servers: [], model: args.at(-1) })

let turn = 0
function textMessage(text) {
  out({ type: 'stream_event', event: { type: 'message_start', message: {} }, session_id: session, parent_tool_use_id: null })
  // In two deltas, as the real stream splits text.
  const half = Math.ceil(text.length / 2)
  for (const part of [text.slice(0, half), text.slice(half)]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } }, session_id: session, parent_tool_use_id: null })
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: session, parent_tool_use_id: null })
  out({ type: 'stream_event', event: { type: 'message_stop' }, session_id: session, parent_tool_use_id: null })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  const text = msg.message.content[0].text
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(text) + '\n')
  turn += 1
  if (text.includes('CRASH')) {
    process.stderr.write('fake claude: boom\n')
    process.exit(3)
  }
  if (text.includes('HANG')) return
  if (text.includes('FAIL')) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: overloaded', session_id: session })
    return
  }
  if (text.includes('PROPOSE')) {
    out({ type: 'stream_event', event: { type: 'message_start', message: {} }, session_id: session, parent_tool_use_id: null })
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${process.cwd()}/a.txt` } }] }, session_id: session, parent_tool_use_id: null })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1\tone' }] }, session_id: session, parent_tool_use_id: null })
    // A subagent's text must never reach the answer.
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT' } }, session_id: session, parent_tool_use_id: 't1' })
    textMessage('Here it is:\n\n````replacement\nNEW ```x```\nline 2\n````')
  } else {
    textMessage(`turn ${turn}: ok`)
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'final', session_id: session })
})
rl.on('close', () => process.exit(0))
