---
worth: after the team experiment
where: src/main/plugins/host-api.ts:233
added: 2026-11-13
---
# plugin tab opens and sends: the caps must be the person's setting, per plugin

`ctx.sessions.open` allows a plugin `MAX_OPENS_PER_WINDOW` (5) opens per `OPEN_WINDOW_MS` (60 s) per window, and
`ctx.sessions.send` `MAX_SENDS_PER_WINDOW` (30) a minute. Both are constants. The team experiment
(`~/Projects/team-experiment`, plugin `bronos.team`) hires a planning team of 6 at once and the sixth waited a
minute; a build team (devs, QA, reviewer) is larger and chats more. A fixed number cannot fit both a plugin that
opens a tab per click and one whose job is running a team.

Direction (agreed with Oleg during the run):
- A per-plugin override of both caps, default unchanged (5 opens, 30 sends a minute), set by the person in
  Settings › Plugins or with `ccc` (e.g. `ccc plugin limits <id> opens=20 sends=60`).
- The person's alone: never in plugin.json or the plugin's own settings (`ccc plugin config` runs from a Claude tab).
  The `ccc` write is shell-only like `ccc web`: in `HOST_ONLY_COMMANDS` (`shared/protocol.ts`), refused for any caller
  with a token (every cockpit tab, Claude tabs included), so a prompt-injected Claude cannot raise its own team's caps.
  Reading the limits is allowed from a tab (a lead can see why it waits).
- Consider a total cap on open tabs per plugin beside the rate: the rate slows a runaway loop, the total bounds the
  processes (e.g. a team plugin at 20 opens a minute, at most 15 open).
- Settle the numbers from the experiment's `runs/*/messages.jsonl` (team sizes, opens and sends per minute).
- The guide (`ccc guide api`, sessions.open "At most 5 a minute", sessions.send) changes in the same change.
