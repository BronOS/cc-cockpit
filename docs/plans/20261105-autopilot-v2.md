# Autopilot v2: core session options and takeover flag, then the plugin

External review: sol / high

## Overview
- Build Autopilot v2 as designed in `~/Projects/cc-cockpit-autopilot/docs/design-v2.md` (agreed with Oleg and
  reviewed on 2026-11-05). **Read it fully before any task**, with v1 `design.md` beside it for what v2 keeps
  (rules folder and editor, playbook frame, safety, dry run, log).
- **Part 1, core (this repo), app 0.11.0:** `ctx.sessions.open({ model, effort })` and `SessionInfo.typed`, the
  person's takeover of a tab, set from real input only and **enforced in main** (plugin sends refused, queued plugin
  texts dropped).
- **Part 2, the plugin (`~/Projects/cc-cockpit-autopilot`, local git, never pushed):** move to `inbox-feed` v2,
  rules in Inbox's condition format with a required `sources`, first rule wins, one session per item, merged updates
  into the item's tab, takeover, a cap on working sessions, a stop command, the v2 panel form, CLI and skill.
- The plan runs task by task with no human available. Each task names its repo and commands. When the design is silent
  on a detail, pick the simplest choice consistent with it, write it under the task as a ➕ or ⚠️ line, and go on.
  Never touch `~/.config/cc-cockpit-autopilot` (Oleg's real rules) or any real app data dir; tests use temp dirs.

## Context (from discovery)
- **Core, sessions.open**: plugin side `src/host/ctx/sessions.ts:165-176` (checks `cwd`, `prompt`, `focus`, then
  `call('sessions.open', …)`); main `src/main/plugins/host-api.ts:621` and `:1014` (`open`); Claude's argv in
  `src/main/tabs/claude-argv.ts` (`claudeArgv`, prompt as one positional argument, `--` handling); the tab is made in
  `src/main/tabs/tab-manager.ts`.
- **Core, input path**: the renderer's terminal `onData` → IPC → `TabManager.input(projectId, tabId, data)`
  (`src/main/tabs/tab-manager.ts:390`) → `pty.write`. `src/main/sessions/session-registry.ts` already reads each input
  chunk (`isAnswerKey`, `src/main/sessions/status-reducer.ts:117-125`, which notes focus reports `ESC [ I` arrive
  just by switching to a tab).
- **Core, send gate**: `src/main/sessions/send-gate.ts`: `send` (:173), `cancel` (:180), `onHook` delivers the queue
  head on `Stop` (:216); queued items are `QueuedText`. Every sender goes through `SessionRegistry.send(tabId, text)`:
  Discuss from `src/main/overlays/overlay-manager.ts:931` (deps wired in `src/main/index.ts:556`), plugins via host-api
  `deps.send` (`index.ts:885`), the test hook (`index.ts:1966`). `src/main/overlays/discuss.ts` only builds the text.
  The renderer's input reaches `sessions.userInput` only from the IPC handler (`index.ts:1773-1777`); the gate's own
  writes go through `tabs.input` (`index.ts:995`) and never through `userInput`.
- **Core, plugin CLI**: `CliCall` (`src/sdk/types.ts:401-411`) has `stdin`, `cwd`, `signal`, no caller tab; main already
  resolves the caller's tab from the `ccc` token (`ccc session note`, `session-registry.ts` addNote).
- **Core, types and docs**: `SessionInfo` in `src/sdk/types.ts:338` (copied by hand to `examples/plugin/sdk/types.ts`
  and pushed to `BronOS/cc-cockpit-plugin-example`), wire types in `src/shared/ipc.ts`; guide `src/cli/guide/api.md`
  (sessions section ~:200-245) with drift tests `test/unit/cli-guide.test.ts`; `docs/design.md`, `docs/features.md`.
- **Plugin v1** (`~/Projects/cc-cockpit-autopilot`, plain JS, `npm test` = `node --test test/`): `dist/host.js`,
  `dist/lib/{feed,match,rules,schema,state,prompt,manage,format,cli}.js`, `panels/{main.html,main.js,viewlogic.js}`,
  tests in `test/*.test.js` with `test/fakes.js`, `examples/`. 88 tests.
- **Copied from Inbox** (`~/Projects/cc-cockpit-inbox`): conditions and their tests (`dist/lib/rules.js` and its tests),
  item validation and the feed reader (`dist/lib/sources.js`, `dist/lib/feed.js`, `test/sources.test.js`: snapshot
  buffering, item/gone/sync via `useAll(FEED).on`), the condition-row editor of its settings page, `stdinDash` CLI pattern
  (`dist/lib/rulescli.js`), the `inbox-rules` skill as a model for `autopilot-rules`.

## Development Approach
- **testing approach**: Regular (code first, then tests), every task ends with its tests passing.
- Complete each task fully before the next; small, focused changes; dense why-comments (repo convention).
- **CRITICAL: every task MUST include new/updated tests** for its code; success and error cases.
- **CRITICAL: all tests must pass before starting the next task.** Core: `npm test`, `npm run typecheck`,
  `npm run lint`. Plugin: `npm test` in `~/Projects/cc-cockpit-autopilot`. Check the fail count by value, never by
  a grep that matches "fail 1" (a past release slipped this way).
- **CRITICAL: update this plan file when scope changes during implementation.**
- Backward compatible: plugin API stays `api: 1`; every core change is additive.

## Testing Strategy
- **Unit tests**: required in every task (vitest in core, `node:test` in the plugin).
- **E2E (core)**: Playwright via `npm run test:e2e` for the input path (typing, focus switch, clicks, wheel) and the argv;
  Task 6. Known pre-existing e2e failures: tab-command-overlays:51/:101, window-bounds ×2, project-color:63; any other
  failure is real.
- **Plugin**: the host is tested with `test/fakes.js` (fake ctx: services, sessions, storage); extend the fake for
  `sessions.list/onChange` with `typed`, `sessionId` and status changes.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- keep the plan in sync with the actual work

## Solution Overview
- **Core first**, so the plugin can rely on it; the plugin still runs on an older app (design: model/effort ignored
  with a note; see Tasks 11-12 for `typed`).
- **`typed` is a boolean always present on 0.11** (`typed: false` until the person types). This refines the design's
  `typed?: true`: an absent field then means "an app without takeover detection", and Autopilot delivers **no
  updates at all** on such an app (safe default) instead of risking a paste into a tab the person is using. Task 5
  writes this back into the design doc.
- **Enforcement in main**: plugin `send` rejects on a typed tab, and the moment `typed` turns true main drops that
  tab's queued **plugin** texts. Core's own texts (Discuss) are marked in the queue and kept: the person started them.
- **Plugin**: independent of Inbox (design decision 1); Inbox's code is copied, not imported.
- **Knowing the app's support** (plugins have no app version): takeover support = some `ctx.sessions.list()` entry has
  `typeof typed === 'boolean'`; no Claude tab yet = unknown, shown as "unknown until a Claude tab exists", and no
  deliveries either way until known. The same signal drives the "needs cc-cockpit 0.11" note for model/effort (an older
  host ctx drops them silently, `src/host/ctx/sessions.ts:168`).
- **The caller's tab for plugin commands**: new `CliCall.tabId` (Task 4), so `ccc autopilot stop <run>` is accepted
  only from that run's own tab, as the design says.
- **The person's own reply** (design: not delivered): no source states the account's identity, so Autopilot gets an
  optional project setting `myNames` (at most 10 names or addresses); empty means the check is off.

## Technical Details
- `src/shared/session-options.ts` (new): `SESSION_MODELS = ['haiku', 'sonnet', 'opus']`,
  `SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']`, and `checkSessionOptions(o)` returning an error
  string naming the field, used by both the host ctx and main (main re-checks: never trust the host).
- `claudeArgv` gains `model?`, `effort?` → `--model <alias>`, `--effort <level>`, placed before the prompt and its
  `--`; a resumed tab (`resumeId`) never gets them.
- `src/main/sessions/terminal-reports.ts` (new): `isPersonInput(chunk): boolean`, false when the chunk consists
  **only** of terminal reports: focus `CSI I` / `CSI O`; mouse SGR `CSI < Pb ; Px ; Py M|m` and X10 `CSI M` + 3 bytes;
  cursor position `CSI Pr ; Pc R`; device attributes `CSI ? … c` / `CSI > … c`; DECRPM `CSI ? Pd ; Ps $ y`; OSC
  replies `OSC … ST|BEL`. Anything else (keys, Enter, arrows, a paste, a key glued to a report) is person input.
- `SessionEntry.typed: boolean` in the registry; `SessionInfo.typed: boolean`; `QueuedText.origin: 'plugin' | 'core'`.
- Plugin rule shape, run record, queue, deliveries: exactly as design-v2 "Rules", "One session per item".

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo and in `~/Projects/cc-cockpit-autopilot`.
- **Post-Completion**: releases, the example repo push, Oleg's own rules migration and real-use testing.

## Implementation Steps

### Task 1: sessions.open takes model and effort [model: sonnet]

**Files:**
- Create: `src/shared/session-options.ts`
- Modify: `src/main/tabs/claude-argv.ts`, `src/host/ctx/sessions.ts`, `src/main/plugins/host-api.ts`,
  `src/main/tabs/tab-manager.ts` (pass-through), `src/sdk/types.ts` (the `open` options), `test/fixtures/bin/claude`
  (accept and echo both flags)
- Modify tests: the `claudeArgv` test, the host-api and host ctx sessions tests

- [x] verify under a PTY (`script -q /dev/null claude --help`) that the installed Claude accepts `--effort` and `--model`;
      record the finding in `claude-argv.ts` next to `PROMPT_AFTER_DOUBLE_DASH`
- [x] add `src/shared/session-options.ts` (constants + `checkSessionOptions`), imported by host ctx and main (never by
      `src/sdk/panel.ts`: the shared-chunk rule in CLAUDE.md)
- [x] `claudeArgv`: `--model` / `--effort` before the prompt; never on resume; argv only
- [x] host ctx `sessions.open` checks both (TypeError naming the field); main `open` re-checks and passes them to the
      tab; unknown values reject with an Error naming the field
- [x] tests: argv with each, both, neither; resume ignores them; a prompt starting with `-` still handled as before;
      ctx and main reject a bad model, a bad effort, a non-string, and accept each listed value
- [x] run `npm test`, `npm run typecheck`, `npm run lint` - must pass before Task 2

- ➕ `claude --help` (2.1.318, PTY) lists `--model <model>` and `--effort <level>` (low, medium, high, xhigh, max). `fable` is not in the model list (needs Oleg's approval). Also copied `src/sdk/types.ts` to `examples/plugin/sdk/types.ts` and updated the `api.md` guide; the example repo push is left for the release.

### Task 2: detect the person's input per tab (`typed`) [model: opus]

**Files:**
- Create: `src/main/sessions/terminal-reports.ts`, `test/unit/terminal-reports.test.ts`
- Modify: `src/main/sessions/session-registry.ts` (`userInput`), `src/shared/ipc.ts`, `src/sdk/types.ts`
  (`SessionInfo.typed: boolean`), wherever `SessionInfo` is built for plugins (`ctx.sessions.list/onChange`)

- [x] `isPersonInput(chunk)` per Technical Details; a chunk of several reports is still not person input
- [x] `userInput` sets `typed = true` on the first person-input chunk for that tab (only the IPC path calls it; the
      gate writes through `tabs.input`, `index.ts:995`: say so in a comment); never cleared while the tab exists; not
      persisted (a restored tab starts at false)
- [x] `SessionInfo.typed` reaches plugins through `list` and `onChange` (an `onChange` fires when it flips); existing
      tests comparing whole `SessionInfo` objects (`toEqual` in host-api, registry and e2e specs) get `typed: false`
- [x] mouse wheel: xterm's alternate-scroll turns a wheel into `CSI A` / `CSI B` arrow keys in alt-screen mode, which
      reach Claude's prompt as history keys. Count them as typing (they change what is in Claude's input box, so a
      later paste would be glued to it); write that decision as a comment and a test
- [x] tests: every report kind alone and repeated → false; a letter, Enter, an arrow key, a paste, Ctrl+C, a report
      glued to a letter → true; the registry flips once, stays true; a gate delivery does not set it; a new tab is false
- [x] run `npm test`, `npm run typecheck`, `npm run lint` - must pass before Task 3

- ➕ Also recognized as reports: DCS replies (`DCS … ST`, DECRQSS / XTVERSION; not in the design's list, the same kind) and the ANSI DECRPM form without `?`. Unterminated OSC/DCS (Alt+] / Alt+P) stay person input. Shift/Ctrl+F3 (`CSI 1 ; Pm R`) has the bytes of a cursor position report and reads as one; F3 changes nothing in Claude's input box (comment in `terminal-reports.ts`).
- ➕ `typed` survives a restart of the tab (`tabStarted` carries it like `sessionId`): the same tab, "never cleared while the tab exists"; a closed tab's id starting again is a new tab at false.
- ➕ `src/shared/ipc.ts` unchanged: the renderer's `SessionDetail` does not need `typed` (only plugins read it, through `sessionInfoOf`); no e2e spec compares whole `SessionInfo` objects. Guide text is left to Task 5 (no drift test needed it).

### Task 3: enforce the takeover in main [model: opus]

**Files:**
- Modify: `src/main/sessions/send-gate.ts`, `src/main/sessions/session-registry.ts` (`send(tabId, text, origin)`),
  `src/main/plugins/host-api.ts` (`sessions.send`, its `deps.send`), `src/main/index.ts` (deps wiring at :556, :885,
  :1966), `src/main/overlays/overlay-manager.ts` (Discuss sends with `origin: 'core'`, or through its deps type)
- Modify tests: `test/unit/send-gate.test.ts`, the session-registry, host-api and overlay-manager (Discuss) tests

- [ ] `QueuedText.origin` set from `SessionRegistry.send`'s new `origin` parameter: `'plugin'` from host-api,
      `'core'` from Discuss and the test hook
- [ ] a plugin send to a typed tab rejects with "the person is typing in this tab" and refunds the `sends` budget (the
      existing refund pattern at host-api :1003)
- [ ] when `typed` turns true, drop the tab's queued `plugin` items at once (never delivered on the next `Stop`); `core`
      items stay
- [ ] tests: queued plugin text dropped on the first person input and not delivered at the next `Stop`; Discuss text
      kept and delivered; a send after typed rejects and refunds; a send before typed delivers as before; the existing
      gate rules unchanged (waiting only, `/ ! # &` refused, one delivery per Stop)
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` - must pass before Task 4

### Task 4: plugin commands know the caller's tab (`CliCall.tabId`) [model: sonnet]

**Files:**
- Modify: `src/sdk/types.ts` (`CliCall.tabId?: string`), `src/main/socket/handlers.ts` (`pluginCliHandler`),
  `src/main/plugins/host-manager.ts` (`HostCliCall`), the host's CLI dispatch (`src/host/`, where handlers are called)
- Modify tests: `test/unit/plugin-cli.test.ts`, the host CLI dispatch tests

- [ ] main sets `tabId` from the caller's token when the caller is a Claude tab of this window (as `ccc session note`
      resolves it); absent for a shell tab, a command tab or outside a tab; never taken from the request's args
- [ ] the host passes it to the handler as `CliCall.tabId`
- [ ] tests: a Claude tab caller gets its id; a shell-tab or window-token caller gets none; a `tabId` in the request
      args is ignored
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` - must pass before Task 5

### Task 5: guide, SDK copy and core docs [model: sonnet]

**Files:**
- Modify: `src/cli/guide/api.md`, `examples/plugin/sdk/types.ts` (`cp src/sdk/types.ts examples/plugin/sdk/types.ts`),
  `docs/design.md`, `docs/features.md`, `~/Projects/cc-cockpit-autopilot/docs/design-v2.md`
- Modify tests: `test/unit/cli-guide.test.ts` if the drift test needs the new members

- [ ] guide: `sessions.open` `model` / `effort` (values, absent = default, an older app drops them); `SessionInfo.typed`
      (what counts as typing, what does not, the send refusal and the dropped queue); `CliCall.tabId`
- [ ] copy the SDK types to the example; `docs/design.md` sessions API, send gate and plugin CLI sections;
      `docs/features.md`
- [ ] design-v2: `typed` is a boolean on 0.11 and how Autopilot detects support; `myNames`; `CliCall.tabId` for stop
- [ ] run the drift tests and `npm test` - must pass before Task 6

### Task 6: e2e for typing and session options [model: sonnet]

**Files:**
- Create: `test/e2e/session-takeover.spec.ts`
- Modify: `test/fixtures/bin/claude` if it must print its argv

- [ ] a test plugin (or the test hook) opens a tab with `model` and `effort`; the fake claude sees both flags
- [ ] switching to the tab and clicking in it leave `typed` false; a wheel scroll follows Task 2's decision; typing a
      letter sets it
- [ ] a plugin send queued while busy is dropped when the person types, and Discuss still delivers
- [ ] run `npm run test:e2e` - only the known pre-existing failures may remain; `npm test` again - must pass before Task 7

### Task 7: Autopilot reads inbox-feed v2 [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-autopilot` from here on):**
- Modify: `plugin.json` (`uses: { "inbox-feed": 2, "jev": 1 }`, `collects: ["inbox-feed"]`), `dist/lib/feed.js`,
  `dist/host.js`
- Create: `dist/lib/sources.js` (adapted from Inbox's `dist/lib/sources.js`), `test/sources.test.js`
- Modify tests: `test/host.test.js`, `test/fakes.js`

- [ ] item validation copied from Inbox (caps, unknown fields dropped, a bad item logged and skipped)
- [ ] baseline and news per design-v2 "Sources": the first snapshot per source per host start and switch-on is a
      baseline; later `item` and `sync` compared with the in-memory `seen`; prune on `gone` and on a sync without the key
- [ ] events during a pending `snapshot()` buffered and applied after it; the latest copy of each item kept
- [ ] tests: baseline fires nothing; a later sync with a new item is news (the outage case); a read change (same rev)
      is not; buffered events applied in order; prune on gone
- [ ] run `npm test` - must pass before Task 8

### Task 8: v2 rule format with required sources [model: sonnet]

**Files:**
- Create: `dist/lib/conditions.js` (copied from Inbox's `dist/lib/rules.js` conditions), `test/conditions.test.js`
  (Inbox's tests copied)
- Modify: `dist/lib/schema.js`, `dist/lib/rules.js`, `dist/lib/format.js`, `examples/rules.json` (v2, every rule off)
- Modify tests: `test/rules.test.js`, `test/format.test.js`

- [ ] schema: `id`, `name`, `enabled`, `sources` (required: 1-20 ids by the app's `PLUGIN_ID_PATTERN`, at most 100
      characters, or exactly `["*"]`), `when` (0-20), `jev`, `hours`, `playbook` (required), `check` (≤ 500), `model`,
      `effort`, `onChange`, `limits`; `when` may be empty only with `jev` or as a sources-only rule
- [ ] a v1 entry (`match`, `triage`) is reported as "v1 rule: rewrite it" and never runs; other entries keep working
- [ ] `format` documents the v2 format (generated from the same constants, tested against them)
- [ ] tests: every field valid and invalid; missing sources; `["*"]` with another id refused; v1 entry flagged
- [ ] run `npm test` - must pass before Task 9

### Task 9: rule evaluation: first rule wins, Jev waits [model: opus]

**Files:**
- Modify: `dist/lib/match.js` (or a new `dist/lib/evaluate.js`), `dist/host.js`
- Modify tests: `test/match.test.js`, `test/hours.test.js`

- [ ] order per rule: enabled, sources, hours, field conditions, Jev; the first rule that holds is the item's rule;
      "also matched" from field conditions and cached Jev answers only
- [ ] Jev: the decision waits for the first pending answer (≤ 45 s), lower rules do not fire meanwhile; unavailable →
      retry after 10 minutes, logged; cache in `ctx.appStorage` `jv:` keys per question and rev, pruned
- [ ] tests: first wins and also-matched logged; a pending Jev answer holds a lower rule; unavailable retries, never
      falls through; also-matched makes no request; hours before Jev (no request outside hours)
- [ ] run `npm test` - must pass before Task 10

### Task 10: prompt frame and delivery text [model: sonnet]

**Files:**
- Modify: `dist/lib/prompt.js`
- Modify tests: `test/prompt.test.js`

- [ ] the frame uses `check`, adds the `onChange` lines and the stop line with the run id (`ccc autopilot stop <run>`)
- [ ] `deliveryText(item, rev, runId)` per design-v2 (fresh marker each time, marker look-alikes stripped, untrusted and
      read-only lines repeated); Tasks 11 and 12 use these two functions
- [ ] tests: markers fresh per prompt and per delivery; look-alikes stripped; no `check` → no check sentence; the v1
      injection fixtures still pass against both texts
- [ ] run `npm test` - must pass before Task 11

### Task 11: runs: one tab per item, cap and queue [model: opus]

**Files:**
- Create: `dist/lib/runs.js`, `test/runs.test.js`
- Modify: `dist/host.js`, `dist/lib/state.js`, `plugin.json` (project settings `maxRunning`, `myNames`),
  `test/fakes.js`, `test/manifest.test.js`

- [ ] item→tab records in `ctx.storage` (`tabId`, `sessionId`, rule, rev, openedAt, deliveries, stopped, runId)
      checked against `ctx.sessions.list()` on every `onChange` and before each decision; an in-memory **opening** entry
      from fire to `open()` resolving
- [ ] restart: re-adopt a record by `sessionId` on a restored tab as taken over; drop records with no tab
- [ ] slots (`maxRunning`, default 3, 1..10): held by opening entries and by tabs in `starting` or `working`;
      `waiting`, `needs-permission` and `ended` hold none (a burst must not open past the cap before tabs turn working).
      Queue in memory, one entry per key (newest rev), at most 50, re-checked from the top with the latest copy when a
      slot frees; limits as v1
- [ ] `ctx.sessions.open({ cwd, prompt, model, effort })` with the Task 10 frame; a tab that ends right after opening is
      logged with its rule; support detection per Solution Overview (the "needs cc-cockpit 0.11" note)
- [ ] tests: closed tab frees the item; a second rev while opening opens nothing; restored tab re-adopted; a burst of 5
      opens 3; the fourth queues; a finished or ended tab frees a slot; queue dedupe and re-check (gone, read, new rev)
- [ ] run `npm test` - must pass before Task 12

### Task 12: updates, takeover and stop [model: opus]

**Files:**
- Modify: `dist/lib/runs.js`, `dist/host.js`, `dist/lib/cli.js` (`stop <run>`)
- Modify tests: `test/runs.test.js`, `test/cli.test.js`

- [ ] while the item's tab exists, a new rev per design-v2's table: `onChange` false → log; true → one pending
      update (newest replaces older), delivered with `ctx.sessions.send(tabId, deliveryText(...))` only when the tab is
      waiting and `typed === false`
- [ ] no deliveries while support is unknown or absent (`typed` not a boolean), when `typed` is true (drop pending, log
      "taken over"), after 5 deliveries, after `stop`; a send rejected by main is logged and the pending update dropped
- [ ] own reply: the item's `from.name` or `from.address` matches `myNames` (case-insensitive) → logged "your reply",
      not delivered; empty `myNames` → no check
- [ ] `ccc autopilot stop <run>` accepted only when `CliCall.tabId` is that run's tab; refused otherwise (absent
      `tabId` included, an older app)
- [ ] tests: merge to one pending; delivered only when waiting; typed drops it; unknown support sends nothing; cap of
      5; stop from the run's tab works, from another tab or with no tab is refused; own reply skipped
- [ ] run `npm test` - must pass before Task 13

### Task 13: panel: v2 rule form, Running list [model: sonnet]

**Files:**
- Modify: `panels/main.html`, `panels/main.js`, `panels/viewlogic.js`, `dist/lib/manage.js`
- Modify tests: `test/panel.test.js`, `test/manage.test.js`

- [ ] rule form: sources picker first (providers `useAll` sees + "Any source"; unknown ids kept as "no such source
      here"), conditions editor copied from Inbox's settings page, hours, playbook picker, model and effort with
      "Default" first, check, onChange, limits; confirm a sources-only rule
- [ ] "outsiders can trigger this" flag from `sources` (`*` or a mail source); v1 rules shown as "rewrite it"; the
      "needs cc-cockpit 0.11" / "unknown until a Claude tab exists" note
- [ ] Running list (rule, since, pending update / taken over / stopped) and the queue
- [ ] keep v1's editor guarantees (hash check, never lose an entry, atomic write, render gate)
- [ ] tests: viewlogic for the new fields, flags, notes and lists; manage round-trips a v2 rule with unknown keys kept
- [ ] run `npm test` - must pass before Task 14

### Task 14: CLI and the autopilot-rules skill [model: sonnet]

**Files:**
- Modify: `plugin.json` (`stdinDash: true`, skill entry), `dist/lib/cli.js`
- Create: `skills/autopilot-rules/SKILL.md`
- Modify tests: `test/cli.test.js`, `test/manifest.test.js`

- [ ] `ccc autopilot rules|test|format` speak v2; JSON input as one argument or `-` with `stdinDash`
- [ ] skill modelled on Inbox's `inbox-rules`: write, test and explain rules and playbooks, the v1 → v2 mapping
- [ ] tests: each command; `-` reads stdin, no `-` never waits; manifest declares stdinDash and the skill
- [ ] run `npm test` - must pass before Task 15

### Task 15: Verify acceptance criteria [model: sonnet]
- [ ] every design-v2 decision (1-10) and the review fixes are implemented; list any gap as ⚠️ here
- [ ] core: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e` (known failures only)
- [ ] plugin: `npm test` with the fail count checked by value
- [ ] dry run against fake feeds: a Chat item fires once, its update merges, typing stops deliveries

### Task 16: [Final] Update documentation [model: sonnet]
- [ ] Autopilot `README.md`: v2 rules, the v1 → v2 mapping, `myNames`, the app 0.11 note for model/effort/takeover
- [ ] core `CLAUDE.md` if a new pattern appeared (`typed`, `origin` in the send gate, `CliCall.tabId`)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Releases** (on Oleg's word only): app 0.11.0 (tag, publish, cask, AUR files); the example repo gets the copied SDK
types and a tag plus marketplace PR. Autopilot stays local and unpublished until Oleg says otherwise.

**Migration and real use**: Oleg's own rules in `~/.config/cc-cockpit-autopilot` are v1; Claude in a tab rewrites them
with the `autopilot-rules` skill, with Oleg watching. Test on real items with the switch on for one rule first:
an update arriving mid-run, typing in the tab, a night run that finishes before morning.

**Manual checks**: that clicking and scrolling in an Autopilot tab do not take it over, that a pasted command does,
and that Discuss into an existing tab still works after the person typed there.
