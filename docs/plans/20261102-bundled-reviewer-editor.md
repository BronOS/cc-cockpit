# Bundled reviewer and editor plugins

External review: auto

## Overview
- Ship `cockpit.reviewer` (diff review with notes, Discuss / New session / Edit) and `cockpit.editor` (micro in
  a terminal overlay, provides `editor` v1) as bundled plugins, the way `cockpit.browser` is: source in
  `plugins/`, built output committed, shipped through `extraResources`, loaded by `main/plugins/bundled.ts`.
- Settle the rules the guide never stated: `cockpit.*` ids are reserved for bundled plugins, a bundled plugin can
  be turned off for the whole app, and a user replaces a bundled plugin through the existing picks.
- Work through every entry of `~/Projects/cc-cockpit-reviewer/FRICTION.md`: fix in core or answer in the guide,
  then remove the plugin's workarounds.
- Both plugins were built by an in-app Claude from `ccc guide` alone as linked plugins and tried by the user
  (milestones 1-3). They use only the public plugin API, and stay that way: no privilege for `cockpit.*` beyond
  being shipped (memory: bundled-plugins-direction; jev stays in the marketplace).

## Context (from discovery)
- Sources: `~/Projects/cc-cockpit-reviewer` (3 commits; `plugin.json`, plain-JS host `dist/host.js` +
  `dist/lib/{files,review}.js`, page `src/page/review.js` bundled by `scripts/build.mjs` (esbuild) into
  `overlay/review.bundle.js` ~1 MB, CodeMirror 6 + `@codemirror/merge` devDependencies, `test/*.test.js` on
  `node:test`, `docs/design.md`, `FRICTION.md`) and `~/Projects/cc-cockpit-editor` (1 commit; `plugin.json`,
  `dist/host.js`, `test/host.test.js` on `node:test`, app settings `autosaveSeconds`/`colorscheme`/`microPath`,
  CLI `edit`).
- Bundling today: `src/main/plugins/bundled.ts` (`BUNDLED_PLUGINS`, `bundledRoot`, `CC_COCKPIT_NO_BUNDLED`),
  `electron-builder.yml` extraResources `plugins/browser`, `scripts/build-browser.mjs` (deterministic, a unit
  test rebuilds and compares bytes), `package.json` `build` chain.
- Enablement: `src/main/plugins/enablement.ts` (per project `enabledPlugins`/`disabledPlugins`, bundled
  `enabledByDefault`). No app-wide switch exists.
- Picks: services provider pick and the `@open-file` pick (`src/shared/services.ts` `selectProvider`,
  `selectOpenFile`; `serviceProviders` in the project record; Settings > Plugins).
- Install paths that take an id: `ccc plugin link`, installer (folder / git), marketplace install, marketplace
  index tools (`marketplace/tools/src`, committed `dist`).

## Decisions (user, 2026-11-02)
- Files a session edits **outside** its project keep opening in the built-in viewer; plugins only ever receive
  project-relative paths. The guide states this.
- When a plugin reloads, is disabled, updated, uninstalled or its host stops, **main closes that plugin's open
  overlays**; `result` resolves as dismissed in the old copy. The new copy starts clean (pages already save
  drafts as they go).

Settled in this plan (the brief asks for a call, stated here so review can change it):
- **Reserved ids:** an id starting with `cockpit.` is accepted only for a plugin loaded from the app's bundled
  root. `ccc plugin link`, folder/git install, marketplace install and the marketplace index tools refuse it with
  a clear message. Third parties can still do everything the bundled plugins do, under their own id.
- **App-wide off:** each bundled plugin gets an app-level "Off in all projects" switch (app settings
  `disabledBundled: string[]`). Off app-wide wins over the project record; the per-project switch still works when
  it is on. Only bundled plugins get it (third-party plugins are per project by design, §5).
- **Replacing:** a bundled plugin is replaced through the existing picks, with no new mechanism: another plugin
  providing `editor` / `reviewer` appears in the provider pick, and another `openFile` plugin in "Plugin used to
  open files". A bundled plugin has no priority over a third-party one in `selectProvider`. Turning the bundled
  one off (project or app-wide) leaves the other as the only provider.
