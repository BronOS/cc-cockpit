# Friction round 1: fixes and APIs from the first in-app plugin build

External review: auto

## Overview
- The in-app Claude built a real plugin pair (`bronos.jev` provider and `bronos.jev-demo` consumer, in
  `~/Projects/cc-cockpit-jev`) using only `ccc guide` and the `ccc plugin` commands. It works, and every
  gap it hit is in `~/Projects/cc-cockpit-jev/FRICTION.md`. This round fixes those gaps.
- Three app bugs (secrets unusable on Linux desktops Electron doesn't recognise, a `ccc` plugin command
  hanging during a reload, black plugin icons), four API additions chosen by the user (app-wide plugin
  storage, caller id for service providers, `ccc plugin config` / `ccc panel show`, `ccc guide types`),
  a guide pass answering every "unclear or silent" item, and scaffold/dev-loop fixes.
- Scope agreed with the user; do not re-ask. Read FRICTION.md before any task: it is the requirement
  source, with file references into the plugin repo showing each workaround.

## Context (from discovery)
- Secrets: `src/main/secrets/secret-store.ts` (the "no OS keyring" error), `src/main/index.ts` (the only
  `safeStorage` importer; app start-up, where command-line switches must be set before `ready`).
- Plugin CLI calls: `src/main/plugins/cli-call.ts` (`timeoutMs` → exit 124), `src/main/plugins/host-manager.ts`
  (`cli.run` / `cli.cancel`, `reloadPlugin`, `plugin.reload`), `src/host/loader.ts` (reload), `src/host/index.ts`.
- Icons: `src/renderer/zones/IconStrip.tsx` (plugin icon drawn with `<img>`), `src/renderer/styles.css`.
- Services: `src/host/services.ts` (`ServiceRegistry`, AsyncLocalStorage call chain), `src/host/ctx/index.ts`,
  `src/sdk/types.ts`.
