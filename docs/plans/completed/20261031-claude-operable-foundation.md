# Claude-operable foundation (Plan B)

External review: sol / high

## Overview
- A fresh Claude session in any cc-cockpit tab must be able to operate the foundation without
  help from the user: run `ccc`, use the plugin API, write and debug a plugin, and use whatever
  installed plugins add (agreed with Oleg on 2026-10-30; Plan A did the core rule and moved
  accounts out of core).
- Plugins extend `ccc` with their own top-level subcommands and bring Claude skills (Oleg's
  explicit requirement). The proof is a built-in browser plugin: a panel with an embedded web
  view, settings, `ccc browser open <url|file>` and a skill, so Claude can show a design mock-up
  or a local dev server inside the app instead of an external browser.
- Decisions already made by Oleg (2026-10-31):
  1. Plugin commands use flat names (`ccc browser open …`); installing or linking a plugin
     whose command name is taken (by core or another plugin) is refused.
  2. Skills stay in the app data dir and are loaded only into the Claude sessions the app starts
     (`claude --plugin-dir`); nothing is written to `~/.claude`.
  3. The embedded web view is a core primitive (only main can create a `WebContentsView` safely:
     core rule 2), exposed as a `webview` panel kind plus `ctx.webview`; the browser plugin is
     built on it.
  4. This plan ships the foundation plus a minimal browser; a full browser (tabs, history,
     devtools) gets its own design session later.

## Context (from discovery)
- **CLI**: `src/cli/args.ts` (`parseArgs`, `USAGE`, closed `Command` union), `src/cli/client.ts`
  (socket client; app not running → silent exit 0), `src/cli/index.ts`. Inside a tab the token
  (`CC_COCKPIT_SOCK` env + tab token) selects the window; outside, `--project <path>` does.
- **Socket**: `src/main/socket/socket-server.ts`, `handlers.ts`, `transport.ts`.
- **Claude launch**: `src/main/tabs/claude-argv.ts` builds `['claude', '--settings', hooksPath, …]`;
  `tab-manager.ts` puts `<data>/bin` first on PATH so `ccc` resolves inside a tab;
  `src/main/hooks/hooks-file.ts` writes `<data>/hooks.json` at every start.
- **claude CLI** (checked with `claude --help`): `--plugin-dir <path>` loads a Claude Code plugin
  from a folder for this session only, repeatable; a folder of plugins loads each child.
  Verified 2026-10-31 with a probe plugin (`.claude-plugin/plugin.json` + `skills/<id>/SKILL.md`)
  and `claude -p --model claude-haiku-5-5 --plugin-dir <dir>`: the skill is listed as
  `<plugin name>:<skill id>` with its description.
- **Hooks**: `SessionStart` is already in `HOOK_EVENTS` (`src/shared/hooks.ts`), so every Claude
  tab already runs `ccc hook SessionStart`; its stdout becomes session context.
- **Manifest**: `src/shared/manifest.ts` (`PluginManifest`, `MANIFEST_SCHEMA`,
  `CONTRIBUTION_ID_PATTERN`; unknown properties tolerated, known ones strict) and
  `src/main/plugins/validate.ts` (duplicates, paths, chords, settings schemas).
- **Plugins**: `installer.ts` (git install, link, update, uninstall; `PluginSource` in
  `plugin-index.ts` is `git | linked`, no built-ins yet), `dev-watch.ts` (linked folders already
  reload on change), `plugin-log.ts`, `host-manager.ts`, `host-api.ts`, `src/host/ctx/index.ts`,
  `src/sdk/types.ts`. `plugins/hello` is the reference plugin (dist committed, linked by hand).
- **Web view precedent**: `src/main/overlays/electron-url-view.ts` is the only code that creates a
  `WebContentsView` (no preload, sandboxed, in-memory partition per window, permissions denied,
  downloads cancelled, other-site navigation to the system browser, app chords forwarded via
  `chordOfInput`); decisions live in `overlay-manager.ts`. `ccc overlay --html` serves a file read
  once in main from a privileged scheme. New schemes go into the single
  `registerSchemesAsPrivileged` call (`overlay-protocol.ts`, `plugin-protocol.ts`).
- **Docs**: `docs/design.md` §5 (plugin package/API), §6 (CLI table); `README.md`; `CLAUDE.md`.

## Development Approach
- **testing approach**: Regular (code first, then tests), as in Plan A
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility (existing manifests, CLI commands and hooks keep working)

## Testing Strategy
- **unit tests** (vitest): required for every task.
- **e2e tests** (Playwright, `npm run test:e2e`): every task that adds UI or a CLI path a user
  or Claude reaches gets an e2e spec in the same task. Tests use temp data dirs and the fake
  `claude` script; nothing touches the real data dir, keychain or `~/.claude`. The fake `claude`
  records its argv so tests can assert the `--plugin-dir` arguments.
- No test runs the real `claude`; the real-Claude acceptance run is in Post-Completion.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
Four parts, each usable alone, built in this order:

