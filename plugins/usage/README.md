# Usage (cockpit.usage)

Claude Code spend and token usage, computed from Claude Code's own transcripts, plus the rate-limit
windows. Shipped with cc-cockpit and built on the public plugin API only.

- Slot **usage-meter** in the top bar: today's spend (`$4.20 today`) and, when the app reports it, the
  5-hour window (`5h 42%` with a bar), in the warning colour from the warn setting. A click shows the
  Usage panel.
- Panel **Usage** (right zone): Today / 7 days / 30 days; the total cost and the input, output and
  cache tokens; by project (from each message's cwd), by model, the top sessions (titled by their
  first prompt; one whose tab is open in this window selects it on a click); the rate-limit windows
  with their reset times ("not available" on an app without `ctx.sessions.rateLimits`).
- App settings: warn threshold (% of the 5-hour window, default 80), projects counted (all, or this
  project's folder only), how often to read new transcript lines (default 60 s; also after a Claude
  turn in the window ends, and on the panel's refresh).

Money is **API-equivalent**: what Anthropic's API would bill for the tokens at list prices
(`dist/lib/prices.js`, with its source date). A subscription is not billed per token. A model the
table does not know (or `<synthetic>`) has its tokens counted and its cost left out, never guessed.

How it reads: `~/.claude/projects/*/<session>.jsonl` and the subagents' `<session>/subagents/*.jsonl`
(`$CLAUDE_CONFIG_DIR` when set). Each message is counted once by `message.id` + `requestId`. Reading is
incremental (per file a byte offset, size, inode and head bytes; a shrunk or rewritten file is read
again, the message keys keep that from double counting), streamed, with a CPU budget, and only lines
containing `"usage"` are parsed. One window scans for all of them: a lease in `ctx.appStorage` picks
it, its offsets are saved in `ctx.appDataDir/scan-state.json`, and the aggregate (30 days by local
day, project, model and session) is published in `ctx.appStorage` for the other windows to read.

Tests: `node --test plugins/usage/test/` (part of `npm run test:plugins`).