- **Tests of the moved plugins:** keep `node:test` (they are plain JS with no build), run by
  `npm run test:plugins` (`node --test plugins/*/test/`), which CI runs as its own step. Converting them to vitest
  would churn working tests for no gain.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- maintain backward compatibility: existing plugins and projects keep working; a user who linked the reviewer or
  editor from their old folders must unlink them first (same ids), which the docs say

## Testing Strategy
- **unit tests** (vitest): bundled specs, id reservation in every install path, app-wide enablement, overlay close
  on host stop, new ctx members, build determinism of the reviewer bundle.
- **plugin tests** (`node:test`): the moved reviewer and editor tests, run by `npm run test:plugins`.
- **e2e** (Playwright): bundled reviewer and editor load in a packaged-like run and are skipped with
  `CC_COCKPIT_NO_BUNDLED=1`; the reviewer opens from a modified-file click; app-wide off; replacing through the
  pick; an overlay closes when its linked plugin reloads. Known host failures on Linux: `window-bounds.spec.ts:40,:62`.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; document issues/blockers with ⚠️ prefix
- keep plan in sync with actual work done

## Solution Overview
1. Move the two repos under `plugins/reviewer` and `plugins/editor` with their history (`git subtree add`
   from the local repos; cheap), drop their own `package.json` build setup into the app's.
2. Add them to `BUNDLED_PLUGINS` and `extraResources`; `build:reviewer` like `build:browser`.
3. Make the rules true in code: reserved `cockpit.*`, app-wide off, overlays closed on reload; replacement is the
   existing picks, verified by tests.
4. Close the FRICTION gaps with small public APIs (`ctx.projectDir`, `ctx.services.available`, overlay `focus()`)
   and guide answers; then simplify the plugins to use them.
5. Docs describe the reviewer and editor as features, micro as an optional dependency.

## Technical Details