1. **Knowledge**: `ccc guide [topic]` prints docs bundled into the CLI (works with the app
   closed). Two ways in, so one failing does not leave Claude blind:
   - a SessionStart note: `ccc hook SessionStart` prints one line to stdout ("You are inside
     cc-cockpit; run `ccc guide` to learn the `ccc` CLI and the plugin API, and `ccc help` for
     the commands this project's plugins add"), produced locally in the CLI with no socket
     round trip and printed *before* the event is delivered (so the `index.ts` backstop exit
     cannot cut it off), never failing the hook;
   - a core Claude skill (`cc-cockpit:cc-cockpit`) loaded with `--plugin-dir`, whose body maps
     the guide topics.
   The opt-in "Install Claude skill" button from the first outline is dropped: with
   `--plugin-dir` proven, it would only matter for Claude sessions started outside the app,
   which Plan B does not target.
2. **Skills delivery**: main keeps a generated tree `<data>/claude-plugins/` with one Claude
   Code plugin per source: `core/` (the cc-cockpit skill) and `<pluginId>/` for each cockpit
   plugin that declares `contributes.skills`. A Claude tab starts with `--plugin-dir` for `core`
   and for each skill-bearing plugin enabled in that project. Running sessions keep what they
   started with (Claude loads plugins at launch); new tabs and restarts pick up changes.
3. **Plugin CLI**: `contributes.cli` declares top-level command names; the plugin implements
   them with `ctx.cli.register(name, handler)`. An unknown `ccc <name> …` is sent to main, which
   routes it to the owning plugin's host for the caller's project and prints the reply. Plus the
   dev loop: `ccc plugin new|link|unlink|list|logs`.
4. **Web view + browser**: a panel contribution with `"kind": "webview"` is a native
   `WebContentsView` that main lays over the panel's bounds, hardened like url overlays; local
   files are served read-only through a new `cc-preview` scheme. `ctx.webview` drives it. A
   built-in (bundled) plugin source makes the browser ship with the app.

Why this shape: every piece goes through main (main is the only authority), plugins stay
untrusted input (names, files, argv, output all bounded), and nothing outside the data dir is
written.

## Technical Details

**Manifest additions** (`src/shared/manifest.ts`, all optional; old manifests unchanged):
```jsonc
"contributes": {
  "cli":    [{ "name": "browser", "summary": "Show a page or a local file in the browser panel",
               "usage": "browser open <url|file> | browser url | browser reload",
               "stdin": false }],
  "skills": [{ "id": "browser", "dir": "skills/browser" }],
  "panels": [{ "id": "view", "title": "Browser", "kind": "webview", "defaultZone": "right" }]
}
```
- `cli[].name`: `^[a-z][a-z0-9-]{1,31}$`; reserved: every core command (`open`, `hook`,
  `session`, `overlay`, `sessions`, `notify`, `help`, `guide`, `plugin`) plus `app`, `config`,
  `version` kept free for core. At most 10 per plugin; a manifest with `cli` must have `main`.
  A name already owned by another plugin in the index → install/link/update refused with a
  message naming the owner. Clashes are also re-checked at every re-validation (start, dev
  reload of a linked plugin, an app update bringing a new bundled plugin), because a linked
  manifest can change and a bundled name can meet an existing owner: the winner is fixed
  (bundled first, then the earlier index entry), the loser gets `state: {ok: false, reason}`
  naming the clash and is not activated.
- `skills[].dir`: plugin-relative folder holding `SKILL.md` whose front matter is read by our own
  strict parser, not a YAML library: only `name: <value>` (equal to `id`) and `description:
  <value>` (≤ 1024 chars, one line) are accepted, any other key (e.g. `allowed-tools`, `model`,
  `hooks`) refuses the skill, since such keys change what Claude may do and a different parser
  could read the file differently from Claude. Copy limits: ≤ 50 files, ≤ 1 MiB total, regular
  files only (no symlinks, no dot-files), contained in the plugin folder; each file is
  `lstat`-checked again while it is copied (the folder can change between validation and copy).
  At most 10 skills.
- `cli[].stdin` (default `false`): only a command that declares it gets stdin. Reading stdin
  whenever it is not a TTY would hang a `ccc` spawned with an open but silent pipe (a tool
  runner's usual setup).
- `panels[].kind`: `"html"` (default, needs `entry`) or `"webview"` (no `entry`). The schema
  states it as a conditional (`kind: webview` → `entry` forbidden, otherwise `entry` required),
  not by dropping `entry` from `required`.

**Generated skills tree** (`<data>/claude-plugins/`, rebuilt at start and when the plugin set
changes; written to a temp dir then renamed per child so a starting tab never sees half a tree):
```
core/.claude-plugin/plugin.json          {"name":"cc-cockpit", "version":<app version>}
core/skills/cc-cockpit/SKILL.md
<pluginId>/.claude-plugin/plugin.json    {"name":"ccc-<pluginId with dots as dashes>", …}
<pluginId>/skills/<skillId>/…            copied from the plugin
```
The Claude plugin name must be unique: `a.b-c` and `a-b.c` both map to `ccc-a-b-c`, so a clash
gets a short hash of the id appended to the later one.
`claudeArgv` gains `pluginDirs: string[]`, each pushed as `--plugin-dir <dir>` (one argv element
each). `TabManager.start` is synchronous and restore spawns tabs at launch, while plugin data
loads asynchronously; so the tab manager is handed a ready list (a sync `pluginDirsFor(projectId)`
lookup kept by the skills service), and restore waits for the first tree build before spawning
Claude tabs.

**Plugin CLI routing**:
- CLI: a first argument that is not a core command (and passes the name pattern) becomes
  `{ kind: 'plugin', name, argv }`. The CLI first asks main for the command's spec (`summary`,
  `usage`, `stdin`); it reads stdin only when the spec says `stdin: true` and stdin is not a
  TTY. `--project <path>` may precede the name outside a tab.
- Sizes: the socket refuses any line over `MAX_LINE_BYTES` (1 MiB, `src/shared/protocol.ts:21`)
  in either direction. So stdin, stdout and stderr are each capped at 256 KiB measured *after*
  JSON encoding (the request line and the reply line stay well below 1 MiB); output past the cap
  is truncated with a marker, stdin past it is refused before sending.
- Timeouts: the CLI's `REPLY_TIMEOUT_MS` (10 s) would cut a plugin call short, so `plugin`
  commands wait 35 s (main's 30 s plus a margin) and `plugin link` waits with no timeout (a
  person is reading the confirm). The call gets the socket's `peerGone` signal, so a Ctrl+C on
  `ccc` cancels the host call and frees its in-flight slot.
- App not running: unchanged, every command exits 0 silently (Oleg's choice; a hook must never
  fail, and Claude only runs `ccc` inside a tab, where the app is running).
- Socket method `plugin.cli` → main resolves the window (token or `--project`, as today), finds
  the owning plugin, checks it is enabled and its host is running, and calls the host. Errors
  (unknown command, plugin disabled, not running) print a one-line reason on stderr, exit 1.
- Host: `ctx.cli.register(name, (argv, { stdin, cwd }) => Promise<{ stdout?, stderr?, code? }>)`;
  `name` must be declared (throws otherwise). Limits: 30 s timeout (exit 124 and a message),
  at most 4 in flight per plugin. A call is cancelled when the plugin's context is disposed
  (same path as `contextDisposed`) or the caller goes away (`peerGone`).
- `ccc help` with the app running appends the plugin commands of the caller's project
  (`summary`, `usage`); `ccc <name> --help` prints that plugin's `usage` without calling it.

**Dev loop** (`ccc plugin …`):
- `new <dir> [--id <id>] [--panel] [--cli <name>] [--skill]`: local (no app needed); scaffolds a
  plugin from a template bundled in the CLI (manifest, plain-JS `dist/host.js`, optional panel
  html, optional cli handler, optional skill, a README). Plain JS with no build step, on
  purpose: plugins ship built JS (design §5), a fresh scaffold must link and run without
  `npm install`, and the Task 11 walkthrough test needs no toolchain. TypeScript is described in
  the guide as an option. Refuses a non-empty dir.
- `link <dir>`: asks main to link the folder; main shows a native confirm in the caller's window
  ("Link plugin <name> (<id>) from <dir>? It runs with full access.") and on Allow links it and
  enables it for that project. A plugin persists across sessions and runs with full Node
  access, so a person confirms it, never a session alone. Deny is the default and the cancel
  button (a stray Enter cannot allow); the manifest `name` is shown with control characters
  stripped, the path is the resolved real path; one pending dialog per window and at most 3
  link requests a minute, the rest refused.
- `unlink <id>`, `list [--json]` (id, version, source, enabled here, state), `logs <id>
  [--follow]`: read locally from `<data>/logs/<id>.log` (the socket gives one reply per
  request, so it cannot stream); the id is checked against `PLUGIN_ID_PATTERN` before it
  becomes a path; `--follow` tails the file until Ctrl+C.

**Web view panel** (`ctx.webview`):
- The shell renders a webview panel as a thin toolbar (back, forward, reload, the current URL,
  "open in system browser") plus a placeholder; the renderer reports the placeholder's bounds
  and visibility; main moves the `WebContentsView` to match and hides it whenever the panel is
  hidden, collapsed, being dragged, or any shell layer covers it (overlay stack, menus,
  dialogs). The renderer is the reporter, main is the authority on which view belongs to which
  window and plugin.
- Hardening as `electron-url-view.ts`: no preload, sandboxed, `contextIsolation`, permissions
  denied, downloads cancelled; partition `webview-<projectId>-<pluginId>` in memory. Unlike an
  overlay, http(s) navigation stays in the view (it is a browser). Page-made navigation
  (`will-navigate`, `will-redirect`) may go only to http(s) or to the view's own `cc-preview`
  tokens; anything else is dropped. `window.open` and "open in system browser" go to the system
  browser for http(s) only; app chords still reach the app (`chordOfInput`).
- `ctx.webview.navigate(panelId, target)` accepts an http(s) URL or an absolute file path.
  A file is served through `cc-preview://<token>/…`: the token maps to the file's folder, read
  only, no traversal or symlink escape, no dot-files, ≤ 50 MiB per response; tokens die with
  the view. Also `back/forward/reload(panelId)`, `current(panelId)` → `{ url, title }`,
  `onNavigate(panelId, fn)`. `panelId` must be a declared webview panel (throws otherwise);
  `ctx.panels.post` on a webview panel throws (it has no page of ours to receive it).
- `cc-preview` is registered on the webview partition's own session
  (`session.fromPartition(…).protocol.handle`), not the global `protocol.handle` the existing
  schemes use (`overlay-protocol.ts:48,53` serve only the default session); the scheme itself
  still goes into the one `registerSchemesAsPrivileged` call. Per-session registration also
  scopes tokens to that view's partition.
- `cc-preview` threat model: the page can read its whole folder and, being in a browser view,
  could send it out. So: every `cc-preview` response carries a CSP that allows only the page's
  own token (`default-src 'self' 'unsafe-inline' data: blob:`, no network: no `connect-src`,
  `img-src`, `form-action` or `frame-src` to http(s)) plus `Referrer-Policy: no-referrer`; and a
  folder root of `/`, the home folder or any ancestor of the home folder is refused ("move the
  file into a project folder").
- `ctx.panels.show(panelId)`: reveals the panel's zone and selects it (needed so `ccc browser
  open` makes the page visible); works for both panel kinds.

**Built-in plugins**: `PluginSource` gains `{ kind: 'bundled'; path }` for plugins shipped in the
app resources (`plugins/browser` → `extraResources`). Indexed at every start, validated like any
other, never copied, cannot be uninstalled (only disabled per project), updated with the app.
A bundled plugin may set `"enabledByDefault": true` in the index entry (not the manifest, so a
git plugin cannot claim it); the browser does. The project record today keeps only
`enabledPlugins` (what is on, `project-settings-service.ts:58,79-84`), which cannot record "the
user turned a default-on plugin off"; it gains `disabledPlugins` (ids switched off): a plugin is
on when listed in `enabledPlugins`, or when it is `enabledByDefault` and not listed in
`disabledPlugins`. Old records load unchanged (missing list = empty).
Tests: with `CC_COCKPIT_TEST=1`, `CC_COCKPIT_NO_BUNDLED=1` turns bundled plugins off so existing
panel, zone and layout specs see no extra panel or host; the e2e harness sets it by default and
browser specs opt out. Ignored when packaged.

**Browser plugin** (`plugins/browser`, id `cockpit.browser`): one webview panel `view`, app
setting `home` (URL, optional), CLI `browser open <url|file>` (relative paths resolve against the
caller's cwd; shows the panel), `browser url`, `browser reload`, and skill `browser` telling
Claude to use `ccc browser open` for showing pages, mock-ups and local dev servers to the user.

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): code, tests and docs in this repo.
- **Post-Completion** (no checkboxes): the real-Claude acceptance run and manual UI checks.

## Implementation Steps

### Task 1: `ccc guide` with bundled topics [model: sonnet]

**Files:**
- Create: `src/cli/guide/` (topic markdown: `overview`, `cli`, `plugins`, `api`, `panels`,
  `settings-secrets`, `dev-loop`; later tasks add `webview`)
- Create: `src/cli/guide.ts`
- Modify: `src/cli/args.ts`, `src/cli/index.ts`, the CLI build config if raw imports need it
- Create: `test/unit/cli-guide.test.ts`

- [x] write the topic files from `docs/design.md` §3–6, `src/sdk/types.ts` and the hello plugin:
      what cc-cockpit is, every `ccc` command, how to write a plugin (manifest, host, panel,
      settings, secrets/OAuth, build, link), the full `ctx` reference
- [x] add `guide [topic]`: no topic → overview plus the topic list; unknown topic → usage error;
      runs without the app (pure CLI, no socket)
- [x] add `guide` to `USAGE`, and make `ccc <command> --help` print that command's usage line
- [x] write tests: every topic renders; unknown topic errors; drift guards (every `ctx` member
      in `src/sdk/types.ts` is named in the `api` topic; every command in `USAGE` is in `cli`)
- [x] run `npm test`, `npm run typecheck`, `npm run lint` - must pass before next task

### Task 2: Generated Claude plugin tree, core skill and SessionStart note [model: opus]

**Files:**
- Create: `src/main/claude-plugins/claude-plugins.ts` (build/refresh `<data>/claude-plugins/`)
- Create: `src/main/claude-plugins/core-skill.md`
- Modify: `src/main/tabs/claude-argv.ts`, `src/main/tabs/tab-manager.ts`, `src/main/index.ts`
- Modify: `src/cli/client.ts` (or wherever `ccc hook` runs) for the SessionStart note
- Create: `test/unit/claude-plugins.test.ts`; Modify: `test/unit/claude-argv.test.ts` (or the
  existing argv test file)
- (The fake `claude`, `test/fixtures/bin/claude`, already records its argv to
  `$FAKE_CLAUDE_LOG`; ⚠️ it did need one change: its parser now skips the `--plugin-dir` value, which it read as the prompt operand.)

- [x] write `core/` (plugin.json + `cc-cockpit` SKILL.md: description says it runs inside
      cc-cockpit and to use `ccc guide`; body maps the topics) at every start, atomically
- [x] `claudeArgv` takes `pluginDirs` and emits `--plugin-dir <dir>` pairs; the tab manager gets
      them from a sync `pluginDirsFor(projectId)` lookup (only `core` until Task 3); resume,
      restart and restore paths pass them too, and restore waits for the first tree build
      before spawning Claude tabs
- [x] `ccc hook SessionStart` prints the one-line note on stdout *before* delivering the event;
      produced locally (no socket), printed even when delivery fails, exit code still 0; no
      other event prints anything
- [x] write tests: tree layout and content; rewrite at start replaces stale files; argv shape
      (each dir one element, order stable, works with `--resume` and a prompt); a restored tab
      started at launch gets the dirs; the note is on stdout for SessionStart only, also when
      the app is not running, and the hook exits 0
- [x] e2e: a new Claude tab's recorded argv contains `--plugin-dir <data>/claude-plugins/core`
- [x] run unit + e2e tests - must pass before next task

### Task 3: Plugin-contributed skills [model: opus]

**Files:**
- Modify: `src/shared/manifest.ts`, `src/main/plugins/validate.ts`
- Modify: `src/main/claude-plugins/claude-plugins.ts`, `src/main/plugins/installer.ts`,
  `src/main/tabs/tab-manager.ts`
- Create: `test/fixtures/plugins/with-skill/`
- Modify: `test/unit/validate.test.ts` (or the manifest test file), `test/unit/claude-plugins.test.ts`

- [x] add `contributes.skills` to the manifest type and schema; a strict front-matter parser
      (own code, no YAML library) accepting only `name` (= id) and `description` (one line,
      ≤ 1024), any other key refused; file count/size limits, regular files only, no dot-files,
      containment
- [x] copy each skill-bearing plugin into `<pluginId>/` on install, link, update, dev reload and
      start, `lstat`-checking each file during the copy; remove it on uninstall/unlink; the
      Claude plugin name is `ccc-<id with dashes>`, made unique with a short id hash on a clash
- [x] a Claude tab gets one extra `--plugin-dir` per skill-bearing plugin enabled in its project
- [x] write tests: valid skill copied; each limit refused with a clear reason; `allowed-tools`
      (and any other extra key) refused; symlink and traversal refused, also a symlink swapped
      in after validation; uninstall removes the dir; disabled-in-project plugin not passed;
      two ids mapping to the same Claude plugin name stay distinct
- [x] e2e: link the fixture, enable it, open a Claude tab, assert its `--plugin-dir` is present
- [x] run unit + e2e tests - must pass before next task
- ⚠️ installer.ts and tab-manager.ts needed no change: the rebuild hooks onto the installer's existing `onChange` and the dev-watch `revalidate` callback in index.ts, and `pluginDirsFor` was already threaded through the tab manager. The skill walk and front-matter parser live in a new `src/main/plugins/skill-files.ts`, shared by validate.ts and the copy.

### Task 4: `contributes.cli` manifest and name-clash rules [model: sonnet]

**Files:**
- Modify: `src/shared/manifest.ts`, `src/main/plugins/validate.ts`, `src/main/plugins/installer.ts`
- Modify: `test/unit/validate.test.ts` (or the manifest test file), the installer test file

- [x] manifest `contributes.cli` with name pattern, reserved names, `stdin` flag, the
      per-plugin cap, and `main` required when `cli` is present
- [x] installer refuses a name owned by another indexed plugin at install, link and update
      (message names the owner)
- [x] clashes re-checked at every re-validation (start, dev reload of a linked plugin): fixed
      winner (bundled first, then the earlier index entry), loser gets `state: {ok: false,
      reason}` and is not activated
- [x] write tests: each pattern/reserved/cap refusal; `cli` without `main`; clash at install and
      link; a linked manifest edited to take an owned name loses on reload; the winner is
      stable across restarts
- [x] run unit tests - must pass before next task

### Task 5: Plugin CLI routing (`ccc <name>`, `plugin.cli`, `ctx.cli`) [model: opus]

**Files:**
- Modify: `src/cli/args.ts`, `src/cli/client.ts`
- Modify: `src/main/socket/handlers.ts`, `src/main/plugins/host-manager.ts`,
  `src/main/plugins/host-api.ts`, `src/host/ctx/index.ts`, `src/sdk/types.ts`, `src/shared/ipc.ts`
- Modify: `src/cli/guide/api.md`, `src/cli/guide/cli.md`
- Create: `test/fixtures/plugins/host-cli/`
- Create: `test/unit/plugin-cli.test.ts`, `test/e2e/plugin-cli.spec.ts`

- [x] CLI: unknown first argument → `plugin` command (argv passed verbatim); it fetches the
      command spec from main first and reads stdin only for `stdin: true` and a non-TTY stdin;
      `--project` before the name; `<name> --help` prints the declared usage; reply timeout
      35 s for plugin commands (not the 10 s `REPLY_TIMEOUT_MS`)
- [x] sizes: stdin, stdout and stderr each ≤ 256 KiB measured after JSON encoding, so request
      and reply lines stay under `MAX_LINE_BYTES`; output truncated with a marker, oversized
      stdin refused before sending
- [x] main: `plugin.cli` resolves window and owning plugin, checks enabled and running, calls
      the host with the 30 s timeout and the in-flight cap; cancels on context disposal and on
      `peerGone` (Ctrl+C frees the slot); prints stdout/stderr and exits with the plugin's code
- [x] host: `ctx.cli.register` (declared names only, one handler per name), handler errors
      become exit 1 with the message on stderr
- [x] `ccc help` lists the caller's project's plugin commands when the app is running
- [x] update the guide's `api` and `cli` topics (the Task 1 drift test requires it)
- [x] write tests: routing success, unknown name, disabled plugin, host down, timeout, output
      truncation at the encoded size (a reply full of characters JSON escapes), in-flight cap,
      cancellation on dispose and on peer gone, a `stdin: false` command run with an open,
      silent pipe returns without waiting
- [x] e2e: fixture plugin's `ccc demo echo a b` round-trips from inside a tab, exit code kept
- [x] run unit + e2e tests - must pass before next task
- ⚠️ `src/shared/ipc.ts` and `src/main/plugins/host-api.ts` needed no change: the shared limits and result shape live in a new `src/shared/plugin-cli.ts` (ipc.ts is the renderer contract; the CLI and host share nothing else from it), and the in-flight cap and cancellation sit in `HostManager.runCli` (HostApi serves host-to-main requests; this is main-to-host). `ctx.cli.register` stays local to the host: main routes by manifest. `ccc help` appends plugin commands only inside a tab.

### Task 6: Plugin dev loop (`ccc plugin new|link|unlink|list|logs`) [model: sonnet]

**Files:**
- Create: `src/cli/plugin-template/` (template files), `src/cli/plugin-new.ts`,
  `src/cli/plugin-logs.ts`
- Modify: `src/cli/args.ts`, `src/cli/client.ts`, `src/main/socket/handlers.ts`,
  `src/main/plugins/installer.ts` (link + enable from a confirmed request)
- Create: `test/unit/plugin-new.test.ts`, `test/unit/plugin-logs.test.ts`,
  `test/e2e/plugin-dev-loop.spec.ts`

- [x] `plugin new` scaffolds a plain-JS plugin with no build step (flags `--id`, `--panel`,
      `--cli`, `--skill`), refuses a non-empty dir, prints the next step (`ccc plugin link`)
- [x] `plugin link` → native confirm in the caller's window, Deny as default and cancel button,
      manifest name with control characters stripped, resolved real path shown; one pending
      dialog per window, ≤ 3 link requests a minute; Allow links and enables it for that
      project, Deny exits 1 with "declined"; no CLI reply timeout; a test hook answers the
      dialog in e2e
- [x] `plugin unlink`, `plugin list [--json]`; `plugin logs <id> [--follow]` reads
      `<data>/logs/<id>.log` locally (id checked against `PLUGIN_ID_PATTERN`), `--follow` tails
- [x] update the guide's `dev-loop` topic to the real commands
- [x] write tests: scaffold output validates with `validate.ts` and its `dist/host.js` loads in a
      host as is; each flag; refusal paths (non-empty dir, bad id, rate limit, second dialog);
      list JSON shape; logs refuses a path-like id; follow ends cleanly
- [x] e2e: `plugin new` → `plugin link` (confirm Allow) → plugin active in the project
      → edit → dev reload → `plugin logs` shows its log line
- [x] run unit + e2e tests - must pass before next task
- ⚠️ The dialog rules (sanitizing, one pending per window, 3 a minute) are in a new `src/main/plugins/link-request.ts`; `installer.ts` gained `inspectLink` (what a link would link, read-only) and `link(folder, expectedId)` (refuses a manifest swapped while the dialog was open). A folder that is already linked under the same id only gets enabled in the project. The rate counts only requests that reach a dialog (an invalid plugin or a refused second request uses none). The e2e answers the dialog with the new `answerLink` / `linkDialogs` test hooks.

### Task 7: Webview core: manifest kind, `cc-preview` scheme, view manager, `ctx.webview` [model: opus]

**Files:**
- Create: `src/main/webview/webview-manager.ts` (decisions, testable),
  `src/main/webview/electron-webview.ts` (adapter: the only new `WebContentsView` code),
  `src/main/webview/preview-protocol.ts`
- Modify: `src/main/overlays/overlay-protocol.ts` (`cc-preview` in the one
  `registerSchemesAsPrivileged` call), `src/shared/manifest.ts`, `src/main/plugins/validate.ts`
- Modify: `src/main/plugins/host-api.ts`, `src/host/ctx/index.ts`, `src/sdk/types.ts`
  (`ctx.webview`), `src/main/index.ts` (wiring, around the scheme setup at `index.ts:385`)
- Modify: `src/cli/guide/api.md` (+ a `webview` topic)
- Create: `test/fixtures/plugins/host-webview/`, `test/unit/webview-manager.test.ts`,
  `test/unit/preview-protocol.test.ts`

- [x] manifest `panels[].kind` as a schema conditional: `webview` forbids `entry`, `html` (the
      default) requires it; old manifests validate unchanged
- [x] webview manager: one hardened view per webview panel per window, created on first use,
      destroyed with the window or the plugin's deactivation; bounds and visibility are inputs
      (a test seam here, wired to the renderer in Task 8); page-made navigation only to http(s)
      or the view's own tokens; `window.open` to the system browser for http(s) only
- [x] `cc-preview` serving, registered on the view partition's own session
      (`session.fromPartition(…).protocol.handle`): token → folder, read-only,
      traversal/symlink/dot-file refusal, size cap, content types, a no-network CSP and
      `Referrer-Policy: no-referrer` on every response; a root of `/`, the home folder or an
      ancestor of it refused; tokens revoked with the view
- [x] `ctx.webview.navigate/back/forward/reload/current/onNavigate`, checked against the calling
      host's declared webview panels; `ctx.panels.post` on a webview panel throws
- [x] update the guide's `api` topic and add a `webview` topic (drift test)
- [x] write tests: navigate targets (http, https, absolute file, relative refused, other
      schemes refused, a file directly under the home folder refused); preview traversal and
      symlink escapes; CSP and referrer headers present on every response; page navigation to
      `file:` or another token dropped; undeclared panel; `post` to a webview panel throws;
      teardown on deactivate and window close; schema conditional (webview with `entry`, html
      without)
- [x] run unit tests, typecheck, lint - must pass before next task
- ⚠️ Decisions: the webview teardown rides the host's `plugin.disposed` event (now also sent when the ctx called `ctx.webview.navigate`) plus `HostApi.dispose` and the window close; `back/forward/reload` before the first navigate are no-ops and `current` is `{ url: '', title: '' }`; `ctx.webview.navigate` is capped at 60 a minute per plugin (refunded when refused); besides the plan's root rule, files inside a dot-folder directly under home (`~/.ssh`, `~/.config`) and dot-files are refused, and a view keeps at most 32 folder tokens. Chords typed into a view go to the overlay keys only (`overlays.handleChord`); forwarding app chords to the shell needs the renderer and is left to Task 8. Sub-frames may navigate anywhere but `file:` and other views' tokens; the main frame follows the plan's http(s)-or-own-token rule (`will-frame-navigate` + `will-redirect`).

### Task 8: Webview panel in the shell: toolbar, bounds, cover rules, `ctx.panels.show` [model: opus]

**Files:**
- Modify: `src/renderer/` panel host (webview toolbar + placeholder, bounds/visibility reports),
  `src/preload/`, `src/shared/ipc.ts`
- Modify: `src/main/webview/webview-manager.ts`, `src/main/plugins/host-api.ts`,
  `src/host/ctx/index.ts`, `src/sdk/types.ts` (`ctx.panels.show`), `src/cli/guide/api.md`
- Modify: `src/main/layout/layout-service.ts` (around `:258`, where panel placement is decided,
  for `show` and the webview panel kind)
- Create: `test/e2e/webview-panel.spec.ts`; Modify: `test/unit/webview-manager.test.ts`

- [x] the shell renders a webview panel as toolbar (back, forward, reload, URL, open in system
      browser, http(s) only) plus a placeholder whose bounds and visibility it reports to main
      (throttled)
- [x] main hides the view while the panel is hidden/collapsed/dragged or a shell layer covers
      it (overlay stack, menus, dialogs) and shows it again after; main checks the report
      comes from the window that owns the panel
- [x] `ctx.panels.show(panelId)` reveals the zone and selects the panel (both panel kinds)
- [x] update the guide's `api` topic for `ctx.panels.show` (drift test)
- [x] write tests: cover/hide state machine; reports from another window ignored; show on an
      undeclared panel throws
- [x] e2e: fixture navigates its webview to a local html file with a css file next to it; the
      page renders with the css; an overlay opening hides the view and closing shows it again;
      `ctx.panels.show` reveals a collapsed zone
- [x] run unit + e2e tests - must pass before next task
- ⚠️ Decisions: the renderer reports `{ bounds, visible }` per webview panel (`webviews.placement`, visibility at once, bounds at most once a frame: `placement-reporter.ts`); `visible` is false while the placeholder is unmounted, under an inert subtree (settings, overlay, close dialog) or while any shell layer is up (`shell-layers.ts`: a count held by the palette, the menus, the dialogs and a splitter drag, not a per-element overlap test). main adds the window's overlay stack itself (`setWindowCovered`, fed from `overlays.updated`) and hides a window's views when its page reloads. The router only passes a report on for a webview panel of the sender's project (`LayoutService.webviewPanel`), keyed by the sender's window. `ctx.panels.show` is fire-and-forget like `badge` (a refusal is logged); "selects" means open in an expanded zone (a zone has no selected panel). The toolbar's URL is read-only and its system-browser button reuses `app.openExternal` (http(s) only). Carried over from Task 7: an app chord typed into the page (with Cmd, Ctrl or Alt; not the overlay keys) is resolved by main and sent as `commands.trigger`, which the page runs through the same modal gate as its own keys. The unit tests are in a new `test/unit/webview-panel.test.ts` rather than `webview-manager.test.ts`.

### Task 9: Bundled plugin source [model: sonnet]

**Files:**
- Modify: `src/main/plugins/plugin-index.ts`, `src/main/plugins/installer.ts`,
  `src/main/index.ts`, `electron-builder.yml`, `package.json` (build script for bundled plugins)
- Modify: `src/main/settings/project-settings-service.ts` and the project record type
  (`disabledPlugins`), `src/main/projects/registry.ts` if the record shape lives there
- Modify: `src/renderer/settings/` plugins page (bundled: no Uninstall, shows "built in")
- Modify: `test/unit/packaging-config.test.ts` (`extraResources`), the e2e launch helper
  (`CC_COCKPIT_NO_BUNDLED=1` by default)
- Create: `test/unit/bundled-plugins.test.ts`

- [x] `PluginSource` `bundled` read from the app resources dir (dev: repo `plugins/<name>`
      listed in a fixed allowlist), indexed and validated at every start, never copied
- [x] `enabledByDefault` in the index entry for bundled plugins only; a git or linked plugin
      cannot set it; the project record gains `disabledPlugins` so turning a default-on plugin
      off sticks (on = in `enabledPlugins`, or default-on and not in `disabledPlugins`); old
      records load unchanged
- [x] uninstall refused for bundled; update follows the app version
- [x] `CC_COCKPIT_NO_BUNDLED=1` (only with `CC_COCKPIT_TEST=1`, ignored when packaged) turns
      bundled plugins off; the e2e harness sets it by default, browser specs opt out
- [x] write tests: indexing, validation failure handling, default enablement, turning a
      default-on plugin off and back on survives a restart, uninstall refusal, a git manifest
      claiming `enabledByDefault` is ignored, the test switch is ignored without
      `CC_COCKPIT_TEST`
- [x] run unit tests and the full e2e suite - must pass before next task

### Task 10: Built-in browser plugin [model: sonnet]

**Files:**
- Create: `plugins/browser/` (`plugin.json`, `src/host.ts`, `skills/browser/SKILL.md`, built
  `dist/`, README)
- Modify: `package.json` (`build:browser`, included in `build`), the bundled allowlist
- Create: `test/e2e/browser-plugin.spec.ts`

- [x] manifest: webview panel `view` (right zone), app setting `home`, CLI `browser`, skill
      `browser`
- [x] host: `browser open <url|file>` (relative paths against the caller's cwd; shows the
      panel), `browser url` prints the current URL and title, `browser reload`; `home` loaded on
      first show when set
- [x] skill text: when to use it (show the user a mock-up, a local html file, a dev server)
      and the exact commands
- [x] write the e2e (opts out of `CC_COCKPIT_NO_BUNDLED`): from inside a Claude-tab shell,
      `ccc browser open ./mock.html` shows the panel with the page; `ccc browser url` prints it;
      the tab's argv has the browser skill dir; turning the browser off in the project hides it
      and removes its `--plugin-dir` from new tabs
- [x] run unit + e2e tests - must pass before next task
- ⚠️ `home` is not loaded on first show: the plugin API has no "panel shown" hook, so `activate` navigates the hidden view to it in every project window where the plugin runs, and the panel shows that page when first opened. A set `home` therefore makes its request at plugin start even if the panel is never opened (it is empty by default). Loading on first show needs a panel-visibility event in `ctx.panels`.

### Task 11: Guide-driven plugin acceptance test [model: sonnet]

**Files:**
- Modify: `src/cli/guide/plugins.md` (its walkthrough becomes the tested example)
- Create: `test/e2e/guide-walkthrough.spec.ts`

- [x] mark the walkthrough's code blocks in the `plugins` topic (file name in the fence info)
- [x] the spec extracts them from `ccc guide plugins` output only, writes them to a temp dir
      (plain JS, no build step), links (confirm Allow), enables, and checks the panel, a `ctx.cli` command and a
      skill dir all work; a guide edit that breaks the walkthrough fails the test
- [x] run unit + e2e tests - must pass before next task

### Task 12: Verify acceptance criteria [model: sonnet]
- [x] verify all requirements from Overview are implemented
- [x] verify edge cases are handled (clashes, limits, disabled plugins, app closed for `guide`
      and `plugin new`)
- [x] run full test suite: `npm test`
- [x] run e2e tests: `npm run test:e2e`
- [x] run `npm run typecheck` and `npm run lint`
- [x] verify test coverage with `npm run test:coverage` (new main modules covered; 84.04% statements overall, webview-manager 95.3%, preview protocol 93.4%, plugin-cli 93.0%, electron-webview.ts 0% by adapter-file convention)

### Task 13: [Final] Update documentation [model: sonnet]
- [x] `docs/design.md`: §5 manifest (`cli`, `skills`, panel `kind`), API table (`ctx.cli`,
      `ctx.webview`, `ctx.panels.show`), §6 CLI table (`guide`, `plugin …`, plugin commands),
      skills delivery, the SessionStart note, bundled plugins, `cc-preview`; Decisions log
      entries for Oleg's four picks and the dropped "Install Claude skill" button
- [x] `README.md`: browser plugin, `ccc guide`, dev loop
- [x] `CLAUDE.md`: new adapter file (`electron-webview.ts`), `cc-preview` in the scheme note,
      generated `<data>/claude-plugins/`, guide drift tests
- [x] move this plan to `docs/plans/completed/` (skipped - the harness moves the plan after all phases)

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Acceptance run with the real Claude** (the agreed Plan B test):
- in a fresh Claude tab in a scratch project, ask: "write a cc-cockpit plugin that shows the
  current git branch in a panel and adds `ccc branch`"; Claude may use only what it finds
  (`ccc guide`, the skill). Pass = it links a working plugin without hints from the user.
- ask Claude to "show me a quick html mock-up of a login card": it should write the file and
  run `ccc browser open`, and the page appears in the browser panel.
- confirm `claude --plugin-dir` loads both the core and the browser skill in the installed
  Claude version (skill names visible in `/skills` or the skills list).

**Manual UI checks**:
- the webview follows panel resize, zone moves, collapse, window resize and full screen; it
  never covers a menu, the overlay stack or a dialog
- app shortcuts work while the web view has focus