- Storage: `src/host/ctx/storage.ts` (`ctx.storage`, per project), `HostPluginSpec.dataDir/storageFile`,
  `src/main/plugins/host-api.ts` (host → main RPC methods, `pluginId` checked against the host's ids).
- CLI: `src/cli/index.ts`, `src/cli/args.ts`, `src/cli/client.ts`, `src/cli/guide.ts` (bundled topics,
  `src/cli/raw.d.ts` for raw imports), `src/cli/plugin-new.ts`, `src/cli/plugin-template/`;
  main side `src/main/socket/socket-server.ts` (how a `ccc` call learns its project: tab token or named project).
- Settings: settings validation and save path used by Settings > Plugins (`settings.pluginSettingsSave`),
  secret fields (`"format": "secret"`, `setting:` keys).
- Guide topics `src/cli/guide/*.md` with drift tests `test/unit/cli-guide.test.ts`, `test/unit/claude-plugins.test.ts`.
- Tests: unit `test/unit/`, e2e `test/e2e/` with fixture plugins in `test/fixtures/plugins/`.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- a new `ctx` member or `ccc` command gets its guide text in the same task (CLAUDE.md; drift tests)
- existing plugins keep working unchanged

## Testing Strategy
- **unit tests**: required for every task (`npm test`)
- **e2e tests**: `npm run build && npx playwright test <spec>`; UI and CLI changes get e2e coverage in the
  same task. Known failures on this Linux host, also on master: `window-bounds.spec.ts:40,:62`
  (sometimes `project-color.spec.ts:63`, `tab-command-overlays.spec.ts:51`).

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix, blockers with ⚠️ prefix

## Solution Overview
- **Keyring**: on Linux, before `ready`, when no `--password-store` switch was given and the Secret
  Service (`org.freedesktop.secrets`) has an owner on the session bus, append `password-store=gnome-libsecret`.
  The check runs argv-only with a short timeout and never blocks start-up on failure. When encryption is still
  unavailable, the error a user sees names the cause and the fix (a running keyring such as gnome-keyring or
  KeePassXC's Secret Service, or the switch).
- **CLI call during reload**: find why a `cli.run` sent while a plugin reloads is lost and why the 30 s
  timer does not end it; the call must be answered by the new copy (waiting for its activation like service
  calls do) or fail with exit 124 after the limit, never hang.
- **Icons**: plugin panel icons render as a CSS mask (`mask-image: url(...)`, `background-color: currentColor`)
  so they take the same colours as core icons (theme, hover, open). Icon format and size documented.
- **Caller id**: `ctx.services.caller()` returns the calling plugin's id while a provider method (or code it
  awaits) runs on behalf of a call, `undefined` elsewhere. Set by the registry from the bound ctx of the
  consumer, never from arguments. Plugins share one realm, so this is a contract against honest mistakes and
  label-faking through arguments, not a security boundary (state that in the guide).
- **App-wide storage**: `ctx.appDataDir` (`<data>/plugin-data/_app/<pluginId>/`, created on first read) and
  `ctx.appStorage` with `get`, `set`, `delete`, `keys` and `increment(key, by = 1) → new value`. Main owns
  the store (one file per plugin, writes serialised in main), so hosts of several windows stay consistent;
  hosts reach it by RPC with the usual `pluginId` check. Same key/value limits as `ctx.storage`. Kept on
  uninstall like project plugin data (only secrets are deleted). `_app` can never collide with a project id
  (check the project id format and say so in a comment).
- **`ccc plugin config`**: `ccc plugin config <id>` prints the plugin's app and project settings (secret
  fields as "set"/"not set"); `ccc plugin config <id> [--app|--project] key=value ...` sets top-level
  fields. Values parse as JSON, falling back to a string. Validation is the same as the Settings form's;
  secret fields are refused with a message pointing to Settings > Plugins. Project scope is the caller's
  project, found the way other project-scoped `ccc` commands find it. Saving goes through the same path as
  the Settings form (so `onSettingsChange` / restarts behave identically).
- **`ccc panel show <plugin>/<panel>`**: reveals the panel in the caller's project window, as
  `ctx.panels.show` does for the plugin itself; refuses a panel of a plugin not enabled there.
- **`ccc guide types`**: prints `src/sdk/types.ts`, bundled into the CLI like the guide topics; a drift test
  keeps the bundled copy equal to the source.
