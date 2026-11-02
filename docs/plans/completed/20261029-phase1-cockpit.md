# cc-cockpit phase 1: shell, Claude sessions, plugin host

External review: sol / high

## Overview
- Build phase 1 of cc-cockpit as agreed in `docs/design.md` (the source of truth; read it before
  any task). An Electron app: one window per project (folder), terminal tabs running `claude` or a
  shell, a core Claude status view across all windows, an overlay stack, and a plugin system
  (per-window plugin host, sandboxed panels, accounts, settings, themes, commands and keys), plus
  the `ccc` CLI and the `hello` reference plugin.
- Problem it solves: Claude Code sessions run in loose terminals with no shared view of which one
  needs you, and data sources (Jira, mail, PRs…) live elsewhere. The cockpit puts sessions,
  their status and plugin panels in one window per project.
- Integration: a clean break. New repo. The user's global
  Claude settings are never touched; the app passes its own `--settings hooks.json` to the
  `claude` processes it starts.
- Out of scope (design §1): every real data plugin, editor and file tree, drag-and-drop of panels,
  the cross-plugin export API, a plugin registry, binary downloads, Windows builds, sessions that
  outlive the app.

## Context (from discovery)
- Files/components involved: none yet. The repo holds `docs/design.md`,
  `CLAUDE.md`, `README.md` and `.gitignore` (already ignores `node_modules/ out/ dist/ release/ .vite/`).
- Related patterns found: the conventions in `CLAUDE.md` (restated under Development Approach).
- Dependencies identified: Electron, `electron-vite`, TypeScript, React, `xterm.js` (fit,
  web-links, unicode11 addons), `node-pty`, `@rjsf` (JSON-Schema forms; its validator is ajv),
  `electron-builder`, vitest, Playwright (Electron mode). Use the current stable versions at
  implementation time and pin them in `package.json`.

## Development Approach
- **testing approach**: Regular (code first, then tests in the same task)
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
- maintain backward compatibility (within the plan: later tasks must not break earlier tests)

**Project conventions (from `CLAUDE.md`; every task must follow them):**
- TypeScript throughout; React for the shell UI.
- Dense explanatory comments: say why, name the edge case or incident behind a check.
- Exec is argv-only, never through a shell (`spawn`/`execFile` without `shell: true`); untrusted
  text travels as one argument or on stdin.
