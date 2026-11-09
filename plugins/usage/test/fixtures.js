'use strict'
// Fake Claude Code transcripts in a temp dir, for the usage tests. Nothing here reads the real
// ~/.claude: every test passes its own root (or CLAUDE_CONFIG_DIR) pointing at one of these.
// (node --test runs this file too; it has no tests of its own.)
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-test-'))
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true })
  return dir
}

function usage(u = {}) {
  return {
    input_tokens: 10,
    output_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    service_tier: 'standard',
    speed: 'standard',
    ...u
  }
}

/**
 * One assistant line per content block (as Claude Code writes them): `blocks` lines with the same
 * message id, request id and usage.
 */
function assistant({ id, req, model = 'claude-opus-5-5', ts, sessionId = 's1', cwd = '/work/alpha', u = {}, blocks = 1, sidechain = false }) {
  const lines = []
  for (let i = 0; i < blocks; i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        isSidechain: sidechain,
        message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text: `block ${i}` }], usage: usage(u) },
        requestId: req,
        timestamp: new Date(ts).toISOString(),
        sessionId,
        cwd
      })
    )
  }
  return lines.join('\n') + '\n'
}

function userPrompt(text, { ts = Date.now(), sessionId = 's1', cwd = '/work/alpha', meta = false } = {}) {
  return JSON.stringify({ type: 'user', isMeta: meta, isSidechain: false, message: { role: 'user', content: text }, timestamp: new Date(ts).toISOString(), sessionId, cwd }) + '\n'
}

/** `<config>/projects/<enc>/<session>.jsonl`, or the subagent file when `agent` is given. */
function transcriptPath(config, enc, session, agent) {
  const dir = path.join(config, 'projects', enc)
  if (agent) return path.join(dir, session, 'subagents', `agent-${agent}.jsonl`)
  return path.join(dir, `${session}.jsonl`)
}

function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, text)
}

module.exports = { tempConfig, usage, assistant, userPrompt, transcriptPath, append }