- **Guide pass** answers each FRICTION "unclear or silent" item from the code (see Task 9's list).
- **Scaffold / dev loop**: template indentation; `ccc plugin new` may create a nested plugin inside an
  existing plugin folder in either order; the dev watcher ignores nested folders that hold their own
  `plugin.json` (so editing the nested plugin doesn't reload the parent), or the guide states the behaviour
  if changing it is not right.

## Technical Details
- **Keyring check**: `dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus
  org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets` via `execFileSync` (argv, no shell),
  timeout ~1 s. `dbus-send` can be missing (minimal installs), and a silent miss would leave the bug in place,
  so: owner found → append; check impossible (no `dbus-send`, error) → append anyway when
  `DBUS_SESSION_BUS_ADDRESS` is set and `XDG_CURRENT_DESKTOP` is not one Electron already recognises (GNOME,
  KDE, Unity, XFCE, ...; read Electron's list), and let `safeStorage` report unavailable if there really is no
  keyring; no owner → don't append. Skip when `process.argv` already has `--password-store`, when not Linux,
  and in test runs that fake secrets. Put the decision in a small pure function with injected runner/env for
  unit tests; only `main/index.ts` calls `app.commandLine.appendSwitch`, at the top next to the existing
  pre-`ready` code (before `selectSecretStore` and before `app.whenReady`).
- **appStorage RPC**: new host → main methods (e.g. `appStorage.get|set|delete|keys|increment`) added to
  `host-api.ts`'s allow-list; main validates key pattern and value size like `ctx.storage`; `increment`
  requires the stored value to be a number or absent, else a clear error.
- **caller()**: the ALS frame for a provider method already knows the caller (the chain); expose the
  innermost caller's plugin id to the provider's bound ctx. Listeners of events get `undefined`. ALS
  propagates into timers a provider starts during a call; `caller()` returns the id only while that call
  is still running (the same "frame counts only while its method runs" rule the cycle detection uses), and
  `undefined` after it returned, so a late timer can't be attributed to a finished call.
- **appStorage vs storage**: `ctx.storage` stays host-local (per project, one host writes it). App storage is
  shared by the hosts of every window, and only main is a single process, so it is main-owned RPC.
- **ccc plugin config** output: plain text lines `scope key = JSON`, `--json` for machine use.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: the in-app Claude re-checks the jev plugin against the new guide; Mac check.

## Implementation Steps

### Task 1: Secrets work on Linux desktops Electron doesn't recognise [model: sonnet]

**Files:**
- Create: `src/main/secrets/password-store.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/secrets/secret-store.ts`
- Create: `test/unit/password-store.test.ts`
- Modify: `src/cli/guide/settings-secrets.md`

- [x] pure decision function (platform, argv, env, injected bus check) per Technical Details; `main/index.ts` appends the switch before `ready` when it says so
- [x] the "cannot store secrets" error names the cause and the fix (running Secret Service keyring, or the `--password-store` switch)
- [x] guide: what an unavailable keyring means for a user and a plugin (no plaintext fallback by design)
- [x] write tests: Linux with owner → switch; no owner → none; check impossible + unrecognised desktop + bus address → switch; check impossible + recognised desktop → none; already has switch / not Linux / fake secrets → none
- [x] run tests - must pass before next task

### Task 2: A plugin `ccc` command during a reload never hangs [model: opus]

**Files:**
- Modify: wherever the cause is: `src/main/socket/handlers.ts` (the `plugin.cli` path), `src/main/plugins/host-manager.ts` (`runCli`, `rec.reloads` / `rec.ran` / `rec.proc`, `rec.rpc` read while the old copy is torn down), `src/main/plugins/cli-call.ts`, `src/cli/client.ts`, `src/host/loader.ts`, `src/host/index.ts`
- Modify: matching unit tests; e2e `test/e2e/plugin-cli.spec.ts` or `plugin-dev-reload.spec.ts`

- [x] reproduce: send a plugin CLI command right after a linked plugin's files change (and right after app start). `callCli` already has a 30 s timer, so a >120 s hang means the wait is before it starts or outside it: check the suspects above (FRICTION.md has timings)
- [x] add a client-side hard deadline in `src/cli/client.ts` (the limit plus a margin) as a backstop, exiting 124 with a message
- [x] fix so the call is served by the new copy once it is active, or exits 124 after the limit; never hangs
- [x] write a unit test that fails before the fix, going through the socket handler and HostManager with a fake host (call issued during reload), not only `callCli`; and an e2e for the dev-loop case
- [x] run tests - must pass before next task

### Task 3: Plugin panel icons follow the theme [model: sonnet]

**Files:**
- Modify: `src/renderer/zones/IconStrip.tsx`, `src/renderer/styles.css`
- Modify: `src/cli/guide/panels.md` (icon format: SVG, size, drawn as a single-colour mask)
- Modify: an e2e that shows a plugin icon (e.g. `test/e2e/panels.spec.ts`)

- [x] render plugin icons as a mask in `currentColor` with the same hover/open states as core icons. CSP and CORS already allow it (`img-src` covers `cc-plugin:`, the protocol sends ACAO and is `corsEnabled`)
- [x] keep the fallback letter for plugins without an icon and for an icon that fails to load: a CSS mask can't report errors, so keep a hidden `<img>`/`Image()` probe (or equivalent) driving the existing `failed` state
- [x] write an e2e asserting the icon element uses the mask and takes the strip's colour (computed style), and that a missing/broken icon still shows the fallback letter
- [x] run tests - must pass before next task

### Task 4: `ctx.services.caller()` for providers [model: opus]

**Files:**
- Modify: `src/host/services.ts`, `src/host/ctx/index.ts`, `src/sdk/types.ts`
- Modify: `test/unit/host-services.test.ts`
- Modify: `src/cli/guide/api.md`; copy `src/sdk/types.ts` to `examples/plugin/sdk/types.ts`

- [x] `caller()` per Technical Details: the calling plugin's id inside a provider method and anything it awaits for that call; `undefined` in activate, timers not started by a call, and event listeners
- [x] guide: what it is for (per-caller usage, caps), that it can't be set through arguments, and that it isn't a security boundary
- [x] write tests: two consumers see their own ids; nested call A→B→C shows B inside C; concurrent calls don't mix ids; `undefined` outside calls and in activate; a timer started during a call sees the id while the call runs and `undefined` after it returned
- [x] run tests - must pass before next task

### Task 5: App-wide plugin storage [model: opus]

**Files:**
- Create: `src/main/plugins/app-storage.ts`
- Modify: `src/main/plugins/host-api.ts`, `src/main/plugins/host-manager.ts`, `src/host/ctx/index.ts` (or a new `src/host/ctx/app-storage.ts`), `src/host/loader.ts` (`HostPluginSpec.appDataDir`), `src/sdk/types.ts`
- Create: `test/unit/app-storage.test.ts`; modify host-manager/ctx tests
- Modify: `src/cli/guide/api.md`; copy types to `examples/plugin/sdk/types.ts`

- [x] main-owned store per Technical Details (one file per plugin, writes serialised, atomic file replace). Share the key validation and limits with `src/host/ctx/storage.ts` through one module in `src/shared/` (no copy). Host → main methods `appStorage.get`, `appStorage.set`, `appStorage.delete`, `appStorage.keys`, `appStorage.increment` added to `host-api.ts`'s allow-list and its header comment. `HostPluginSpec.appDataDir` set by main; the `_app` folder created lazily by main on first use
- [x] `ctx.appDataDir` and `ctx.appStorage` (`get`, `set`, `delete`, `keys`, `increment`) through RPC with the `pluginId` check
- [x] guide: when to use app vs project storage, concurrency guarantee (main serialises; `increment` is atomic across windows), that it survives uninstall
- [x] write tests: two hosts incrementing concurrently end at the exact sum; limits and key pattern; `increment` on a non-number errors; another plugin's id refused; a test that `_app` can never be a valid project id
- [x] run tests - must pass before next task
- ➕ an app value is capped at 1 MiB less 8 KiB (`MAX_APP_VALUE_LENGTH`) and the key list at the same as JSON: both cross the 1 MiB RPC message cap with their envelope; key rules and the 16 MiB total are ctx.storage's (`src/shared/plugin-storage.ts`)

### Task 6: `ccc plugin config` [model: opus]

**Files:**
- Modify: `src/cli/index.ts`, `src/cli/args.ts`, `src/shared/protocol.ts` (`TOKENLESS_COMMANDS` / `WINDOW_TOKEN_COMMANDS`), `src/main/socket/handlers.ts`, `src/main/index.ts` (wiring), and `src/main/ipc/router.ts` only to extract the save logic behind `settings.pluginSettingsSave` (`deps.savePluginSettings`) into something both callers use
- Modify: `test/unit/cli-commands.test.ts` (it runs every documented `--project` form)
- Modify: `src/cli/guide/cli.md`, `src/cli/guide/dev-loop.md`
- Modify: matching unit tests; e2e `test/e2e/plugin-cli.spec.ts` or a new spec

- [x] print and set per Solution Overview; reuse `deps.savePluginSettings` (validation, saving, restarts) from the socket handler; the project comes from the socket `caller` (tab token or `--project`), never from the payload; secrets refused; exit codes consistent with the CLI's
- [x] write tests: print (secret shown as set/not set), set valid value, invalid value refused with the schema error, secret refused, unknown plugin/field, project vs app scope
- [x] run tests - must pass before next task
- ➕ the scope flag is `--scope app|project`, not `--app|--project`: every `ccc plugin` subcommand already takes `--project <path>` for the folder, so a bare `--project` would be ambiguous. Default scope: the one whose schema declares the key; a key both declare needs `--scope`; one call sets one scope
- ➕ `router.ts` needed no change: the save logic already lived in `SettingsService.savePluginSettings` / `ProjectSettingsService.saveSettings` (on `saveSettingsForm`), which the IPC handlers and now `src/main/settings/plugin-config.ts` both call; the services gained `pluginAppSettings` / `pluginProjectSettings` (the views the pages show) for printing. e2e: `test/e2e/plugin-config.spec.ts` with a new fixture `test/fixtures/plugins/host-config`

### Task 7: `ccc panel show` [model: sonnet]

**Files:**
- Modify: `src/cli/index.ts`, `src/cli/args.ts`, `src/shared/protocol.ts` (command lists), `src/main/socket/handlers.ts`, whatever `ctx.panels.show` calls in main
- Modify: `test/unit/cli-commands.test.ts`
- Modify: `src/cli/guide/cli.md`
- Modify: e2e (e.g. `test/e2e/panels.spec.ts` or `plugin-cli.spec.ts`)

- [x] reveal `<plugin>/<panel>` in the caller's project window; refuse unknown panels and plugins not enabled there with clear messages
- [x] write e2e: the panel becomes visible after the command; error cases
- [x] run tests - must pass before next task
- ➕ the command is a new core command `panel` (reserved name, so `marketplace/tools/dist` was rebuilt); main refuses in this order: unknown plugin, not enabled in the project, no open window, no such panel (`LayoutService.show` false). Handler `panelShowHandler` in `socket/handlers.ts`; unit tests `test/unit/panel-show.test.ts`, e2e in `test/e2e/panels.spec.ts`

### Task 8: `ccc guide types` [model: sonnet]

**Files:**
- Modify: `src/cli/guide.ts` (and `src/cli/raw.d.ts` if needed), `src/cli/guide/overview.md` or `plugins.md` (mention it)
- Modify: `test/unit/cli-guide.test.ts`

- [x] bundle `src/sdk/types.ts` and print it for `ccc guide types`; listed in the guide's topic list (this task comes after Tasks 4 and 5 on purpose: they change the types the drift test compares)
- [x] write tests: output equals the source file byte for byte; topic listed
- [x] run tests - must pass before next task

### Task 9: Guide pass over the FRICTION questions [model: sonnet]

**Files:**
- Modify: `src/cli/guide/*.md` as needed
- Modify: drift tests only if they need it

- [ ] answer each item after checking the code (state behaviour, not intent): `ctx.onSettingsChange` argument shape and whether `ctx.settings` updates; whether `ctx.panels.onMessage` returns a disposer; what `ctx.panels.post` does when the panel is closed/never opened; service call limits (rate, concurrency, size) or their absence; the full list of theme CSS variables a panel may use (including muted/accent/error if they exist; add tokens to the list only if they already exist in the app); inline `<style>` under the panel CSP; the known top-level manifest keys; per-command/CLI description fields; settings-form keywords that render (`enum` labels, `description`, `integer`/`number`, conditional fields support or not); what an unset secret reads as at activate; Node version and globals in the host (`fetch`); whether `require` of sibling files from `main` is supported; that enabling/linking a plugin restarts the project's host; what the `[…]` log prefix is
- [ ] keep the guide's style; no promises the code doesn't keep
- [ ] run drift tests and `npm test` - must pass before next task

### Task 10: Scaffold and dev-loop fixes [model: sonnet]

**Files:**
- Modify: `src/cli/plugin-template/*`, `src/cli/plugin-new.ts`, `src/main/plugins/dev-watch.ts`
- Modify: `test/unit/plugin-new.test.ts`, `test/unit/dev-watch.test.ts`

- [ ] consistent indentation in the generated files
- [ ] `ccc plugin new` can create a nested plugin inside an existing plugin folder and a parent around an existing nested one (refuse only when files would be overwritten)
- [ ] the watcher of a linked plugin ignores nested folders with their own `plugin.json` (beside the fixed `IGNORED_DIRS`, and also in the polling signature Linux uses), or, if that is wrong for a reason found in the code, the guide states the behaviour (add ➕ note)
- [ ] write tests for each
- [ ] run tests - must pass before next task

### Task 11: ➕ Offer to install `ccc` at start-up [model: sonnet]

Added by the user during the run: when the app starts and `ccc` isn't available, ask once whether to install it.

**Files:**
- Modify: the existing "Install ccc command" code (Settings > Appearance and keys > Command line; find it from `src/main/index.ts`, `src/main/ipc/router.ts`, `src/shared/ipc.ts`), the app settings store (`app.json`) for a "don't ask again" flag
- Create/Modify: a modal in the renderer, following the existing confirm dialogs (e.g. the close-tab confirm)
- Modify: `test/e2e/ccc-install.spec.ts` and unit tests for the check

- [ ] main decides "not available" with the same check the Settings row uses to show its state (link missing, broken, or pointing at another app path); check once per app launch, not per window, and show the question in the first project window only
- [ ] modal: says what `ccc` is for (Claude in tabs, plugins, scripts talk to the app), buttons Yes (install, same code path as the Settings button, then show the result or the error, including when `~/.local/bin` is not on PATH) and No, plus a "Don't ask again" checkbox saved in app settings; Settings shows the flag so it can be turned back on
- [ ] never shown in test runs unless a test asks for it (`CC_COCKPIT_TEST` hook), never shown when already installed and current
- [ ] write tests: unit for the decision (installed / missing / stale / don't-ask flag); e2e: modal appears when missing, Yes installs (link exists), No closes, "Don't ask again" persists across a relaunch
- [ ] run tests - must pass before next task

### Task 12: Verify acceptance criteria [model: sonnet]
- [ ] verify every item of this plan and every FRICTION.md line is either fixed, answered in the guide, or listed in Post-Completion (not done in this round or outside the app)
- [ ] run full test suite: `npm test`, `npm run typecheck`, `npm run lint`
- [ ] run e2e tests: `npm run test:e2e` (only the known host failures may fail)

### Task 13: [Final] Update documentation [model: sonnet]
- [ ] `docs/design.md` (§5 ctx table: `ctx.appStorage`, `ctx.appDataDir`, `ctx.services.caller()`; §6 CLI: `ccc plugin config`, `ccc panel show`, `ccc guide types`; keyring note), `docs/features.md`, README `ccc` list if it names these commands
- [ ] `CLAUDE.md` if a new pattern appeared (e.g. main-owned app storage)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- In the released app, ask the in-app Claude (in `~/Projects/cc-cockpit-jev`) to re-read the guide, move the jev plugin to `ctx.appStorage` / `caller()` / `ccc plugin config`, and strike or update each FRICTION.md line.
- Store a secret on this Hyprland machine from the installed build (the keyring fix only shows in a real launch).
- Mac: the keyring change is Linux-only; check a plugin icon in light and dark theme.

**External system updates:**
- Push `sdk/types.ts` to `BronOS/cc-cockpit-plugin-example` (copied by hand).
- Jev/TypeSafe questions (score question fields, the direct model id) are outside the app.

**Not in this round:**
- A headless test kit for plugin host code (a published fake `ctx` or `ccc plugin test`, FRICTION line 25).