- main is the only authority: renderers and plugin hosts ask, main decides which window/host is
  asking (from `event.sender`, the host's process, or the socket token). Never trust a project or
  tab id passed by a plugin or renderer.
- Never type into a Claude session unless its status is *waiting for input*.
- The CLI must never fail a Claude hook: when the app is not running it exits 0 silently.
- Tests use temp dirs and fakes (a fake `claude` script); nothing touches the real app data dir,
  `~/.claude` or the real OS keychain.
- Do not edit the `[model: x]` tags or the `External review:` line in this file.

## Testing Strategy
- **unit tests** (vitest, plain Node): required for every task. Electron-only or Electron-ABI
  modules (`node-pty`, `safeStorage`, `utilityProcess`, `BrowserWindow`, `protocol`) sit behind
  interfaces; unit tests use fakes and never import the real modules. `node-pty` is built for the
  Electron ABI and will not load in plain Node, so only Playwright exercises it.
- **e2e tests** (Playwright `_electron.launch`): the harness lands in Task 9, right after the first
  terminal UI. From then on every UI task adds its e2e cases in the same task. Each e2e test
  launches the app with `CC_COCKPIT_DATA_DIR=<temp dir>`, a fake secret store, and `PATH` pointing
  at `test/fixtures/bin/` where the fake `claude` lives.
- Commands: `npm test` (vitest), `npm run test:e2e` (build + Playwright), `npm run typecheck`,
  `npm run lint`.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview
- **Processes** (design §2): main owns windows, PTYs, the session registry, the store, accounts,
  the socket and plugin install. One renderer per project window (React shell, xterm.js per tab).
  One plugin host (`utilityProcess`) per project window runs that project's enabled plugins.
  Panels are sandboxed iframes connected to their plugin's backend by a `MessagePort` that main
  hands out.
- **Authority**: every request carries an implicit identity that main resolves itself: IPC →
  `event.sender` → window → project; plugin host → which host process → project; socket → tab
  token → tab → project (or `--project <path>` for callers outside a tab). Ids inside payloads
  are only looked up within that resolved scope.
- **Claude wiring**: main launches `claude --settings <data>/hooks.json` with `APP_TAB_ID`,
  `APP_TAB_TOKEN` and `CC_COCKPIT_SOCK` in the env. The hooks run `ccc hook <event>`, which
  forwards the hook's stdin JSON plus the token to main over the socket. A pure reducer turns hook
  events into tab status; a pure gate decides whether text may be typed into a tab.
- **Pure core, thin Electron edges**: status reducer, send gate and queue, layout state, manifest
  and settings validation, keybinding resolution, restore, socket protocol and CLI argument
  parsing are plain TypeScript modules with unit tests. Electron glue is thin and covered by e2e.
- **Order**: foundation (store, windows, PTY, tabs) → e2e harness → themes and commands → socket,
  CLI, Claude status → zones, overlays, Sessions panel, restore → plugins (manifest, install,
  host, ctx, panels) → accounts → settings UI → hello plugin → packaging.

## Technical Details

### Decisions made while planning (design §8 open points)
- **CLI name**: `ccc`.
- **Data dir**: Electron `app.getPath('userData')` for the app name `cc-cockpit`
  (`~/Library/Application Support/cc-cockpit` on mac, `$XDG_CONFIG_HOME/cc-cockpit` or
  `~/.config/cc-cockpit` on Linux). `CC_COCKPIT_DATA_DIR` overrides it. main must call
  `app.setPath('userData', dir)` **before** `app.requestSingleInstanceLock()` and before `ready`,
  otherwise Electron's own state and the single-instance lock leak into the real profile.
- **Hooks**: `PreToolUse` registered for every tool (matcher `*`) so the strip shows the current
  tool; `PostToolUse` only for `Edit|Write|MultiEdit|NotebookEdit`. `ccc hook` is
  fire-and-forget: connect and write with a 500 ms total cap, no wait for a reply, always exit 0.
- **Idle is not sendable.** After `SessionStart` the status is *idle*. Claude may still show the
  trust-folder dialog then, and a keystroke could answer it. Only *waiting for input* (after a
  `Stop` or an idle `Notification`) accepts sent text. `sessions.open({cwd, prompt})` passes the
  prompt as a positional argv argument to `claude`, never by typing it.
- **Default keybindings** (mac; on Linux `Cmd` = `Ctrl`; all overridable in settings):

  | Key | Command |
  |---|---|
  | `Cmd+T` | new Claude tab |
  | `Cmd+Shift+T` | new shell tab |
  | `Cmd+W` | close tab |
  | `Cmd+1`…`Cmd+9` | select tab 1…9 |
  | `Cmd+B` | toggle left zone |
  | `Cmd+J` | toggle bottom zone |
  | `Cmd+Shift+B` | toggle right zone |
  | `Cmd+,` | open settings |
  | `Cmd+Shift+P` | command palette |
  | `Cmd+O` | open folder (File menu) |
  | `Esc` | pop the top overlay (not a terminal overlay) |
  | `Cmd+Shift+W` | close the top overlay, including a terminal overlay |

### Data dir layout
```
<data>/
  app.json                     app settings, open-project list, active theme, key overrides
  projects/<projectId>.json    path, enabled plugins, chosen accounts, plugin settings, layout, tabs
  accounts.json                account records; secret fields stored encrypted (base64)
  plugins/<id>@<version>/      cloned plugin
  plugins.json                 installed plugins: id, version, source (git url+tag | linked path), state
  plugin-data/<projectId>/<pluginId>/   ctx.dataDir; storage.json = ctx.storage
  hooks.json                   generated at every start
  bin/ccc                      generated wrapper script
  app.sock                     CLI socket (or the short fallback, see below)
```
- `projectId` = first 16 hex chars of sha256 of the real (resolved) folder path.
- All JSON writes are atomic (write `<file>.tmp`, fsync, rename) and debounced (300 ms) so a crash
  keeps the last state. Every file carries `"schemaVersion": 1`.

### Socket
- Path: `$CC_COCKPIT_SOCK` → `<data>/app.sock`. If that path exceeds 100 bytes (macOS `sun_path`
  is 104 bytes, and test temp dirs are long), use `<os.tmpdir()>/ccc-<uid>/<sha256(dataDir)[0:12]>.sock`.
  The CLI computes the same path from the same inputs. File mode `0600`; the fallback lives in its
  own `0700` directory owned by the current uid (`os.tmpdir()` is shared on Linux), and main
  refuses to use an existing fallback dir owned by someone else or with a looser mode. On start, if the socket
  file exists and nothing answers, unlink it; if something answers, another instance owns it.
- Protocol: newline-delimited JSON. Request `{ "v": 1, "id": n, "token"?: string,
  "project"?: string, "cmd": string, "args": {...} }`; reply `{ "id": n, "ok": true, "result" }`
  or `{ "id": n, "ok": false, "error": string }`. Max line 1 MiB; longer lines close the connection.
- Token: 32 random bytes hex per tab, compared with `crypto.timingSafeEqual`. A request without a
  valid token may only use `open`, `notify`, `overlay`, `sessions` and must name `--project`.

### `ccc` wrapper and hooks.json
- `<data>/bin/ccc` (mode 0755): `#!/bin/sh` + `ELECTRON_RUN_AS_NODE=1 exec "<electron binary>"
  "<path to out/cli/index.js>" "$@"`, where the Electron binary is the running app's
  `process.execPath`; regenerated at every start (paths change between dev and packaged). PTY env prepends `<data>/bin` to `PATH` so Claude inside a tab can run `ccc`.
- `hooks.json` hook commands are shell strings run by Claude: `'<data>/bin/ccc' hook <Event>`
  with the path single-quoted (inner `'` escaped as `'\''`). Every hook sets `"timeout": 5`.
  Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (`*`), `PostToolUse`
  (`Edit|Write|MultiEdit|NotebookEdit`), `Notification`, `Stop`, `SessionEnd`.

### Tab status and session registry
- `TabStatus = 'starting' | 'idle' | 'working' | 'needs-permission' | 'waiting' | 'ended'`.
- Reducer (design §3): `SessionStart` → idle + store `session_id`; `UserPromptSubmit` → working +
  `lastPrompt`; `PreToolUse` → working + `tool = tool_name`; `PostToolUse` → working, add the
  changed file (`tool_input.file_path`, or `tool_input.notebook_path` for NotebookEdit);
  `Notification` → needs-permission or waiting (see Task 14 for how the kind is detected); `Stop`
  → waiting, clear `tool`; `SessionEnd` or PTY exit → ended.
- Registry entry: `{ tabId, projectId, windowId, kind, cwd, sessionId?, status, tool?,
  lastPrompt?, notes: string[], steps?: {done, total}, files: string[], queue: QueuedText[],
  exitCode? }`. main broadcasts a snapshot to every window on change (throttled to 10/s). A
  window gets full entries only for its own project's tabs; for other projects' tabs it gets only
  `{ tabId, projectName, status, tool }` (what the top strip needs), never prompts, notes or files.
- Hook payloads are untrusted-ish text (a token only proves which tab sent them): `lastPrompt`
  capped at 2 KiB, each note at 500 chars (20 notes), `tool` at 100 chars, files at 500 per tab.
  File paths are stored as reported and only displayed; anything that runs a command on them
  passes them after `--` (Task 20).

### Send-text gate
- `send(tabId, text)`: if status is `waiting` and the tab is not `delivering`, write
  `ESC[200~` + text + `ESC[201~` + `\r` to the PTY and set `delivering`; otherwise append to the
  queue. Strip every `ESC[200~`/`ESC[201~` from the text first (an embedded end marker would end
  the paste early and the rest would be typed as keys).
- `delivering` clears on the next `UserPromptSubmit` (or after 10 s, logged). On `Stop`, deliver
  only the queue head; the rest waits for later `Stop`s. Never deliver in `needs-permission`,
  `idle`, `starting` or `ended`. Queue items are cancellable by id.

### Plugin manifest (design §5)
- `id` must match `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$` before it is used in any path.
- `api` must be `1`; any other major is refused with a reason.
- Contribution ids are namespaced at runtime as `<pluginId>/<id>`.
- Account kinds: `token` lists `fields: [{ key, label, secret? }]`; `oauth` gives
  `authUrl, tokenUrl, scopes, clientId?, usePkce: true`; `cli` gives `check: argv`,
  `login: argv`, `installHint: string`.

### Plugin host RPC
- main ⇄ host over the `utilityProcess` parent port: `{ id, method, params }` /
  `{ id, result | error }` plus one-way events. The host's identity is the process main spawned
  for a window; nothing in a message names the project.
- Panels and html overlays get one `MessagePort` each: main creates a `MessageChannelMain`, sends
  one end to the host (tagged with plugin id and panel id) and the other to the renderer, which
  transfers it into the iframe with `postMessage(msg, '*', [port])` (sandboxed iframes have an
  opaque origin).

### Panel files
- Served by a privileged custom protocol `cc-plugin://<pluginId>/<path>`. Resolve the path inside
  the plugin's install dir and refuse anything that resolves outside it (`..`, symlinks out).
  Response CSP: `default-src 'none'; script-src cc-plugin://<pluginId>; style-src
  cc-plugin://<pluginId> 'unsafe-inline'; img-src cc-plugin://<pluginId> data:; font-src
  cc-plugin://<pluginId>`. Iframes use `sandbox="allow-scripts"`, never `allow-same-origin`.
  (Task 28 adds `connect-src cc-plugin://<pluginId>`, without which `default-src 'none'` would block
  a panel's `fetch` of its own files, plus `frame-src 'none'; form-action 'none'; base-uri 'none'`.)

## What Goes Where
- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase - code changes, tests, documentation updates
- **Post-Completion** (no checkboxes): items requiring external action - manual testing, changes in consuming projects, deployment configs, third-party verifications

## Implementation Steps

### Task 1: Scaffold the Electron + TypeScript + React project [model: sonnet]

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `electron.vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`
- Create: `src/main/index.ts`, `src/main/windows/create-window.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
- Create: `src/cli/index.ts`, `src/host/index.ts`, `src/sdk/index.ts`
- Create: `test/unit/smoke.test.ts`

- [x] set up electron-vite with main, preload and renderer entries plus two extra Node entries: `src/cli/index.ts` → `out/cli/index.js`, `src/host/index.ts` → `out/host/index.js`
- [x] add React to the renderer; a `createWindow()` helper in `src/main/windows/create-window.ts` that every window (picker, project) uses: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `will-navigate` and `window.open` denied; a strict CSP meta in `index.html`
- [x] add `node-pty` with an Electron-ABI rebuild in `postinstall` (`electron-builder install-app-deps` or `@electron/rebuild`) and mark it external in the main build of `electron.vite.config.ts` (a native module cannot be bundled); xterm.js and its fit, web-links and unicode11 addons
- [x] npm scripts: `dev`, `build`, `test`, `test:coverage` (`@vitest/coverage-v8`), `test:e2e` (runs `npm run build` first, so e2e always tests fresh `out/`), `typecheck`, `lint`; vitest runs only `test/unit/**`
- [x] write a header comment in `src/main/index.ts` stating the rule that Electron-only modules (`node-pty`, `safeStorage`, `utilityProcess`) are only imported from adapter files, never from logic modules that unit tests load
- [x] write a smoke unit test (imports a pure module and asserts) to prove vitest runs without Electron
- [x] run `npm run typecheck`, `npm run lint`, `npm test` - must pass before task 2

### Task 2: Data dir, paths and atomic JSON store [model: sonnet]

**Files:**
- Create: `src/main/paths.ts`
- Create: `src/main/store/json-file.ts`
- Create: `test/unit/paths.test.ts`, `test/unit/json-file.test.ts`

- [x] `paths.ts`: resolve the data dir (`CC_COCKPIT_DATA_DIR` or Electron userData; logic takes the base as an argument so it is testable) and every derived path from Technical Details › Data dir layout
- [x] `paths.ts`: `socketPath(dataDir, env, uid, tmpdir)` with the 100-byte fallback; export it so `src/cli` reuses the exact same function
- [x] in `src/main/index.ts`, apply the override with `app.setPath('userData', …)` before the single-instance lock and before `ready`
- [x] `json-file.ts`: typed load with defaults and `schemaVersion` check (unknown future version → refuse to overwrite and log), atomic write (tmp + fsync + rename), 300 ms debounced save, `flush()` for quit
- [x] write tests: path derivation, socket fallback when the path is over 100 bytes and not when under, deterministic fallback for the same data dir
- [x] write tests: atomic write leaves the old file intact if the write throws, debounce coalesces writes, flush writes immediately, corrupt JSON loads defaults and keeps a `.corrupt-<ts>` copy, future schemaVersion is not overwritten
- [x] run tests - must pass before task 3

### Task 3: Login-shell environment and PTY env builder [model: sonnet]

**Files:**
- Create: `src/main/env/login-env.ts`
- Create: `src/main/env/pty-env.ts`
- Create: `test/unit/login-env.test.ts`, `test/unit/pty-env.test.ts`

- [x] `login-env.ts`: once at startup run `[$SHELL, '-l', '-i', '-c', <fixed command>]` where the command is `env -0` fenced by NUL-delimited BEGIN/END markers printed with `printf` (argv, fixed command string, no user text; the markers cut off rc-file and `.zlogout` output around the env), 5 s timeout, 1 MiB stdout cap, own process group (killed as a whole on timeout), resolve shortly after exit even if a background job keeps stdout open; parse only the NUL-separated records between the markers, dropping names that are not `[A-Za-z_][A-Za-z0-9_]*`; on failure, timeout or missing markers fall back to `process.env` and log why (GUI apps on macOS do not get the shell PATH)
- [x] `pty-env.ts`: build a child env from the login env: prepend `<data>/bin` to `PATH`; set `TERM=xterm-256color`, `COLORTERM=truecolor`; add tab vars (`APP_TAB_ID`, `APP_TAB_TOKEN`, `CC_COCKPIT_SOCK`) when given
- [x] `pty-env.ts`: strip `CLAUDECODE`, every `CLAUDE_CODE_*` and every `ELECTRON_*` variable (a cockpit started from inside a Claude session would otherwise make `claude` refuse to start as a nested session; `ELECTRON_RUN_AS_NODE` would break any Electron app run in a tab)
- [x] write tests for `env -0` parsing (values with newlines and `=`, rc noise before and after the markers, invalid names), timeout fallback (fake spawner), non-zero exit fallback, and the real spawner against `node -e` scripts (exit code, ENOENT, output cap, background grandchild holding stdout, group kill on timeout)
- [x] write tests for the env builder: PATH prepend, stripped variables, tab vars present only for Claude tabs
- [x] run tests - must pass before task 4

### Task 4: Project registry [model: sonnet]

**Files:**
- Create: `src/main/projects/registry.ts`
- Create: `src/shared/types.ts`
- Create: `test/unit/project-registry.test.ts`

- [x] `shared/types.ts`: `ProjectRecord`, `TabRecord`, `LayoutState` (placeholder, filled in Task 17), `AppSettings`
- [x] `registry.ts`: `openPath(path)` → resolve real path, compute `projectId`, create or load the record; `get`, `list`, `relink(id, newPath)` (keeps the id's record, updates path), `forget(id)`; `missing` flag when the folder no longer exists
- [x] `app.json`: list of open project ids (for restore) and recently opened
- [x] write tests: same folder via a symlink or trailing slash gives the same id, relink keeps settings, forget removes the record file, missing folder flagged
- [x] write tests: records written under a temp data dir only
- [x] run tests - must pass before task 5

### Task 5: Windows, project picker, IPC authority, menu, single instance [model: opus]

**Files:**
- Create: `src/main/windows/window-manager.ts`
- Create: `src/main/ipc/router.ts`
- Create: `src/main/menu.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`
- Create: `src/renderer/picker/ProjectPicker.tsx`
- Create: `test/unit/window-manager.test.ts`, `test/unit/ipc-router.test.ts`

- [x] `window-manager.ts`: one BrowserWindow per project, always created through `createWindow()` from Task 1; opening an already open project focuses its window; a project picker window when no project is open (lists recent projects, "Open Folder…"); window bounds saved in the project record; the Electron side behind a small `WindowFactory` interface so the logic is unit-testable
- [x] `ipc/router.ts`: one place that registers IPC handlers; each handler receives a resolved `{ projectId, windowId }` from `event.sender` and never reads a project id from the payload; unknown senders are refused
- [x] preload exposes a minimal typed `window.cockpit` API via `contextBridge` (invoke + subscribe), nothing else
- [x] `menu.ts`: application menu with File › Open Folder (`Cmd+O`, native folder dialog), Window, Edit (copy/paste roles so xterm copy/paste works)
- [x] single-instance lock; `second-instance` argv with a path opens that project
- [x] write tests: open-or-focus logic, picker shown when the last window closes (Linux/mac behaviour per platform), router refuses unknown sender, router passes the sender's project not a payload project
- [x] run tests - must pass before task 6

### Task 6: PTY backend interface and node-pty adapter [model: sonnet]

**Files:**
- Create: `src/main/pty/pty-backend.ts`
- Create: `src/main/pty/node-pty-backend.ts`
- Create: `test/fakes/fake-pty-backend.ts`
- Create: `test/unit/pty-service.test.ts`
- Create: `src/main/pty/pty-service.ts`

- [x] `pty-backend.ts`: interface `spawn(argv, { cwd, env, cols, rows })` → handle with `write`, `resize`, `kill`, `onData`, `onExit(code, signal)`; designed so a ConPTY backend can follow for Windows
- [x] `node-pty-backend.ts`: the only file that imports `node-pty`; argv[0] is the file, the rest are args (no shell)
- [x] `pty-service.ts`: owns PTYs by id; batches output per PTY (flush every 8 ms or 64 KiB) before sending to the renderer; pauses the PTY when the renderer has more than 1 MiB unacknowledged and resumes on ack (flow control)
- [x] `fake-pty-backend.ts`: scriptable fake (emit data, exit with code, record writes)
- [x] write tests with the fake: batching, flow-control pause/resume, exit code propagation, write after exit is ignored
- [x] run tests - must pass before task 7

### Task 7: Tab manager in main [model: sonnet]

**Files:**
- Create: `src/main/tabs/tab-manager.ts`
- Create: `src/main/tabs/claude-argv.ts`
- Modify: `src/main/ipc/router.ts`
- Create: `test/unit/tab-manager.test.ts`, `test/unit/claude-argv.test.ts`

- [x] `claude-argv.ts`: `['claude', '--settings', <data>/hooks.json, ...('--resume', id)?, ...('--', prompt)?]`; shell tab: `[$SHELL, '-l']`
- [x] verify against the installed `claude --help` whether a positional prompt after `--` is accepted; record the finding in a comment and in the fake `claude` (Task 9) (comment recorded in claude-argv.ts; the fake claude is Task 9, which reads PROMPT_AFTER_DOUBLE_DASH there)
- [x] implement the fallback as a real branch behind a constant set from that finding: when `--` is not supported, `claudeArgv` throws a clear error for a prompt starting with `-` instead of passing it
- [x] `tab-manager.ts`: create Claude or shell tabs (cwd = project folder or a subfolder inside it; reject a cwd outside the project), close (kill PTY), reorder, generate per-tab token, track exit code; "restart" relaunches the same kind and cwd (with `--resume` when a session id is known)
- [x] IPC: `tabs.create/close/reorder/restart/input/resize/ack` scoped to the sender's project; input from the renderer is the user typing and goes straight to the PTY (the send gate in Task 15 is for programmatic text only)
- [x] write tests (fake PTY): argv for new/resume/prompt, both branches of the `--` fallback (supported: `-x` passed after `--`; unsupported: `-x` refused), cwd outside project refused, token unique per tab, exit code recorded, restart reuses session id
- [x] run tests - must pass before task 8

### Task 8: Terminal tabs UI [model: sonnet]

**Files:**
- Create: `src/renderer/tabs/TabBar.tsx`, `src/renderer/tabs/TerminalView.tsx`, `src/renderer/tabs/ExitedBanner.tsx`
- Create: `src/renderer/state/tabs-store.ts`
- Modify: `src/renderer/App.tsx`
- Create: `test/unit/tabs-store.test.ts`

- [x] tab bar with `[+]` menu (Claude / shell), close buttons, drag-free reorder via context menu (move left/right)
- [x] `TerminalView`: one xterm.js per tab with fit, web-links (open via main → system browser), unicode11; hidden tabs stay mounted so scrollback survives; resize forwarded; acks sent for flow control
- [x] exited banner: "exited (code N): Restart · Close"
- [x] `tabs-store.ts`: renderer-side tab list state, pure reducer
- [x] write tests for `tabs-store` (add, close, select neighbour on close, reorder)
- [x] e2e: covered from Task 9 (harness not yet available); leave a TODO in `tabs-store.test.ts` referencing Task 9
- [x] run tests - must pass before task 9

### Task 9: E2E harness and fake `claude` [model: sonnet]

**Files:**
- Create: `test/e2e/fixtures.ts`
- Create: `src/main/test-hooks.ts`
- Create: `test/fixtures/bin/claude` (Node script, executable)
- Create: `test/e2e/tabs.spec.ts`
- Modify: `playwright.config.ts`

- [x] `fixtures.ts`: launch the built app with `_electron.launch`, a fresh temp `CC_COCKPIT_DATA_DIR`, a temp project folder, `PATH` with `test/fixtures/bin` first, `CC_COCKPIT_FAKE_SECRETS=1`; helpers to read terminal text and wait for it; cleanup of temp dirs
- [x] `src/main/test-hooks.ts`: IPC handlers for e2e assertions (read the session registry, set the theme, read layout state), registered only when `CC_COCKPIT_TEST=1`; the harness sets it, and the module is never imported otherwise (dynamic import behind the check) (as hooks on a main-process global read via `electronApp.evaluate`, not IPC channels, so the preload allow-list gets no test hole; only the `tabs` hook exists now, the registry/theme/layout hooks are added by the tasks that create those subsystems: 10, 14, 17)
- [x] fake `claude`: prints a banner with its argv, echoes stdin lines, exits with a code given by the `FAKE_CLAUDE_EXIT` env or the input line `/exit N`; it records argv to `$FAKE_CLAUDE_LOG` for assertions
- [x] e2e: open a project, `Cmd+T` creates a Claude tab running the fake (banner visible), typing echoes, `/exit 3` shows "exited (code 3)", Restart relaunches, shell tab opens `$SHELL` (tabs are created via the [+] menu: the Cmd+T keybinding is Task 11; a context-menu reorder case was added)
- [x] remove the TODO from Task 8's test file
- [x] run `npm test` and `npm run test:e2e` - must pass before task 10

### Task 10: Themes (built-in light and dark) [model: sonnet]

**Files:**
- Create: `src/shared/theme.ts`
- Create: `src/main/themes/theme-service.ts`
- Create: `src/renderer/theme/apply-theme.ts`
- Create: `src/themes/light.json`, `src/themes/dark.json`
- Create: `test/unit/theme.test.ts`, `test/e2e/theme.spec.ts`

- [x] `theme.ts`: theme format = `{ id, name, kind: 'light'|'dark', vars: Record<string,string>, xterm: ITheme }`; validator (unknown var names allowed, colors must parse)
- [x] `theme-service.ts`: built-in themes, register/unregister contributed themes (used by Task 24), active theme stored in `app.json`, app-wide broadcast on change
- [x] renderer applies vars on `:root` and the xterm palette to every terminal; follows the OS dark mode until the user picks a theme
- [x] write tests: validation errors, fallback to the built-in theme when the active theme disappears
- [x] e2e: switching theme (via the Task 9 test hooks) changes a CSS var in every open window
- [x] run tests - must pass before task 11

### Task 11: Commands, keybindings and command palette [model: sonnet]

**Files:**
- Create: `src/shared/keys.ts`
- Create: `src/main/commands/command-registry.ts`
- Create: `src/renderer/commands/keybindings.ts`, `src/renderer/commands/CommandPalette.tsx`
- Create: `test/unit/keys.test.ts`, `test/unit/command-registry.test.ts`, `test/e2e/commands.spec.ts`

- [x] `keys.ts`: parse and normalise chords (`cmd+shift+p`; `cmd` maps to `Ctrl` on Linux), detect conflicts, apply user overrides from `app.json` over defaults
- [x] `command-registry.ts`: core commands (the default keybinding table in Technical Details) plus a slot for plugin commands namespaced `<pluginId>/<id>` per project
- [x] renderer: global key handler; xterm's `attachCustomKeyEventHandler` returns false for bound app chords so they work while the terminal has focus; unbound keys go to the terminal
- [x] command palette (`Cmd+Shift+P`): fuzzy filter over command titles, runs the command
- [x] write tests: chord parsing, Linux mapping, override replaces default, conflict reported, unknown command id ignored
- [x] e2e: `Cmd+Shift+T` opens a shell tab while the terminal is focused; palette runs "New Claude Tab"
- [x] run tests - must pass before task 12

### Task 12: Socket transport and server [model: opus]

**Files:**
- Create: `src/shared/protocol.ts`
- Create: `src/main/socket/transport.ts`
- Create: `src/main/socket/socket-server.ts`
- Create: `test/unit/protocol.test.ts`, `test/unit/socket-server.test.ts`

- [x] `protocol.ts`: request/reply types and a line framer (Technical Details › Socket); 1 MiB line cap
- [x] `transport.ts`: `listen(path)` / `connect(path)` interface over `net` Unix sockets (named pipes can follow for Windows)
- [x] `socket-server.ts`: stale socket detection (connect test, unlink if dead, refuse to start the server if alive), `0600` mode, request dispatch to handlers by `cmd`, token → tab → project resolution with `timingSafeEqual`, `--project` path resolution for tokenless calls, the allow-list of tokenless commands
- [x] handler errors become `{ ok: false, error }`; one bad connection never affects others
- [x] fallback socket dir: create `ccc-<uid>/` with mode `0700`; refuse (log, no socket) when it exists with another owner or a looser mode
- [x] write tests (real sockets in a temp dir): round trip, oversized line closes the connection, bad JSON returns an error, invalid token refused, tokenless call to a token-only command refused, stale socket replaced, live socket not replaced, socket file mode `0600`, fallback dir created `0700`, fallback dir with mode `0777` refused
- [x] run tests - must pass before task 13

### Task 13: `ccc` CLI core, hook command, wrapper and hooks.json [model: sonnet]

**Files:**
- Create: `src/cli/index.ts` (replace scaffold), `src/cli/args.ts`, `src/cli/client.ts`
- Create: `src/main/hooks/hooks-file.ts`, `src/main/hooks/ccc-wrapper.ts`
- Create: `test/unit/cli-args.test.ts`, `test/unit/cli-client.test.ts`, `test/unit/hooks-file.test.ts`

- [x] `client.ts`: resolve the socket path with the shared `socketPath()`; any connect error (`ENOENT`, `ECONNREFUSED`, timeout) → exit 0 silently; top-level try/catch so nothing ever exits non-zero because of the app
- [x] `client.ts` (Task 12 review): main exports `CC_COCKPIT_SOCK` to a Claude tab only while its server listens on that path, because a path main could not bind (a foreign listener, another user's pre-created `ccc-<uid>/` on a shared /tmp) may belong to someone else. So inside a tab (`$APP_TAB_TOKEN` set) with no `$CC_COCKPIT_SOCK`, exit 0 without computing a path or connecting; `hook` never falls back to `socketPath()`. A tokenless call that computes the fallback path checks the dir first like the server does (lstat: a real directory, owned by our uid, mode `0700`) and exits 0 when it fails
- [x] `args.ts`: subcommand parsing for `hook <event>` now (the rest in Task 21); `hook` reads stdin (cap 1 MiB), sends `{ cmd: 'hook', token: $APP_TAB_TOKEN, args: { event, payload } }` without waiting for a reply, 500 ms total cap
- [x] `hooks-file.ts`: generate `<data>/hooks.json` at every start (events and matchers from Technical Details; `timeout: 5`; single-quoted wrapper path with `'` escaping)
- [x] `ccc-wrapper.ts`: generate `<data>/bin/ccc` (0755) pointing at the current Electron binary and `out/cli/index.js`
- [x] verify against the installed `claude` docs or `claude --help` whether hooks support an async/background flag; if they do, set it on `PreToolUse`/`PostToolUse` and note it in a comment; otherwise keep the 500 ms cap — finding: yes, `async: true` exists (claude 2.1.312: in the settings schema inside the binary next to `asyncRewake`, used by the official `claude-security` plugin hooks.json); first set on `PreToolUse`/`PostToolUse`, then removed in the Task 13 review (next item); 500 ms cap kept
- [x] ➕ (Task 13 review) every hook is synchronous, no `async` anywhere: backgrounded `ccc` processes reach the socket in startup-jitter order (~85-100 ms each), so an async `PreToolUse` could land after the synchronous permission `Notification` (tab shows working during a permission prompt) or a tool event after `Stop`. Synchronous, Claude waits for `ccc` to exit and `ccc` exits only after its write is in the kernel, so arrival order is event order. No ordering field is added: the payload has no timestamp or sequence number and a CLI-side clock carries the same jitter
- [x] ➕ (Task 13 review) `src/cli/index.ts` has no static imports: it installs the exit-0 handlers, then loads `client.ts` with a dynamic `import()`, so a missing shared chunk (dev rebuild with `emptyOutDir`, partial `out/`) is a rejection that exits 0 instead of a stack and exit 1. The wrapper exits 0 before `exec` when `out/cli/index.js` or the Electron binary is missing. A main started with `$CC_COCKPIT_SOCK` cannot be reached by tokenless shell-tab calls (shell tabs and the wrapper carry only `CC_COCKPIT_DATA_DIR`); they compute `<data>/app.sock` and exit 0
- [x] write tests: hook exits 0 with no socket, exits 0 when the server hangs (after ≤ 600 ms), sends token and payload when the server is up, stdin over the cap truncated with a flag; hooks.json shape and quoting of a path containing `'` and spaces
- [x] measure now, before later tasks build on it: wall time of `<data>/bin/ccc hook PreToolUse < sample.json` (Electron run as Node) with the app running and not running, 20 runs each; record median and p90 here. Budget: median under 300 ms. Over budget → ⚠️ stop and report to the user with the numbers and options (a plain-`node` shim when `node` is on the login PATH, falling back to the Electron wrapper); do not continue to Task 14 without a decision — result (sample PreToolUse payload, wrapper run via Electron as Node, 20 runs each, built app on a temp data dir): app running median 85 ms, p90 98 ms; app not running median 89 ms, p90 91 ms (second series: 85/93 and 85/93); under the 300 ms budget, no shim needed
- [x] run tests - must pass before task 14

### Task 14: Status reducer and session registry [model: sonnet]

**Files:**
- Create: `src/main/sessions/status-reducer.ts`
- Create: `src/main/sessions/session-registry.ts`
- Modify: `src/main/socket/socket-server.ts` (register `hook` handler), `test/fixtures/bin/claude`
- Create: `test/unit/status-reducer.test.ts`, `test/unit/session-registry.test.ts`, `test/e2e/status.spec.ts`
- Done as built (scope note): the `hook` handler is `src/main/sessions/hook-handler.ts`, registered in `src/main/index.ts` (socket-server.ts is unchanged); `TabManager` got a `lifecycle` option (started/exited/closed) that feeds the registry; `src/shared/ipc.ts` got the `sessions.snapshot` event and `SessionStripEntry` (strip fields only: tabId, projectName, status, tool; Task 16 adds full own-project entries and the per-window split); `__ccTest.sessions(path)` test hook

- [x] `status-reducer.ts`: pure `(entry, event) → entry` per Technical Details › Tab status
- [x] ➕ (Task 13 review, event ordering) hook events carry no timestamp or sequence number; they are in Claude's order only because every hook in hooks.json is synchronous (hooks-file.ts). So: (1) the `hook` handler applies the reducer synchronously when the request is dispatched, before any `await`, so the per-connection async `serve()` cannot reorder two hooks; never sort by a timestamp or a CLI-side clock. (2) `PreToolUse` and `PostToolUse` set `working` from any live status, including `needs-permission`: `PreToolUse` fires before the permission check, so after an approval the next event is the tool's `PostToolUse` (file tools only, per the matcher) or the next tool's `PreToolUse`, and ignoring them there would leave the tab stuck in needs-permission. Do not add "ignore tool events while needs-permission/waiting" rules to paper over reordering. (3) Add a reducer test for the sequence PreToolUse → Notification(permission_prompt) → PreToolUse (next tool) → Stop ending in waiting, and one for needs-permission → PostToolUse → working. If `async` is ever re-enabled on a hook, this item must be revisited first
- [x] `Notification` kind: verify against current Claude Code hook docs which field carries the kind (`notification_type`: `permission_prompt` / `idle_prompt` expected); fall back to matching "permission" in `message`; unknown kinds leave the status unchanged; record the finding in a comment
- [x] `PostToolUse`: take `tool_input.file_path`, or `tool_input.notebook_path` for NotebookEdit (verify field names against the hook docs); dedupe; keep absolute paths
- [x] apply the payload caps from Technical Details › Tab status (prompt, tool, files); non-string fields are ignored, not coerced
- [x] `session-registry.ts`: entries per tab, PTY exit → ended with exit code, snapshot broadcast to all windows throttled to 10/s, `onChange` subscription for other main modules
- [x] extend the fake `claude`: read `--settings`, run the configured hook commands with JSON on stdin; scripted input lines (`/prompt`, `/tool Bash`, `/edit <path>`, `/permission`, `/stop`) emit the matching events
- [x] write table-driven reducer tests for every event, the notification fallback, unknown events, files dedupe, NotebookEdit path, caps (oversized prompt truncated, 501st file dropped), non-string `file_path` ignored, a reported path starting with `-` stored verbatim
- [x] the e2e run uses the wrapper generated from the built `out/` (`npm run test:e2e` builds first) with the app's `process.execPath`; the fake `claude` finds `ccc` via the hook commands in `--settings`, not via PATH
- [x] e2e: fake claude emits SessionStart → idle, `/prompt` → working, `/stop` → waiting (assert via the Task 9 test hooks)
- [x] run tests - must pass before task 15

### Task 15: Send-text gate and queue [model: opus]

**Files:**
- Create: `src/main/sessions/send-gate.ts`
- Modify: `src/main/sessions/session-registry.ts`
- Create: `test/unit/send-gate.test.ts`, `test/e2e/send.spec.ts`
- Done as built (scope note): `SessionEntry` got `delivering` (status-reducer.ts); the registry takes a `write` option, wired in `src/main/index.ts` to `TabManager.input` with the entry's own project; `send`/`cancelQueued` are `SessionRegistry` methods and `__ccTest.send`/`cancelQueued` test hooks; `SessionChange.dropped` reports a dropped queue; the fake claude records pastes to `$FAKE_CLAUDE_PASTE_LOG` and submits them (UserPromptSubmit), `fixtures.ts` reads them via `pastes()`

- [x] `send-gate.ts`: pure decision + queue per Technical Details › Send-text gate (waiting-only, `delivering` flag, one item per `Stop`, cancel by id, marker stripping)
- [x] wire into the registry: on `Stop` deliver the queue head; on `UserPromptSubmit` clear `delivering`; 10 s `delivering` timeout logged; queue cleared (and reported) when the tab ends
- [x] expose `sessions.send(tabId, text)` and `sessions.cancelQueued(tabId, itemId)` as main-internal functions (plugins and IPC reach them in later tasks, always scoped to their project)
- [x] write tests: sent when waiting; queued when working, idle, starting, needs-permission; never written in needs-permission even with a non-empty queue on `Notification`; two `Stop`s in a row before `UserPromptSubmit` deliver only one item; markers stripped; cancel removes; ended tab drops queue
- [x] e2e: with the fake claude working, a send is queued; `/stop` delivers it as one bracketed paste the fake records verbatim
- [x] run tests - must pass before task 16

### Task 16: Claude status UI: tab dots, queued chip, top strip [model: sonnet]

**Files:**
- Create: `src/renderer/status/StatusDot.tsx`, `src/renderer/status/TopStrip.tsx`, `src/renderer/status/QueuedChip.tsx`
- Create: `src/renderer/status/strip-order.ts`
- Done as built (scope note): also `src/renderer/status/use-sessions.ts` (the snapshot hook), `src/main/ipc/router.ts` (`registerSessionHandlers`: `sessions.list`, `sessions.cancelQueued`, `sessions.focus`), `src/main/sessions/session-registry.ts` (`snapshotFor(projectId)` replaces `snapshot()`, `cancelQueuedFor`), `src/main/index.ts` (per-window broadcast), `src/shared/ipc.ts` (`SessionsSnapshot {strip, own}`, `tabs.select` event), `src/renderer/tabs/TabsPane.tsx`, `src/renderer/styles.css`, `src/themes/*.json` (`--cc-status-*` vars); `WindowManager` got `focusProject` and `projectWindows`
- Modify: `src/renderer/tabs/TabBar.tsx`, `src/main/windows/window-manager.ts`
- Create: `test/unit/strip-order.test.ts`, `test/e2e/top-strip.spec.ts`

- [x] status dot per tab (colour per status, tooltip with current tool)
- [x] top strip in every window: every Claude tab across all windows as `project · status · tool`, fed by the per-window snapshot (other projects' tabs carry only these fields, see Technical Details › Tab status); `strip-order.ts` sorts needs-permission, then waiting, then working, then idle, then ended, stable by tab order
- [x] click on a strip entry: main focuses that window and selects the tab (IPC carries the tab id; main checks it exists and finds its window itself)
- [x] queued chip on a tab: count, list, cancel per item
- [x] write tests for `strip-order` and for the per-window snapshot (window A receives no `lastPrompt`, notes or files of project B)
- [x] e2e: two project windows, a tab in window B needing permission appears first in window A's strip; clicking it focuses window B on that tab; queued chip cancel removes the item
- [x] run tests - must pass before task 17

### Task 17: Layout state model [model: sonnet]

**Files:**
- Create: `src/shared/layout.ts`
- Create: `test/unit/layout.test.ts`

- [x] `LayoutState`: zones `left | right | bottom`, each `{ collapsed, size, panels: [{ panelKey, open, size }] }`, plus `hidden: panelKey[]`; `panelKey` = `core/sessions` or `<pluginId>/<panelId>`
- [x] pure operations: toggle panel, move panel to zone, hide/unhide, resize, collapse zone, reconcile with the available panels (new panels go to their default zone; panels of disabled plugins are dropped but their placement is remembered for re-enable)
- [x] persisted in the project record (debounced)
- [x] write tests for every operation, reconcile with added/removed panels, remembered placement after disable/enable
- [x] run tests - must pass before task 18

### Task 18: Zones UI [model: sonnet]

**Files:**
- Create: `src/renderer/zones/Zone.tsx`, `src/renderer/zones/IconStrip.tsx`, `src/renderer/zones/PanelArea.tsx`, `src/renderer/zones/Splitter.tsx`
- Modify: `src/renderer/App.tsx`
- Create: `test/e2e/zones.spec.ts`

- [x] layout per design §4: icon strips and panel areas on left, right and bottom; panels stack vertically (left/right) or side by side (bottom) with draggable splitters; terminal in the centre
- [x] icon click toggles its panel; right-click menu: move to left / right / bottom, hide; "…" at the end of each strip lists hidden panels; badge on icons (count or dot) and ⚠ with a tooltip for plugin errors
- [x] zone collapse keybindings (`Cmd+B`, `Cmd+J`, `Cmd+Shift+B`) through the command registry
- [x] a placeholder core panel to exercise zones until the Sessions panel exists
- [x] e2e: move a panel to the bottom zone, hide and unhide it, collapse a zone, reopen the window and see the same layout
- [x] run tests - must pass before task 19

### Task 19: Overlay stack [model: opus]

**Files:**
- Create: `src/main/overlays/overlay-manager.ts`
- Create: `src/renderer/overlays/OverlayStack.tsx`, `src/renderer/overlays/TerminalOverlay.tsx`, `src/renderer/overlays/HtmlOverlay.tsx`
- Create: `test/unit/overlay-manager.test.ts`, `test/e2e/overlays.spec.ts`

- [x] `overlay-manager.ts` (main is the owner): per-window stack; `open(windowId, spec, opener)` returns a promise of the result (`{ kind: 'exit', code }`, `{ kind: 'value', value }` or `{ kind: 'dismissed' }`); closing a window resolves every open overlay as dismissed
- [x] `terminal` overlay: argv + cwd in its own PTY (Task 6 service); closes on exit and resolves with the exit code
- [x] `url` overlay: only `http:`/`https:` URLs (anything else is refused before a view is created); `WebContentsView` with no preload, `nodeIntegration: false`, its own partition (`overlay-<windowId>`); navigation to another site and `window.open` go to `shell.openExternal` (http/https only); resolves dismissed on close
- [x] `html` overlay: sandboxed iframe (`allow-scripts` only); for now it can post one result value through a `MessagePort`; Task 28 plugs in plugin pages and the panel message API
- [x] key handling: `Esc` pops the top overlay unless it is a terminal overlay; `Cmd+Shift+W` and a ✕ button on every overlay close the top overlay of any kind (terminal overlay: kill PTY, result `dismissed`)
- [x] write tests (fake PTY, fake view factory): stack order, results per kind, Esc rules, `url` with `file:`/`javascript:` refused, window close resolves all as dismissed, opener gets exactly one result
- [x] e2e: terminal overlays with argv `['true']` and `['false']` resolve with exit codes 0 and 1; Esc does not close a terminal overlay; `Cmd+Shift+W` and ✕ do; a `url` overlay closes on Esc with `dismissed`
- [x] run tests - must pass before task 20
- ➕ also created/changed: `src/main/overlays/electron-url-view.ts` (WebContentsView adapter), `src/main/overlays/overlay-protocol.ts` (`cc-overlay://<id>/` serves html overlay pages with their own CSP: a data:/srcdoc frame inherits the shell CSP and cannot run script), overlay channels in `src/shared/ipc.ts` + `registerOverlayHandlers` in `src/main/ipc/router.ts`, `onProjectClosed(projectId, windowId)` in `window-manager.ts`, a pluggable IO for `terminal-session.ts`, `frame-src cc-overlay:` in the shell CSP. Task 28 must add its scheme to the same `registerSchemesAsPrivileged` call (Electron takes one list).

### Task 20: Sessions panel [model: sonnet]

**Files:**
- Create: `src/renderer/sessions/SessionsPanel.tsx`
- Create: `src/main/sessions/diff-argv.ts`
- Modify: `src/renderer/zones/PanelArea.tsx` (register `core/sessions`, remove the placeholder)
- Create: `test/unit/diff-argv.test.ts`, `test/e2e/sessions-panel.spec.ts`

- [x] built-in panel `core/sessions` (default zone right) listing this window's Claude tabs: status, last prompt, notes, steps, changed files
- [x] file click → terminal overlay with `diff-argv.ts`: `['git', 'diff', '--', file]` in the tab's cwd; untracked file → `['git', 'diff', '--no-index', '--', '/dev/null', file]`; file outside any repo → `['less', file]`; tracked/untracked detection via `git ls-files --error-unmatch` (argv)
- [x] write tests for `diff-argv` (tracked, untracked, outside repo, path with spaces and a leading `-`)
- [x] e2e: fake claude `/edit <path>` makes the file appear in the panel; clicking opens a terminal overlay
- [x] run tests - must pass before task 21
- ➕ also created/changed: `src/main/sessions/open-diff.ts` (the file click: main checks the tab is the asking project's and the file is one it recorded for that tab, takes the cwd from its own tab record, builds the argv with `diff-argv.ts`, opens the terminal overlay), invoke channel `sessions.openFile { tabId, file }` (`src/shared/ipc.ts`, `registerSessionHandlers` in `src/main/ipc/router.ts`, wired in `src/main/index.ts`), `CORE_PANELS` default zone `right` (`layout-service.ts`), panel styles in `styles.css`, `test/unit/open-diff.test.ts`; `diff-argv.ts` resolves the file against the tab cwd and always adds `--` (`['less', '--', abs]`), so a leading `-` is never an option; zones tests moved Sessions back to the left zone first (`zones.spec.ts`, `layout-service.test.ts`)

### Task 21: CLI commands [model: sonnet]

**Files:**
- Modify: `src/cli/args.ts`, `src/cli/index.ts`, `src/main/socket/socket-server.ts`
- Create: `src/main/socket/handlers.ts`, `src/main/overlays/oneshot-protocol.ts`
- Create: `test/unit/cli-commands.test.ts`, `test/unit/oneshot-protocol.test.ts`, `test/e2e/cli.spec.ts`

- Done as built (scope note): `--html F` reuses the Task 19 `cc-overlay` scheme and handler (Electron takes one `registerSchemesAsPrivileged` list and one handler per scheme, so `oneshot-protocol.ts` and `oneshot-protocol.test.ts` were not created). `socket/handlers.ts` reads the file once in main (absolute regular file, at most `MAX_HTML_BYTES`) and opens a Task 19 html overlay with its content: the random UUID overlay id is the one-shot name, only `/` is served, other paths and unknown ids are 404, the mapping goes when the overlay closes, CSP is `OVERLAY_PAGE_CSP` (the plan's CSP plus `font-src data:`, `form-action 'none'`, `base-uri 'none'`); the one-shot rules are covered in `overlay-manager.test.ts` ('html page') and `cli-handlers.test.ts`. Also: `PROJECTLESS_COMMANDS` (`notify`, `sessions`) in `src/shared/protocol.ts` and an `anonymous` caller in `socket-server.ts` (a tokenless `sessions` lists every window, so `--project` made no sense); `SessionRegistry.addNote/setSteps` + `withNote/withSteps` in `status-reducer.ts`; `run()` in `src/cli/client.ts` now returns the exit code (hooks always 0; usage error 2; error reply from main 1; app not there 0 and silent); fake claude `/ccc <args>` line; test hook `notifications` (a test run records `ccc notify` text instead of showing a real notification); extra test files `test/unit/cli-handlers.test.ts`

- [x] `open <path>`: open or focus the project
- [x] `session note "…"`, `session steps 3/5` (token required; adds to the tab's registry entry; notes capped at 20, newest last)
- [x] `overlay --terminal -- argv…` / `--url U` / `--html F`: waits and prints the result as JSON on stdout; in a tab the token picks the window, outside `--project <path>` does (project must be open)
- [x] `--html F` (no separate `oneshot-protocol.ts`, see the scope note): a privileged `cc-overlay` scheme registered before `ready`; each `--html` call maps a random 128-bit nonce to that one absolute file; `cc-overlay://<nonce>/` serves only that file (no relative resources), with CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`; the mapping is removed when the overlay closes; the page posts its result through the Task 19 `MessagePort`
- [x] `sessions --json` lists Claude tabs of every window (the socket is the user's own; plugins never reach it)
- [x] `notify "…"`: system notification
- [x] every command: app not running → exit 0, no output
- [x] write tests: argument parsing for every command, `steps` validation, unknown command message, server handlers with a fake registry, note length cap; one-shot protocol: unknown nonce 404, any path other than `/` 404, mapping gone after close
- [x] e2e: inside a Claude tab the fake runs `ccc session note hi` and the Sessions panel shows it; `ccc sessions --json` from the test lists the tab; `ccc overlay --terminal -- true` prints exit code 0
- [x] run tests - must pass before task 22

### Task 22: Restore windows and tabs [model: sonnet]

**Files:**
- Create: `src/main/restore.ts`
- Modify: `src/main/tabs/tab-manager.ts`, `src/main/index.ts`
- Create: `test/unit/restore.test.ts`, `test/e2e/restore.spec.ts`

- [x] save each project's tabs (kind, cwd, `sessionId`, order) on every change; save the open-window list in `app.json`
- [x] on launch reopen the last projects' windows and their tabs: Claude tabs with `--resume <sessionId>` (no session id → fresh `claude`), shell tabs fresh; missing project folder → picker with relink/forget
- [x] write tests: restore plan built from saved records, tabs without session id, missing folder
- [x] e2e: open two tabs, quit, relaunch, fake claude log shows `--resume <id>` for the tab that had a SessionStart
- [x] run tests - must pass before task 23

### Task 23: Plugin manifest and settings validation [model: sonnet]

**Files:**
- Create: `src/shared/manifest.ts`
- Create: `src/main/plugins/validate.ts`
- Create: `test/unit/manifest.test.ts`, `test/unit/plugin-settings.test.ts`

- [x] JSON Schema for `plugin.json` (design §5 and Technical Details › Plugin manifest), validated with ajv; id regex; `api` major check; contribution id uniqueness; file references (`main`, `entry`, `icon`, theme `file`) must stay inside the plugin folder
- [x] settings validation: plugin app/project settings against the manifest's JSON Schemas; defaults applied; a failure disables the plugin with the reason
- [x] write tests: valid manifest, each failure with its reason (bad id, `api: 2`, path escaping with `../`, duplicate command id, invalid settings schema), settings defaults and failure
- [x] run tests - must pass before task 24

### Task 24: Plugin install, link, update, uninstall [model: opus]

**Files:**
- Create: `src/main/plugins/installer.ts`
- Create: `src/main/plugins/plugin-index.ts`
- Create: `test/unit/installer.test.ts`
- Create: `test/fixtures/plugins/` (a minimal valid plugin and broken variants; a local bare git repo is created in the test from them)

- [x] install from git: validate the URL (https, ssh `git@…` or `file://` only; reject anything starting with `-` and `ext::`), validate the tag against `^[A-Za-z0-9._/-]+$`, then `['git', 'clone', '--depth', '1', '--branch', tag, '--', url, tmpDir]` with `GIT_TERMINAL_PROMPT=0`; validate the manifest; move to `<data>/plugins/<id>@<version>/`; record source in `plugins.json`
- [x] link a local folder (dev): validate manifest, record the path, no copy
- [x] update to a newer tag: install side by side, switch the index entry, remove the old folder after hosts reload; uninstall: remove folder and index entry, keep per-project plugin data
- [x] register contributed themes with the theme service (Task 10) on load; unregister on uninstall
- [x] write tests (local bare repo in a temp dir): install, URL/tag rejection cases, manifest failure leaves nothing behind, update replaces version, uninstall, link, theme registration
- [x] run tests - must pass before task 25

### Task 25: Plugin host process [model: opus]

**Files:**
- Create: `src/main/plugins/host-manager.ts`
- Create: `src/main/plugins/host-process.ts` (the only `utilityProcess` import)
- Create: `src/host/index.ts` (replace scaffold), `src/host/loader.ts`, `src/host/rpc.ts`
- Create: `src/sdk/types.ts`
- Create: `test/unit/host-manager.test.ts`, `test/unit/host-loader.test.ts`, `test/unit/rpc.test.ts`
- ➕ Also: `src/host/ctx/index.ts` (ctx skeleton; Task 26 fills it in), `test/fakes/memory-port.ts`, `test/e2e/plugin-host.spec.ts` with fixtures `test/fixtures/plugins/host-ok` and `host-throws`; Modify `src/main/index.ts`, `src/main/windows/window-manager.ts` (`onProjectOpened`), `src/main/test-hooks.ts`

- [x] `host-manager.ts`: one host per project window; start on window open with the project's enabled plugins; deactivate all on window close with a 5 s timeout, then kill; crash → restart with backoff (1, 2, 4… up to 30 s); after 5 crashes in 2 minutes stop and mark the plugins "plugin stopped: Restart"
- [x] `rpc.ts`: request/response and events over the parent port (Technical Details › Plugin host RPC); shared by host and main; timeouts per call
- [x] `loader.ts`: `require` each plugin's `main`, call `activate(ctx)` with a 10 s timeout; a throw or timeout logs the error and marks that plugin errored (⚠ on its icon) without affecting the others; store a returned object as the reserved export (not reachable in phase 1)
- [x] `sdk/types.ts`: the public `PluginContext` type covering every API in design §5, versioned `api: 1`
- [x] write tests: rpc round trip and timeout (in-memory port pair), loader isolates a throwing plugin and a slow `activate`, host-manager backoff schedule and give-up with a fake process factory
- [x] run tests - must pass before task 26

### Task 26: Host ctx: settings, storage, schedule, exec, commands, log, notify [model: sonnet]

**Files:**
- Create: `src/host/ctx/settings.ts`, `src/host/ctx/storage.ts`, `src/host/ctx/schedule.ts`, `src/host/ctx/exec.ts`, `src/host/ctx/index.ts`
- Modify: `src/main/plugins/host-manager.ts`, `src/main/commands/command-registry.ts`
- Create: `test/unit/ctx-storage.test.ts`, `test/unit/ctx-schedule.test.ts`, `test/unit/ctx-exec.test.ts`, `test/unit/ctx-settings.test.ts`
- ➕ Also: `src/host/ctx/index.ts` (HostContexts), `src/main/plugins/plugin-log.ts`, `src/host/loader.ts` (richer `HostPluginSpec`, `release` hook), `src/host/index.ts`, `src/sdk/types.ts` (docs), `src/shared/types.ts` + `src/main/projects/registry.ts` (`AppSettings.pluginSettings`), `src/main/index.ts` + `src/main/test-hooks.ts` (wiring, `pluginCommands`/`runPluginCommand` hooks), `test/unit/ctx-commands.test.ts`, `test/unit/plugin-log.test.ts`, `test/fakes/host-spec.ts`, `test/e2e/plugin-ctx.spec.ts` with fixture `test/fixtures/plugins/host-ctx`

- [x] `ctx.settings` (project + app, validated) and `ctx.onSettingsChange` (main pushes changes)
- [x] `ctx.storage` KV (`get/set/delete/keys`, JSON values, atomic file per plugin per project) and `ctx.dataDir` (`<data>/plugin-data/<projectId>/<pluginId>/`, created on demand); the host receives these paths from main, never builds them from plugin input
- [x] `ctx.schedule(seconds, fn)`: no overlap (a run still in progress skips the tick), per-run timeout (default 60 s), errors logged and shown as ⚠; returns a disposer; all cleared on deactivate
- [x] `ctx.exec(argv, { stdin, cwd, timeoutMs })`: `spawn` with `shell: false`, argv[0] resolved through the login-shell PATH, stdin written then closed, output capped at 10 MiB, returns `{ code, stdout, stderr }`
- [x] `ctx.commands.register(id, fn)` for ids declared in the manifest only; main adds them to the project's command registry with their manifest keybinding; `ctx.log` (to `<data>/logs/<pluginId>.log`, rotated at 5 MiB) and `ctx.notify(text)`
- [x] write tests: storage persistence and isolation between plugins/projects, schedule no-overlap and timeout (fake timers), exec argv with shell metacharacters stays literal, stdin delivered, output cap, undeclared command refused, settings change event
- [x] run tests - must pass before task 27

### Task 27: Host ctx: sessions, badge, overlay, panel messaging [model: opus]

**Files:**
- Create: `src/host/ctx/sessions.ts`, `src/host/ctx/ui.ts`
- Create: `src/main/plugins/host-api.ts`
- Create: `test/unit/host-api.test.ts`
- ➕ Also: `test/unit/ctx-ui.test.ts`, `test/e2e/plugin-sessions.spec.ts` with fixture `test/fixtures/plugins/host-sessions`; Modify `src/host/rpc.ts` (`timeoutMs: Infinity`), `src/host/loader.ts` (`HostPluginSpec.panels`), `src/host/ctx/index.ts`, `src/host/index.ts`, `src/sdk/types.ts` (docs), `src/main/plugins/host-manager.ts` (one `HostApi` per host process), `src/main/layout/layout-service.ts` (`setBadge`/`setError` keep each other), `src/main/index.ts`, `src/shared/ipc.ts` + `src/renderer/state/tabs-store.ts` + `src/renderer/tabs/TabsPane.tsx` (`tabs.added`: a tab main started, appended without taking the selection)

- [x] `host-api.ts` in main: the handlers for host requests, each scoped to the host's own window/project: `sessions.list` (only this window's tabs), `onChange`, `send(tabId, text)` (the tab must belong to this window, else refused; goes through the send gate), `open({ cwd, prompt })` (cwd inside the project; prompt as argv per Technical Details)
- [x] `ctx.badge(panelId, n | 'dot' | null)` for the plugin's own panels only; `ctx.overlay.open(spec)` → result promise (terminal, url, html of the plugin's own files)
- [x] `ctx.panels.post(panelId, msg)` / `ctx.panels.onMessage(panelId, fn)` over the panel's `MessagePort`
- [x] the real ports arrive in Task 28: here `ctx.panels.*` and html overlays of plugin pages talk to a port interface, and the unit tests use an in-memory fake port; html overlay results from plugin pages are tested in Task 28 (resolved in Task 28: a plugin's html overlay is now its own `cc-plugin://` page loaded like a panel, with the panel SDK and a port to the shell; a page-sent `{ result }` goes through the renderer's `overlays.result`)
- [x] write tests: a host for window A cannot list, send to or badge anything in window B even when it passes B's ids; `open` with a cwd outside the project refused; send while busy is queued (via the gate); badge for another plugin's panel refused
- [x] run tests - must pass before task 28

### Task 28: Panel iframes, `cc-plugin://` protocol and `panel.js` SDK [model: opus]

**Files:**
- Create: `src/main/plugins/plugin-protocol.ts`
- Create: `src/main/plugins/panel-ports.ts`
- Create: `src/renderer/zones/PluginPanel.tsx`
- Modify: `src/renderer/overlays/HtmlOverlay.tsx`, `src/renderer/zones/PanelArea.tsx`
- Create: `src/sdk/panel.ts` (built to `out/sdk/panel.js` and served at `cc-plugin://<id>/__sdk/panel.js`)
- Create: `test/unit/plugin-protocol.test.ts`, `test/unit/panel-ports.test.ts`, `test/e2e/panels.spec.ts`
- ➕ Also: `src/sdk/panel-core.ts` (the SDK's DOM-free logic), `src/renderer/plugins/PluginFrame.tsx` (the shared loader), `src/renderer/plugins/panel-port-bus.ts`, `src/renderer/plugins/frame-messages.ts`, `test/unit/panel-sdk.test.ts`, fixture `test/fixtures/plugins/panels`; Modify `src/main/overlays/overlay-protocol.ts` (one `registerSchemesAsPrivileged` call for both schemes, `handlePluginScheme`), `src/main/overlays/overlay-manager.ts` (html spec with a `cc-plugin:` `src`), `src/main/plugins/host-api.ts` (`pluginPageSrc` replaces `readPluginHtml`), `src/main/plugins/host-manager.ts` (`runningPanels`, `sendPanelPort`, `onPluginsReady`), `src/main/plugins/host-process.ts` (`transferPort`), `src/host/index.ts` + `src/host/ctx/ui.ts` (`fromMainPort`, `panelPortTag`), `src/main/layout/layout-service.ts` (panel `src`), `src/main/ipc/router.ts` (`commands.run`, `panels.connect`, `plugins.restart`), `src/shared/ipc.ts` (+ `commands.updated`, `panels.reload` events), `src/preload/index.ts` (port forwarding), `src/renderer/theme/theme-store.ts`, `src/renderer/tabs/TabsPane.tsx`, `src/renderer/commands/keybindings.ts`, `src/renderer/index.html` (`frame-src cc-plugin:`), `electron.vite.config.ts` (`out/sdk/panel.js`), `tsconfig.*.json`

- [x] `plugin-protocol.ts`: register `cc-plugin` with `protocol.registerSchemesAsPrivileged` before `ready` (`standard: true, secure: true, supportFetchAPI: true, corsEnabled: true`, so a panel's own scripts and `fetch` of its own files work from the opaque origin of a sandboxed iframe); serve files from the plugin's dir with path containment (Technical Details › Panel files) and the CSP header; 404 for anything outside
- [x] `panel-ports.ts`: create a channel per panel instance; host end tagged with plugin and panel id; renderer end transferred into the iframe; a reloaded iframe gets a new port and the old one is closed
- [x] `panel.js` SDK: `post(msg)`, `onMessage(fn)`, `theme` (current vars; applies them to `:root` and updates on theme change)
- [x] `PluginPanel`: iframe with `sandbox="allow-scripts"`, shows "plugin stopped: Restart" when the host gave up, ⚠ when the plugin errored; html overlays of plugins reuse the same loader and get the panel message API, a page-sent `{ result }` closes the overlay with that value
- [x] write tests: path containment (`..`, encoded `%2e%2e`, symlink out of the dir), CSP header present, unknown plugin 404; port lifecycle on reload and on host restart; a plugin html overlay page posting `{ result }` resolves `ctx.overlay.open` with that value and closes the overlay
- [x] e2e (with a fixture plugin linked into the temp data dir): the panel renders, a message round-trips panel → host → panel, the panel gets theme vars, `fetch('https://example.com')` from the panel is blocked by CSP
- [x] ➕ run plugin commands from the palette and keys: a core IPC `commands.run` (project from the sender) that calls `HostManager.runCommand(projectId, id)` (Task 26 built the main side; the renderer's key table only runs commands with a local handler today), plus a renderer handler per plugin command in `commands.list`
- [x] run tests - must pass before task 29

### Task 29: Linked plugin dev reload [model: sonnet]

**Files:**
- Create: `src/main/plugins/dev-watch.ts`
- Create: `test/unit/dev-watch.test.ts`
- ➕ Also: `test/e2e/plugin-dev-reload.spec.ts`; Modify `src/host/loader.ts` (`reload`, `unload`, `clearRequireCache`), `src/host/index.ts` (`plugin.reload` / `plugin.unload`), `src/main/plugins/host-manager.ts` (`devReload`, `buildSpec`), `src/main/plugins/host-api.ts` (`updatePlugin`), `src/main/plugins/installer.ts` (`revalidate`, `onChange`), `src/main/index.ts`; tests added to `host-manager`, `host-loader`, `host-api` and `installer` unit tests

- [x] watch linked plugin folders (`fs.watch` recursive where supported, polling fallback on Linux), debounce 300 ms, ignore `node_modules` and `.git`
- [x] on change: re-validate the manifest, then reload that plugin in every open host (deactivate → clear require cache for its folder → activate) and reload its panels; an invalid manifest disables it with the reason
- [x] write tests with a fake watcher and fake hosts: debounce, reload order, invalid manifest path
- [x] run tests - must pass before task 30

### Task 30: Accounts: store, token and cli auth [model: opus]

**Files:**
- Create: `src/main/accounts/secret-store.ts` (interface + `safeStorage` adapter + fake)
- Create: `src/main/accounts/account-store.ts`, `src/main/accounts/cli-auth.ts`
- Modify: `src/main/plugins/host-api.ts`, `src/host/ctx/index.ts`
- Create: `test/unit/account-store.test.ts`, `test/unit/cli-auth.test.ts`
- ➕ Also: `src/main/projects/registry.ts` (`accountChoice` / `setAccountChoice`, key `<pluginId>/<kind>`), `src/shared/types.ts` (`ProjectRecord.accounts` doc), `src/main/plugins/host-manager.ts` (`HostPlugin.accounts` into the HostApi scope), `src/sdk/types.ts` (`account()` resolves `null`), `src/main/index.ts` + `src/main/test-hooks.ts` (wiring; `addAccount`, `chooseAccount`, `flushAccounts` hooks), `test/e2e/accounts.spec.ts` with fixture `test/fixtures/plugins/host-accounts`; tests added to `host-api`, `ctx-ui` and `host-loader` unit tests. `CliAuth` is built but not wired to a caller yet: its login and check states get their UI in Task 32

- [x] `secret-store.ts`: `encrypt/decrypt` via `safeStorage`; when `isEncryptionAvailable()` is false, refuse to store and report why (never plaintext); `CC_COCKPIT_FAKE_SECRETS=1` selects a fake (reversible, clearly marked) so tests never touch the real keychain
- [x] `account-store.ts`: named accounts `<kind>:<label>`, app-wide; token accounts store secret fields encrypted, others plain; add, update, remove; per-project choice of account per plugin per kind
- [x] `cli-auth.ts`: `check` argv (exit 0 = logged in, 15 s timeout); `ENOENT` → "not installed" with the manifest's install hint; `login` argv runs in a terminal overlay and re-checks after it exits
- [x] `ctx.account(kind)`: only kinds the plugin declared; returns the project's chosen account (fields + `getToken()`; for token accounts `getToken()` returns the secret field); no account chosen → `null`
- [x] write tests: encryption unavailable refuses, secrets never appear in `accounts.json` in plaintext, project choice resolution, undeclared kind refused, cli check states (ok, not logged in, not installed, timeout)
- [x] run tests - must pass before task 31

### Task 31: OAuth accounts (PKCE loopback) [model: opus]

**Files:**
- Create: `src/main/accounts/oauth.ts`
- Create: `test/unit/oauth.test.ts`
- Create: `test/fakes/fake-oauth-server.ts`
- ➕ Also: `src/main/accounts/account-store.ts` (`AccountRecord.oauth` grant info: client id, token URL (refreshes go there, never to the manifest at hand), `grantedAt`, `needsRelogin`; `oauthStatus` in summaries; `recordOf`, `saveOAuthGrant`, `rotateRefreshToken`, `markNeedsRelogin`), `src/shared/types.ts` (`AppSettings.oauthClients`, read here, written by Task 32's UI), `src/main/index.ts` (wiring; `OAuthService.login` gets its caller in Task 32, whose account remove handler must also call `oauth.forget(name)`)

- [x] login: PKCE S256 verifier/challenge, random `state`, loopback HTTP server on `127.0.0.1` with a random port, `shell.openExternal(authUrl)`; accept only the expected path, matching `state` and one request; 5 min timeout; the browser gets a short "you can close this tab" page
- [x] client id/secret from the manifest or from the app settings for that kind (Google needs the user's own Cloud project; note in the settings UI that unpublished apps' refresh tokens expire after 7 days)
- [x] token exchange and refresh with `fetch`; refresh token stored encrypted via the secret store; access token cached in memory until 60 s before expiry; concurrent `getToken()` calls share one in-flight refresh; `invalid_grant` marks the account "needs re-login"
- [x] write tests with the fake OAuth server: full login, wrong state rejected, timeout, refresh, single-flight refresh under 5 concurrent calls, invalid_grant state
- [x] run tests - must pass before task 32

### Task 32: Settings overlay: projects, plugins, accounts [model: sonnet]

**Files:**
- Create: `src/renderer/settings/SettingsOverlay.tsx`, `src/renderer/settings/ProjectsPage.tsx`, `src/renderer/settings/PluginsPage.tsx`, `src/renderer/settings/AccountsPage.tsx`
- Modify: `src/main/ipc/router.ts`
- Create: `test/e2e/settings-plugins.spec.ts`
- ➕ Also: `src/main/settings/settings-service.ts` (the main side of every `settings.*` channel; `registerSettingsHandlers` in the router calls it), `src/renderer/settings/PluginSettingsForm.tsx` (the `@rjsf` form), `use-loaded.ts`, `use-action.ts`; Modify `src/shared/ipc.ts` (19 `settings.*` channels and their view types), `src/main/index.ts` (wiring, `CliAuth` built here), `src/renderer/tabs/TabsPane.tsx` (`app.openSettings` toggles the screen), `src/renderer/styles.css`, `package.json` + lockfile (`@rjsf/core` and `@rjsf/utils`, exact 6.11.0); `test/unit/settings-service.test.ts`, `test/unit/ipc-router.test.ts` (settings handlers), fixture `test/fixtures/plugins/settings-ui`

- [x] settings open as a core overlay (`Cmd+,`), left nav with the five sections from design §6
- [x] Projects: list, open, relink a moved folder, remove
- [x] Plugins: install from git URL + tag, link a local folder, update to a newer tag, uninstall; app-wide settings form via `@rjsf` from the manifest schema; disabled plugins show the reason
- [x] Accounts: add (pick a kind from installed plugins), token form (secret inputs never echo stored values back), OAuth login, cli login (terminal overlay), re-login, remove (main's handler also calls `registry.clearAccountChoices(name)` and `cliAuth.invalidate(name)`, see `AccountStore.remove`); "not installed" shows the install hint
- [x] e2e: link the fixture plugin, see it listed, open its app settings form and save a value; add a token account with the fake secret store; remove it
- [x] run tests - must pass before task 33

### Task 33: Settings overlay: this project, appearance and keys [model: sonnet]

**Files:**
- Create: `src/renderer/settings/ProjectPage.tsx`, `src/renderer/settings/AppearancePage.tsx`
- Modify: `src/main/plugins/host-manager.ts` (restart the host when enabled plugins change)
- Create: `test/e2e/settings-project.spec.ts`

- [x] This project: enable/disable plugins (host restarts with the new set), pick an account per plugin per kind, project settings form (`@rjsf`), panel zone per panel
- [x] Appearance and keys: theme picker; keybinding list with override editing and conflict warnings (from Task 11)
- [x] e2e: enable the fixture plugin in a project → its panel icon appears; disable → icon gone; change a keybinding and use it; switch theme
- [x] run tests - must pass before task 34

### Task 34: `hello` reference plugin [model: sonnet]

**Files:**
- Create: `plugins/hello/plugin.json`, `plugins/hello/src/host.ts`, `plugins/hello/panels/hello.html`, `plugins/hello/panels/hello.js`, `plugins/hello/icons/hello.svg`, `plugins/hello/themes/hello-dusk.json`, `plugins/hello/README.md`
- Create: `plugins/hello/dist/host.js` (built output committed, since plugins ship built JS)
- Modify: `package.json` (`build:hello` script)
- Create: `test/e2e/hello.spec.ts`, `test/unit/hello-dist.test.ts`

- [x] exercises every contribution point: a panel (lists this window's sessions, a text box that sends text to a chosen session), project and app settings, a `token` account kind and a `cli` account kind (`check: ['true']`), a command with a key, a theme
- [x] host uses `ctx.schedule` (badge with a counter), `ctx.storage`, `ctx.exec(['git', 'status', '--short'])`, `ctx.overlay.open` (terminal and html) and shows the results in the panel
- [x] `npm run build:hello` bundles `plugins/hello/src/host.ts` → `plugins/hello/dist/host.js` (esbuild, deterministic output); `npm run build` runs it too
- [x] write a unit test that rebuilds hello into a temp dir and compares with the committed `dist/host.js`, so a stale build fails the suite
- [x] README: how to link it in dev, how to rebuild, and a walkthrough of the API as a template for real plugins
- [x] e2e (design §7 scenarios): open a project, open a Claude tab, status reaches the strip, the hello panel sends text, text is queued while busy and delivered on `/stop`, an overlay opened by hello returns a result to the panel
- [x] run tests - must pass before task 35

### Task 35: Packaging for mac and Linux [model: sonnet]

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`, `src/main/hooks/ccc-wrapper.ts`
- Create: `test/unit/ccc-wrapper.test.ts`
- Also touched (the install button): create `src/main/hooks/ccc-install.ts`, `test/e2e/ccc-install.spec.ts`; modify `src/shared/ipc.ts`, `src/main/ipc/router.ts`, `src/main/index.ts`, `src/renderer/settings/AppearancePage.tsx`, `test/unit/ipc-router.test.ts`

- [x] electron-builder targets: mac `dmg` + `zip` (arm64, x64), Linux `AppImage` + `deb`; `node-pty` unpacked from asar; `out/cli` and `out/host` shipped
- [x] `ccc-wrapper.ts`: resolve the Electron binary and CLI path for both dev and packaged layouts (`process.resourcesPath`); offer "Install `ccc` command" in Settings › Appearance and keys → symlink `~/.local/bin/ccc` to `<data>/bin/ccc` (never overwrites an existing different file)
- [x] write tests: wrapper content for dev and packaged paths, paths with spaces, install refuses to overwrite a foreign file
- [x] run `npm run build` and the packaging script for the current platform; launch the packaged app once (smoke) and record the result in this plan
- [x] run tests - must pass before task 36

Notes (Task 35):
- mac `dmg` + `zip` for arm64 and x64, Linux `AppImage` + `deb` (x64 only: smaller, and Linux was not buildable here). `npm run package` = build + `scripts/package.mjs` (`electron-builder --publish never`, then `install-app-deps` even if the build failed, see below); `npm run package:dir` = unpacked app only. Output in `release/` (already gitignored). `publish: null` in the config, so nothing can upload.
- Shipped: `out/**` (main, preload, renderer, cli, host, sdk/panel.js, chunks; source maps excluded) + production `node_modules` in `app.asar`; `node_modules/node-pty/**` is `asarUnpack`ed and rebuilt for the Electron ABI by electron-builder (`npmRebuild`). Decision: the `hello` plugin is NOT bundled (plugins are linked or installed from a folder, design §5; hello is a dev template, see its README).
- Decision: `productName: cc-cockpit` equals the package `name`, so the packaged app keeps the same `userData` folder the CLI's `defaultDataDir` computes.
- Unsigned: no identity (`mac.identity: null`), no notarisation. A downloaded mac build needs right-click > Open on first launch. Default Electron icon (no icon asset yet).
- `ccc-wrapper.ts`: new `resolveWrapperTargets` (packaged: `<resourcesPath>/app.asar/out/cli/index.js`; dev: `out/cli` beside `out/main`) and `presenceTestPath`. Bug found and fixed on the way: the wrapper's `[ -f <cli> ]` guard cannot see inside `app.asar` (a shell has no asar support), so in a packaged app every `ccc` call would have exited 0 silently and no hook would ever have reached the app. The guard now tests the `.asar` file itself; Electron-as-Node reads the CLI inside it fine (verified below).
- "Install `ccc` command" (Settings > Appearance and keys > Command line): `settings.cccStatus` / `settings.cccInstall` (project windows only, no payload), `CccCommandInstaller` in main. Symlinks `~/.local/bin/ccc` to `<data>/bin/ccc` (the wrapper, which is rewritten at every start, so an app update never leaves a stale link); creates `~/.local/bin`; "ours" = a symlink to exactly this data dir's wrapper, anything else (file, directory, other symlink, dangling link) is refused and left alone; reports whether `~/.local/bin` is on the login-shell PATH (main's captured login env). No uninstall button (kept small).
- Gotcha: building the x64 mac target rebuilds `node-pty` in `node_modules/` for x64 and leaves it there, which breaks dev and e2e on an arm64 host. `npm run package` therefore ends with `npm run postinstall` (`electron-builder install-app-deps`) to put the host-arch build back; noted in `electron-builder.yml`. Cross-arch rebuild from an arm64 host worked here.
- Smoke (packaged `release/mac-arm64/cc-cockpit.app`, arm64, built on this Mac; no network problem, Electron zip came from the download cache/network): launched `Contents/MacOS/cc-cockpit <temp project>` with `CC_COCKPIT_DATA_DIR`, `HOME` set to fresh temp dirs and `SHELL` the fake shell. After 10 s it was alive, had created `hooks.json`, `bin/ccc`, `projects/` and its socket in the temp data dir, and logged no errors. The generated wrapper pointed at `.../Resources/app.asar/out/cli/index.js` and guarded on `app.asar`; running it printed the CLI usage and `hook Stop` exited 0; `ccc overlay --terminal -- /bin/echo` through the socket returned `{"kind":"exit","code":0}` (node-pty from `app.asar.unpacked` works in the packaged app). Then killed. Additionally ran the e2e specs `panels` (plugin host from asar, panel SDK served at `cc-plugin://<id>/__sdk/panel.js`, preload, overlays) and `tabs` against the packaged executable with a temporary harness switch: 9/9 passed. That switch was removed again: a packaged app ignores `CC_COCKPIT_FAKE_SECRETS` by design, so any account test run that way would hit the real keychain (the `hello` spec timed out in that run for the same reason; it was stopped). Not verified: Linux builds (no Linux host), the x64 app (built, not launched), the dmg's first-launch Gatekeeper flow.
- Validation: `npm test` 1318 passed (61 files), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e` 69 passed.


### Task 36: Verify acceptance criteria [model: sonnet]
- [x] verify all requirements from Overview and design §1 "Phase 1 scope" are implemented (walk through design §2–§7 section by section) — checklist in "Notes (Task 36)" below; no real gap found
- [x] verify edge cases are handled: nested-session env stripping, paste marker stripping, idle not sendable, single delivery per `Stop`, socket fallback path, plugin path containment, git URL rejection, keychain unavailable — table below; one test added (nested env at the tab level)
- [x] re-measure `ccc hook PreToolUse` latency as in Task 13, with the packaged app (target: median under 300 ms, exit 0 in both); note the numbers here — median 78-92 ms / p90 82-98 ms in every series, exit 0, silent
- [x] run full test suite: `npm test` — 1324 passed (62 files)
- [x] run e2e tests: `npm run test:e2e` — 69 passed, after a fresh `npm run package` (node-pty is the arm64 build again)
- [x] run `npm run typecheck` and `npm run lint` — both clean
- [x] verify test coverage of pure modules (reducer, gate, layout, manifest, keys, protocol, restore) is at least 90% lines (`npm run test:coverage`) — all 100% lines

Notes (Task 36):

Requirement -> implementation / test (design §1 scope, §2-§7). Deliberate deviations from earlier tasks are in the progress file as [deviation] entries and are not repeated as gaps.
- §1 projects and windows: `main/windows/window-manager.ts`, `main/projects/registry.ts` (window-manager, project-registry tests; e2e `tabs`, `restore`); one window per project, an already-open folder focuses its window; picker `renderer/picker/ProjectPicker.tsx`.
- §1 zones and panel moving: `shared/layout.ts`, `main/layout/layout-service.ts`, `renderer/zones/*` (layout, layout-service, layout-sync tests; e2e `zones`: move, hide / unhide under "…", collapse by key, splitters, badges, plugin error warning).
- §1 terminal tabs: `main/tabs/tab-manager.ts`, `main/pty/*`, `renderer/tabs/*` (tab-manager, pty-service tests; e2e `tabs`, `restore`); exited banner "exited (code N)" with Restart / Close in `ExitedBanner.tsx`.
- §1 Claude status (tab dots, top strip, Sessions panel, notes / steps): `main/sessions/status-reducer.ts`, `session-registry.ts`, `hook-handler.ts`, `renderer/status/*`, `renderer/sessions/SessionsPanel.tsx` (status-reducer, session-registry, strip-order tests; e2e `status`, `top-strip`, `sessions-panel`).
- §1 clicking a changed file opens `git diff` in a terminal overlay: `main/sessions/open-diff.ts`, `diff-argv.ts` (open-diff, diff-argv tests; e2e `sessions-panel`).
- §1 overlay stack: `main/overlays/overlay-manager.ts` (terminal / html / url; result = exit code, value or dismissed; Esc pops except over a terminal overlay, `renderer/overlays/OverlayStack.tsx`; the url view has its own partition and external links go to the system browser, `electron-url-view.ts`) (overlay-manager tests; e2e `overlays`).
- §1 plugin host and API: `host/*`, `host/ctx/*` (every member of design §5's API table is in `sdk/types.ts`: settings, onSettingsChange, account, storage, dataDir, schedule, exec, panels, badge, overlay, sessions, commands, log, notify), `main/plugins/*` (host-manager with crash backoff and "plugin stopped: Restart", installer with tag pin, dev-watch reload) (host-*, ctx-*, installer, dev-watch tests; e2e `plugin-*`, `panels`).
- §1 accounts, all three styles: token (safeStorage) `main/accounts/account-store.ts` + `secret-store.ts`; oauth with PKCE (S256) and loopback `oauth.ts` (fake provider in tests); cli `cli-auth.ts` (account-store, oauth, cli-auth tests; e2e `accounts`).
- §1 settings: `renderer/settings/*` (Projects with relink / remove, Plugins, Accounts, This project, Appearance and keys; forms from the manifest's JSON Schema with @rjsf) (settings-service, project-settings-service, plugin-settings tests; e2e `settings-plugins`, `settings-project`).
- §1 themes, commands and keybindings: `main/themes/theme-service.ts`, `shared/theme.ts`, `main/commands/command-registry.ts`, `shared/keys.ts`, `renderer/commands/*` (theme, command-registry, keys tests; e2e `theme`, `commands`).
- §1 CLI: `src/cli/*`, `main/socket/*`, `main/hooks/*`: open, hook, session note / steps, overlay (--terminal / --url / --html), notify, sessions --json, `--project` outside a tab (cli-args, cli-client, cli-handlers, socket-server, hooks-file, ccc-wrapper tests; e2e `cli`, `socket`).
- §1 hello reference plugin: `plugins/hello/*` (hello-dist unit test, e2e `hello`).
- §2 main is the only authority: tab / project ids come from the registered window or token, never from a payload (ipc-router, host-api, cli-handlers tests); contextIsolation + sandbox in `create-window.ts`; per-tab token on the socket (socket-server tests); no daemon, the last projects' windows reopen (`openProjects`; restore tests, e2e `restore`).
- §3 wiring and status: `claude --settings <data>/hooks.json` with `APP_TAB_ID` / `APP_TAB_TOKEN` (claude-argv, tab-manager, hooks-file tests); login env captured once (login-env tests); status table and the `PostToolUse` file matcher `Edit|Write|MultiEdit|NotebookEdit` (`shared/hooks.ts`; status-reducer, hooks-file tests).
- §3 sending text: `send-gate.ts` (waiting only, bracketed paste + Enter, queue, chip and cancel; send-gate tests; e2e `send`, `top-strip`). Restore with `claude --resume <id>`: `main/restore.ts` (restore tests, e2e `restore`).
- §4 panel sandbox and theme: `PluginFrame.tsx` (`sandbox="allow-scripts"`, no same-origin), CSP in `plugin-protocol.ts`, theme variables injected into panels (plugin-protocol, panel-sdk tests; e2e `panels`, `theme`).
- §5 package, manifest, lifecycle: `shared/manifest.ts`, `main/plugins/validate.ts`, `installer.ts` (manifest, installer tests); an unknown `api` major is refused (bad-api fixture).
- §6 projects: open / focus, relink, forget, missing folder (project-registry tests; e2e `restore.spec.ts:104` "a project whose folder is gone opens the picker with relink and forget"). CLI exits 0 when the app is not running: `cli-client.test.ts:76` (no socket file), `:185` (`run()` exits 0 whatever happens), e2e `cli.spec.ts:234` (every command, app not running); timings in the latency series below. A cli account whose binary is not on PATH shows the manifest's install hint: `cli-auth.ts` (`cli-auth.test.ts:50` check, `:210` login).
- §7 errors: a plugin throwing in `activate` or a job -> warning on its icon (e2e `zones` "plugin error warning", host-manager tests); a broken manifest / failing settings -> plugin disabled with the reason (plugin-settings, settings-service tests); hook delivery failures dropped silently (cli-client tests). Testing section, all six e2e scenarios exist: open a project (`tabs.spec.ts:7`), open a tab (`tabs.spec.ts:12`), status reaches the strip (`top-strip.spec.ts:36`), the hello panel sends text (`hello.spec.ts:112`), text queued while busy (`send.spec.ts:25`), an overlay returns a result (`overlays.spec.ts:36`).
- §7 stack: xterm.js with the fit, web-links and unicode11 addons (`renderer/tabs/terminal-session.ts:4-6`) + node-pty; socket and PTY behind one interface each for a later Windows port (`main/socket/transport.ts`, `main/pty/pty-backend.ts`); @rjsf forms, electron-vite, electron-builder (Task 35).
- Out of phase 1 as designed: Windows builds, a registry, binary downloads, panel drag-and-drop, the cross-plugin API (the `activate` return value is stored, not exposed), sessions that outlive the app.

Edge cases (code -> test):
- nested-session env stripping: `main/env/pty-env.ts` `isStrippedVar` (CLAUDECODE, CLAUDE_CODE_*, ELECTRON_*), used by `tab-manager.ts` -> `pty-env.test.ts:19`; ADDED in `tab-manager.test.ts`: "a cockpit started from inside a Claude session passes no nested-session variables to its tabs" (Claude and shell tab spawn env), since before only the helper was tested, not that the tab spawn goes through it.
- paste marker stripping: `send-gate.ts` -> `send-gate.test.ts:40` (every marker), `:46` (a marker that only forms once another is removed), `:302` (stripped before queueing).
- idle not sendable: `send-gate.ts` -> `send-gate.test.ts:236` (queued in starting, idle, working, needs-permission; nothing written), `:258` (an idle Notification promoting to waiting does not deliver; the next Stop does); `status-reducer.test.ts:182`.
- single delivery per `Stop`: `send-gate.test.ts:146` (a second Stop while delivering writes nothing), `:281` (a send while a paste is in flight is queued); e2e `send.spec.ts:25`.
- socket fallback path (over 100 bytes): `paths.ts` -> `paths.test.ts:85`, `cli-client.test.ts:264` (fallback dir: uid, 0700, not a file), `socket-server.test.ts:427` (created 0700 for a long data dir), `:439` (a 0777 dir refused), `:449` (a dir of another uid refused); `:457` is the negative case (no checks outside the fallback dir). E2e `socket.spec.ts` does not assert that its socket is in the fallback dir, and the latency runs below used a short data dir (`<data>/app.sock`), so neither is evidence for the fallback path; the unit tests are.
- plugin path containment: `manifest.test.ts:195,225,233,284` (../ and symlink escapes), `plugin-protocol.test.ts:81` (404 outside the folder), `installer.test.ts:569` (index entries whose id or version could escape `plugins/`).
- git URL rejection: `installer.test.ts:131` (https, git@ ssh, file:/// accepted), `:177` (URL after `--`, protocols locked to the URL's transport), `:226` (bad URLs and tags refused without running git). The https / ssh transport locks are not exercised against a remote offline (known since Task 24).
- keychain unavailable: `account-store.test.ts:69,76,165` (refused with a reason, nothing stored in plaintext, Linux `basic_text` counts as unavailable), `settings-service.test.ts:554`, `oauth.test.ts:295`.

Orchestrator notes from the progress file, resolved or still open:
- task 20 "open-diff dedupe entries released when a window closes": closing a window settles its overlays as dismissed (`overlay-manager.test.ts` "window close and quit"), which runs the `.finally` that deletes the key (`open-diff.test.ts:107`, allowed again after close). Covered by the two together.
- task 21 "`ccc overlay` window closed mid-wait / `--url`": `--url` is in `cli-handlers.test.ts` (overlay block) and e2e `overlays` (url overlay); a closed window or a gone client settles as dismissed in `overlay-manager.test.ts`.
- Still open, known limitations, not fixed here: task 6 tail output lost when a paused PTY exits; PTY kill never escalates to SIGKILL after a grace period (`pty-service.ts`); task 29 devReload racing a launch, crash-backoff reload coalescing and the macOS folder-swap watcher reopen untested; task 32 OAuth settings UI and git install / update / uninstall from the UI have no e2e (no fake provider or git remote in e2e); Linux and x64 builds never launched (task 35).
- No gap against the design was found.

Latency (`ccc hook PreToolUse`, Task 13 method: `<data>/bin/ccc hook PreToolUse < sample.json` with `APP_TAB_ID`, `APP_TAB_TOKEN`, `CC_COCKPIT_SOCK`, i.e. the wrapper running Electron as Node on `app.asar/out/cli/index.js`). App: PACKAGED `release/mac-arm64/cc-cockpit.app`, built by a fresh `npm run package` in this task, launched with a fresh temp `CC_COCKPIT_DATA_DIR`, a temp `HOME` and the fake shell, killed afterwards. 20 timed runs after 1 warm-up, wall time of the whole process including spawn:
- Re-measured after review with median and p90, as Task 13 records them (the first run reported p95 only: app running 87-89 / p95 91-98, not running 87-89 / p95 99-101). Same packaged build, a fresh temp data dir (short, so the socket was `<data>/app.sock`), then:
- app running: median 91 ms / p90 93 ms; second series median 92 / p90 96. Exit 0, no output.
- app not running, stale socket file (a socket bound and closed, never unlinked; a SIGTERM'd app removes its own): median 85 / p90 93; second series 91 / 98. Exit 0, no output.
- app not running, no socket file: median 87 / p90 90 (78 / 82 in the series run right after the app quit). Exit 0, no output.
- Budget (median under 300 ms) met by a wide margin and level with the dev build in Task 13 (median 85-89 / p90 91-98 ms): packaging (asar read) costs nothing measurable. Limit of the measurement: the token was made up (a real one exists only inside a live Claude tab), so main rejected the event; the CLI side is fire-and-forget either way, so the time measured is spawn + connect + write.

Coverage (`npm run test:coverage`, v8; the script and the pinned `@vitest/coverage-v8` 5.0.5 already existed; `coverage/` is gitignored): all files 84.5% lines over `src/**/*.ts` only (`vitest.config.ts` coverage `include`): the `.tsx` React components are not in that figure at all, they are covered by e2e; Electron-only adapters and preload are `.ts`, counted, and mostly uncovered here (e2e covers them). Pure modules, lines / branches: `main/sessions/status-reducer.ts` 100 / 100, `main/sessions/send-gate.ts` 100 / 97.6, `shared/layout.ts` 100 / 94.8, `shared/manifest.ts` 100 / 100, `shared/keys.ts` 100 / 95.5, `shared/protocol.ts` 100 / 98.3, `main/restore.ts` 100 / 94.1. All above 90%; no coverage-only tests added.

Validation: `npm test` 1324 passed (62 files), `npm run typecheck`, `npm run lint`, `npm run test:e2e` 69 passed (after `npm run package`; no flake).

### Task 37: [Final] Update documentation [model: sonnet]

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/design.md` (§8 open points → decided)

- [x] update README.md: what works, how to run (`npm run dev`), how to link the hello plugin, the `ccc` CLI
- [x] update CLAUDE.md: replace the "State" section (no longer "no code yet"); add the commands (`npm test`, `npm run test:e2e`) and patterns found during implementation (adapter files for Electron-only modules, fake secrets env, data dir override)
- [x] update design.md §8 with the decisions from this plan (CLI `ccc`, userData + override, hook matchers, keybindings, idle not sendable)
- [x] move this plan to `docs/plans/completed/` (moved by the orchestrator after review phases)

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- Run real `claude` (not the fake) in a tab for a day: statuses match what the terminal shows,
  permission prompts show "needs permission" and never receive sent text, `--resume` after quit works.
- Check the trust-folder dialog on a new folder: status stays idle and queued text is not typed into it.
- Feel of the layout: splitter sizes, zone collapse, top strip with 5+ sessions across 3 windows.
- Keychain prompt behaviour on first token save on macOS; Linux with and without a secret service.
- OAuth with a real Google Cloud project client (refresh after an hour; re-login after 7 days for
  an unpublished app).
- Security review of the plugin protocol, the socket and the installer before installing any
  third-party plugin.

**External system updates:**
- CI (if added later): Linux e2e needs `xvfb-run`; mac builds need signing and notarisation
  credentials before the app is shared.
- First real plugins (Jira, Gmail, calendar, Forgejo, file tree, editor) each get their own design
  session, as noted in `CLAUDE.md`.