### FRICTION.md entries → outcome
| Entry | Outcome |
|---|---|
| no `ctx.projectDir` (host runs `pwd -P`) | **core**: `ctx.projectDir`, the project folder's real path (`realpath`), read-only; plugin drops `pwd -P` |
| `SessionInfo.files` undocumented | **guide** + type comment: absolute paths of files the session wrote, including outside the project; order and cap as in code |
| outside-project files not reviewable | **decided**: stay in the built-in viewer; guide says plugins only get project-relative paths |
| `cockpit.*` reserved? how to become bundled | **core + guide**: reserved for the bundled root; bundling is an app release, not a plugin feature |
| no way to focus an open overlay | **core**: `handle.focus()` on the `start()` handle (brings it to the front of the window's overlay stack; no-op after close); plugin uses it for a second click on the same file |
| `ctx.storage` key limits unstated | **guide**: state the real limits from `src/shared/plugin-storage.ts` (key length, value size, count) for both `storage` and `appStorage`; if a limit is missing in code, add it there |
| module scripts in overlay pages | **check + guide**: test whether `<script type="module">` and dynamic `import()` of a sibling file work in an html overlay under its CSP/sandbox; document the answer; if they fail only because of a fixable CSP detail that is safe to allow, allow it, otherwise say "classic scripts only" |
| no "is there a provider" call | **core**: `ctx.services.available(name): boolean` (host-local, same `serviceStatus` rule as calls, never cached); plugin hides Edit when false and drops the error-text match |
| overlay on plugin reload | **decided**: main closes the plugin's overlays; guide (dev-loop, api) says so |

### New public API
- `ctx.projectDir: string`: absolute real path of the project folder (resolved once per host start; a project
  folder doesn't move while its window is open).
- `ctx.services.available(name: string): boolean`: true when an enabled plugin in this project provides `name`
  at a compatible major version and the pick resolves to one; false otherwise. Never throws for an unknown name.
- `OverlayHandle.focus(): void`: bring this overlay to the front; no-op after close.
- Each ships with its `src/sdk/types.ts` entry (copied to `examples/plugin/sdk/types.ts`), guide text in
  `src/cli/guide/api.md`, and passes the drift tests.

### Bundled specs
```ts
{ id: 'cockpit.browser',  dir: 'browser',  enabledByDefault: true },
{ id: 'cockpit.reviewer', dir: 'reviewer', enabledByDefault: true },
{ id: 'cockpit.editor',   dir: 'editor',   enabledByDefault: true },
```
The editor is on by default: without micro, Edit shows how to install it instead of failing silently.

### Reviewer build
`scripts/build-reviewer.mjs` bundles `plugins/reviewer/src/page/review.js` into
`plugins/reviewer/overlay/review.bundle.js`, deterministic like `build-browser.mjs` (fixed target, no minifier
unless the current bundle relies on it, `absWorkingDir` the plugin folder, no absolute paths), with a unit test that
rebuilds into a temp dir and compares bytes. The host stays plain JS (no build). CodeMirror packages and the
`@lezer/highlight` dependency become app devDependencies at the versions in the reviewer's lockfile.

## What Goes Where
- **Implementation Steps**: code, tests, guide, docs in this repo.
- **Post-Completion**: manual checks in the installed app, archiving the source repos, release.

## Implementation Steps

### Task 1: Move the reviewer and editor into plugins/ [model: sonnet]

**Files:**
- Create: `plugins/reviewer/**`, `plugins/editor/**` (from the two repos)
- Create: `scripts/build-reviewer.mjs`, `test/unit/reviewer-plugin.test.ts`
- Modify: `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `eslint.config.*` / tsconfig excludes if
  needed, `CLAUDE.md` (Commands)

- [x] `git subtree add --prefix plugins/reviewer ~/Projects/cc-cockpit-reviewer master` and the same for
      `plugins/editor` (history kept; if subtree is unavailable or messy, one commit per plugin naming the source
      repo and its HEAD). Remove each plugin's `node_modules`, `package.json`, `package-lock.json` from the moved
      tree; keep `README.md`, `docs/`, `FRICTION.md`, `test/`
- [x] `.gitignore` ignores `dist/` and whitelists only `!plugins/browser/dist/`: add `!plugins/reviewer/dist/` and
      `!plugins/editor/dist/`, check the subtrees' own `.gitignore` files don't hide `dist/` or `overlay/`, and
      confirm with `git ls-files plugins/reviewer plugins/editor` that `dist/**`, `overlay/review.bundle.js` and
      `plugin.json` are tracked
- [x] add the reviewer's CodeMirror/lezer packages as app devDependencies pinned exactly to its lockfile versions;
      `scripts/build-reviewer.mjs` (deterministic, see Technical Details; `legalComments: 'none'` unless a licence
      notice must ship, in which case decide where it goes and commit it) and `npm run build:reviewer`; add it to the
      `build` chain; rebuild the committed bundle and check the page still loads the same (size within a few %)
- [x] `npm run test:plugins` = `node --test plugins/*/test/`; fix any path assumptions in the moved tests; add a CI
      step running it in `ci.yml` and extend the `describe('ci.yml')` block in `test/unit/release-workflow.test.ts`
      for it (first-party actions only); check `vitest.config` doesn't pick up `plugins/*/test/*.test.js`
- [x] `eslint.config.js` ignores only `plugins/browser/dist/**`: add `plugins/{reviewer,editor}/dist/**`,
      `plugins/reviewer/overlay/*.bundle.js` and the plugins' `test/`, `scripts/` and `src/page` JS (or lint them
      with a plain-JS config if that is easy); typecheck needs no change (tsconfig.node covers only `plugins/hello/src`)
- [x] write `test/unit/reviewer-plugin.test.ts`: rebuild into a temp dir equals the committed bundle; the manifests
      validate with `validateManifest`
- [x] run `npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint` - must pass before next task

### Task 2: Ship them as bundled plugins [model: sonnet]

**Files:**
- Modify: `src/main/plugins/bundled.ts`, `electron-builder.yml` (extraResources and its header comment saying only
  the browser is bundled), `test/unit/packaging-config.test.ts`, `test/unit/bundled-plugins.test.ts`,
  `test/unit/browser-plugin.test.ts` if it asserts the bundled list
- Create: `test/e2e/bundled-plugins.spec.ts` (or extend the browser one)

- [x] add `cockpit.reviewer` and `cockpit.editor` to `BUNDLED_PLUGINS` (enabled by default)
- [x] add both folders to `extraResources` with the same filter style as the browser (no tests, no docs, no
      `src/` of the reviewer page in the package; the bundle, `dist/`, `plugin.json`, `overlay/`, README stay)
- [x] update the packaging unit tests that read `electron-builder.yml` and the bundled list
- [x] e2e: a run without `CC_COCKPIT_NO_BUNDLED` lists both in Settings > Plugins as built-in, on; a modified-file
      click opens the reviewer overlay (fake claude writes a file); with `CC_COCKPIT_NO_BUNDLED=1` neither loads
- [x] check that existing e2e specs that assume only the browser is bundled still pass (most set
      `CC_COCKPIT_NO_BUNDLED=1`); `npm run package:dir` and confirm both folders are in `release/*/resources/plugins`
- [x] run `npm test`, `npm run test:plugins`, typecheck, lint, `npm run build` and the touched e2e specs - must pass

### Task 3: Reserve cockpit.* ids for bundled plugins [model: opus]

**Files:**
- Modify: `src/main/plugins/validate.ts` or `src/shared/manifest.ts` (one rule, one place), `src/main/plugins/installer.ts`,
  the link path, `src/main/marketplace/*`, `marketplace/tools/src/*` (+ rebuilt `marketplace/tools/dist`)
- Modify: `src/cli/guide/plugins.md`, `src/cli/guide/dev-loop.md`

- [x] one shared rule `isReservedPluginId(id)`: the `cockpit.` prefix compared case-insensitively (check what the
      manifest id regex allows: uppercase, Unicode, surrounding spaces; the rule must hold for every id the regex
      accepts)
- [x] the authority is the **load** path, not only install: a plugin with a reserved id loads only when it is one of
      `BUNDLED_PLUGINS` and its folder's realpath equals the realpath of `<bundledRoot>/<dir>`. A symlink into the
      bundled root, a linked folder elsewhere, or a hand-edited `plugins.json` entry with a reserved id is refused at
      load with a log line (and shown in Settings > Plugins as refused, like other invalid plugins)
- [x] link, folder/git install and marketplace install also refuse a reserved id up front (realpath of the source,
      before copying anything) with "ids starting with cockpit. are reserved for plugins that ship with the app"
- [x] the marketplace index tools (`check-entry`, `build-index`) refuse reserved ids; run `npm run build:marketplace-tools`
      and keep the byte test green
- [x] an existing user's linked `cockpit.reviewer` / `cockpit.editor` record (in `plugins.json`): the bundled entry
      wins, the linked record is dropped at start with a log line; project enablement and settings keyed by the same
      id carry over unchanged (same id). No extra notice UI; the guide and release notes say to unlink
- [x] guide: plugins topic states the reservation and that bundling happens through app releases; dev-loop says to
      unlink an old linked copy of a now-bundled plugin; drift tests pass
- [x] unit tests for each path (link, folder install, git install, marketplace install, index tools, load-time refusal
      of a hand-edited `plugins.json` entry and of a symlink into the bundled root, `Cockpit.Foo` casing, the start-up
      drop of an old linked record) and that bundled loading still accepts them
- [x] run `npm test`, typecheck, lint, `npm run build:marketplace-tools` byte test - must pass
- [x] ➕ `plugins/hello` (`cockpit.hello`) and `examples/plugin` (`cockpit.example`) used reserved ids and could no
      longer be linked: renamed to `example.hello` and `example.plugin` (manifests, e2e and unit tests); `ccc plugin new
      --id cockpit.x` is refused too. The app's index parser drops a reserved listing (counted as skipped), so the
      Marketplace page never offers one

### Task 4: App-wide off for bundled plugins, and replacing them through the picks [model: opus]

**Files:**
- Modify: `src/main/plugins/enablement.ts`, `src/main/settings/settings-service.ts` / `src/shared/types.ts`
  (`AppSettings.disabledBundled`), `src/main/ipc/router.ts`, `src/renderer/settings/PluginsPage.tsx`, host restart path
- Modify: `src/cli/guide/plugins.md`

- [ ] `disabledBundled` in app settings; `pluginEnabledIn`/`enabledPluginIds` take it and an app-wide-off bundled
      plugin is off in every project regardless of the project record; changing it restarts the affected hosts the
      way a per-project toggle does
- [ ] Settings > Plugins: a bundled plugin shows "Off in all projects" (app-wide) next to the per-project switch;
      the per-project switch is disabled with a note while it is off app-wide
- [ ] verify replacement: `selectProvider` gives bundled no priority; with a third-party `editor` provider and the
      bundled editor both on, the pick lists both; with the bundled one off (project or app-wide) the other is used;
      the same for the `@open-file` pick with a third-party `openFile` plugin. Fix anything that doesn't hold
- [ ] guide (plugins): app-wide off, how to replace a bundled plugin (picks, turning it off), no priority for bundled
- [ ] unit tests (enablement with `disabledBundled`, router, picks with bundled + third-party) and an e2e (app-wide
      off hides it in a second project; replacing the open-file handler with a fixture plugin)
- [ ] run `npm test`, typecheck, lint, build and the touched e2e specs - must pass

### Task 5: Close a plugin's overlays when it reloads or stops; overlay focus() [model: opus]

**Files:**
- Modify: `src/main/overlays/overlay-manager.ts`, `src/main/plugins/host-manager.ts`, `src/main/plugins/host-api.ts`,
  `src/host/ctx/ui.ts`, `src/sdk/types.ts` (+ example copy), `src/cli/guide/api.md`, `src/cli/guide/dev-loop.md`

- [ ] gap analysis: a host stop already dismisses its overlays (`host-manager.ts` `disposeApi` → `rec.api.dispose`).
      List every way a plugin's code is replaced or turned off (dev-watch reload, disable, update, uninstall, crash,
      window close, a plugin-set change) and record here which ones do **not** go through `disposeApi`
- [ ] close the plugin's overlays on the paths that don't (if any), the same way `dispose` does; terminal overlays'
      ptys are killed as on a normal close. If every path already closes them, say so here and add only the missing
      test cases
- [ ] `focus()` on the `start()` handle: main brings that overlay to the front of its window's stack (ownership
      checked like `post`/`close`); no-op after close; types and guide
- [ ] `cp src/sdk/types.ts examples/plugin/sdk/types.ts` (the example's own code stays free of overlays)
- [ ] guide: dev-loop and api say overlays close on reload; api documents `focus()`
- [ ] unit tests (close on each stop reason, ownership of focus, focus after close) and e2e (edit a linked fixture
      plugin's file while its overlay is open → the overlay closes)
- [ ] run `npm test`, typecheck, lint, build and the overlays / plugin-dev-reload e2e specs - must pass

### Task 6: ctx.projectDir, ctx.services.available and the guide answers [model: opus]

**Files:**
- Modify: `src/host/ctx/index.ts`, `src/host/services.ts`, `src/host/loader.ts` (start data), `src/main/plugins/host-manager.ts`
- Modify: `src/sdk/types.ts` (+ `examples/plugin/sdk/types.ts`), `src/cli/guide/api.md`, `src/cli/guide/panels.md`
- Modify: `src/shared/plugin-storage.ts` only if a limit is missing

- [ ] `ctx.projectDir` (real path, from main at host start) and `ctx.services.available(name)` using the shared
      `serviceStatus` rule (resolved on every call)
- [ ] guide: `SessionInfo.files` (absolute paths, outside-project files included, which open only in the built-in
      viewer); `storage`/`appStorage` limits stated from the code; the outside-files rule in the openFile text
- [ ] module scripts in html overlays: try `<script type="module">` and `import('./x.js')` in a fixture overlay, record
      the result here, and state it in the panels topic (fix only if a safe CSP change makes it work)
- [ ] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [ ] unit tests for both members (available: provider on/off/wrong major/pick unresolved/unknown name; projectDir is
      the realpath through a symlinked project folder); drift tests
- [ ] run `npm test`, typecheck, lint - must pass

### Task 7: Remove the reviewer's and editor's workarounds [model: sonnet]

**Files:**
- Modify: `plugins/reviewer/dist/host.js`, `plugins/reviewer/dist/lib/files.js`, `plugins/reviewer/src/page/review.js`
  (+ rebuilt bundle), `plugins/reviewer/test/*`, `plugins/reviewer/docs/design.md`, `plugins/reviewer/FRICTION.md`
- Modify: `plugins/editor/dist/host.js`, `plugins/editor/README.md`, `plugins/editor/test/*`

- [ ] reviewer: `ctx.projectDir` instead of `pwd -P`; Edit hidden when `ctx.services.available('editor')` is false
      (re-checked when the overlay opens), no error-text match; a second open of the same file calls `focus()`
      on the existing handle; keys shortened if the storage limits require it
- [ ] editor: when micro is missing, the message names the install command per system (`brew install micro`,
      `sudo pacman -S micro`, `sudo apt install micro`, or https://micro-editor.github.io) and the `microPath` setting
- [ ] update the plugins' design note Status line and strike or annotate each FRICTION.md entry with its outcome
- [ ] update the plugin tests (`node:test`) for the new behaviour; rebuild the bundle (`npm run build:reviewer`)
- [ ] run `npm run test:plugins`, `npm test` (the bundle byte test) and the bundled-plugins e2e - must pass

### Task 8: Verify acceptance criteria [model: sonnet]
- [ ] every requirement in Overview and Decisions is implemented; every FRICTION.md entry has its outcome in the table
- [ ] edge cases: a user with an old linked `cockpit.reviewer` gets the notice and the bundled copy; app-wide off +
      project on; a third-party provider replaces each bundled plugin
- [ ] run full test suite: `npm test`, `npm run test:plugins`, `npm run test:coverage` (thresholds hold)
- [ ] run e2e tests: `npm run test:e2e` (only `window-bounds.spec.ts:40,:62` may fail on this Linux host)
- [ ] `npm run package:dir` and launch it with a temp `CC_COCKPIT_DATA_DIR`: the reviewer and editor are listed as built in

### Task 9: [Final] Update documentation [model: sonnet]
- [ ] `docs/design.md`: bundled set (browser, reviewer, editor), reserved ids, app-wide off, replacing through
      picks, overlay close on reload, the new ctx members; the reviewer's design summarised or linked from `plugins/reviewer/docs/design.md`
- [ ] `docs/features.md`: reviewer and editor as features; micro as an optional dependency (how to install it on
      Mac and Linux, and that Edit shows how to install it when it is missing); known limitations (outside-project files)
- [ ] `README.md`: the reviewer and editor in the feature list, micro under requirements as optional
- [ ] `CLAUDE.md`: `build:reviewer`, `test:plugins`, the reserved-id rule, and that bundled plugins use only the public API
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification**
- Before trying it in the installed app: `ccc plugin unlink cockpit.reviewer` and `ccc plugin unlink cockpit.editor`
  (same ids as the bundled copies), then install the new build.
- Review a changed file end to end: notes, draft kept on close, Discuss to a busy and an idle tab, New session, Edit
  with micro installed and without it.
- Turn the reviewer off app-wide and check the built-in viewer comes back.

**External**
- Archive or delete `~/Projects/cc-cockpit-reviewer` and `~/Projects/cc-cockpit-editor` once the move is merged
  (nothing was pushed from them).
- Push the example repo's `sdk/types.ts` (new ctx members) and its renamed id (`example.plugin`, was `cockpit.example`)
  after the merge; if the public index lists `cockpit.example`, replace that listing (the app now drops it).
- Release when the user asks.
