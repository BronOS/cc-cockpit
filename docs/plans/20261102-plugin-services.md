# Plugin services: plugins calling each other within a project

External review: auto

## Overview
- Let one plugin offer a named API (a "service", e.g. `triage`) and other plugins in the same project
  call it and listen to its events. This is the core piece behind porting the old cockpit as plugins:
  a `triage` plugin owns the Jev setup, and the mail, Jira, Chat, Forgejo and calendar plugins use it.
- It replaces the "reserved for cross-plugin" `activate` return value (design.md §5, `loader.ts`,
  `sdk/types.ts`) with an explicit `ctx.services` API, and meets core criterion 3 in design.md §1
  ("connects parties that cannot reach each other directly ... later plugin ↔ plugin").
- All plugins of a project already run in one utilityProcess and one JS realm with no isolation
  (`src/host/loader.ts`, plain `require`; plugins are trusted). So this is a contract, not a security
  boundary, and calls are dispatched inside the host with no round trip to main.

## Context (from discovery)
- Host: `src/host/loader.ts` (`PluginLoader`, `HostPluginSpec`, `Loaded.exports` unused,
  `activateAll` runs `activate` concurrently with no order, 10 s timeout each; `reload` and `unload`
  replace one plugin in place), `src/host/ctx/index.ts` (`HostContexts.create(spec)` builds one ctx
  per plugin, released on deactivate), `src/host/index.ts`, `src/host/rpc.ts`.
- Main: `src/main/plugins/host-manager.ts` (builds `HostPluginSpec`s from manifests, `restart(projectId)`
  on enable/disable), `src/main/plugins/validate.ts` (`validateManifest`), `src/shared/manifest.ts`
  (`PluginManifest`, ajv `MANIFEST_SCHEMA`, unknown keys tolerated), `src/main/projects/registry.ts`
  and `src/shared/types.ts` (project record with `enabledPlugins`).
- UI: `src/renderer/settings/PluginsPage.tsx` (name, id, version, enable, settings).
- Docs and drift: `src/cli/guide/*.md` (`api.md` lists ctx members; drift tests `cli-guide.test.ts`,
  `claude-plugins.test.ts`), `src/sdk/types.ts` (copied to the public `BronOS/cc-cockpit-plugin-example`
  as `sdk/types.ts`; `examples/plugin` is its master copy), `docs/design.md` §5, `docs/features.md`.
- Tests: unit under `test/unit/`, e2e under `test/e2e/` with fixture plugins in `test/fixtures/plugins/`
  (`host-ok`, `host-ctx`, ...), `plugin-host.spec.ts`, `plugin-dev-reload.spec.ts`, `settings-plugins.spec.ts`.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - unit tests for new and modified functions, success and error paths
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change; existing plugins (no `services` field) keep working unchanged

## Testing Strategy
- **unit tests**: required for every task (`npm test`)
- **e2e tests**: Playwright (`npm run test:e2e`, or `npm run build && npx playwright test <spec>`);
  UI changes get e2e coverage in the same task. Known failures on this Linux host, also on master,
  not caused by this work: `window-bounds.spec.ts:40,:62`, `project-color.spec.ts:63`,
  `tab-command-overlays.spec.ts:51`.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix, blockers with ⚠️ prefix
- keep the plan in sync with the work actually done

## Solution Overview
- **Manifest** declares what a plugin offers and needs, with a whole-number major version:
  `"services": { "provides": { "triage": 1 }, "uses": { "mail-index": 2 } }`.
- **Provider** registers the implementation during (or after) `activate`:
  `ctx.services.provide('triage', { classify, rules })`. Only names in its own `provides` are accepted.
- **Consumer** gets a handle: `const triage = ctx.services.use('triage')` (only names in its own
  `uses`), then `await triage.classify(items, question)`; events with `triage.on('rulesChanged', fn)`,
  which returns a disposer. Provider emits with `ctx.services.emit('triage', 'rulesChanged', data)`.
- **Resolution on every call** (never a cached instance): host restarts, dev reload and provider
  errors replace or remove providers, and a handle must keep working across them.
- **Choosing a provider**: zero enabled providers, or two or more with no project choice, make calls
  fail with a clear error. The project record keeps `serviceProviders: { [service]: pluginId }`, set
  from the Plugins page; a change restarts the project's host (as enable/disable already does).
- **Decisions (agreed with the user, do not revisit)**: addressing by service name; two providers
  allowed with a project pick; a missing provider doesn't block enabling (the consumer runs, the
  Plugins page warns, calls throw); calls and events both in scope.

## Technical Details
- **Names**: service names `^[a-z][a-z0-9-]{0,63}$`; event names `^[A-Za-z][A-Za-z0-9._:-]{0,63}$`;
  method names: own enumerable function properties of the provided object only, never `then`,
  `constructor`, `__proto__`, `prototype` or names starting with `_`. Versions are integers 1..9999.
  A plugin may not both provide and use the same name (schema/validate error). At most 32 entries
  in each of `provides` and `uses`.
- **Handle**: a `Proxy` whose property access returns an async method stub; `then` reads as
  `undefined` so `await handle` does not hang; `on(event, fn)` is the one reserved member (so a
  service can't have a method named `on`; validate at `provide` time).
- **Call flow** (`src/host/services.ts`, `ServiceRegistry`):
  1. find the plugins of this host whose manifest provides the name; apply the project's choice;
     0 → `no enabled plugin in this project provides service "X"`; >1 unpicked →
     `plugins A and B both provide service "X"; pick one in Settings > Plugins`.
  2. version: consumer's `uses` major ≠ provider's `provides` major →
     `"X": <consumer> uses version N, <provider> provides version M`.
  3. await the provider's activation (the existing `Loaded.activation` promise, which never rejects);
     provider errored → error with its error text; active but `provide` was never called →
     `<provider> declares service "X" but did not provide it`. While the provider is being reloaded
     (its spec is still declared but its old copy is unloaded and the new one not yet registered),
     the call waits for the new activation instead of failing with "missing": the loader exposes an
     `activationOf(id)` that covers the reload gap (`unload` currently deletes the entry before
     `activateAll` re-adds it).
  3a. **Cycles during activate**: if A's `activate` awaits a call to B while B's `activate` awaits a
     call to A (or any longer cycle), both would hang until their 10 s timeout and both end errored.
     The registry tracks which plugins are mid-activate and a "waiting on" edge per call that waits
     for an activation; a wait that would close a cycle fails at once with
     `A -> B -> A: services called in a cycle during activate`.
  4. unknown method → error naming the service and method.
  5. `structuredClone` the argument list, call, `structuredClone` the result, both in the host. A
     function or symbol anywhere in it throws (`DataCloneError`, mapped to a clear error saying
     arguments, results and event data must be plain data); a class instance is copied as a plain
     object (prototype and methods dropped), which is documented, not an error. A provider throw is rethrown to the consumer
     as a new `Error` with the same `message` and `name` and a `service`/`plugin` field, never the
     provider's own object.
  6. No core timeout on calls (triage may be slow); consumers race their own if they need one.
     A call made while the provider is activating waits for that activation (its 10 s timeout bounds it).
- **Events**: `emit` is accepted only for a name the caller provides and only when the caller is
  the selected provider (a non-selected provider's emits are dropped and logged once). Delivery is
  async (microtask), the data is cloned once per listener, a listener's throw is caught and written
  to the consumer's plugin log. Subscriptions are keyed by service name, not provider instance, so
  they survive a provider reload or swap; they are removed when the consumer's ctx is released.
- **Lifecycle**: a provider's registrations are dropped when its ctx is released (deactivate,
  reload, unload, error). In-flight calls finish on the old implementation. `release` also resets
  the "logged once" flags of that plugin.
- **Main → host**: `HostPluginSpec` gains `services: { provides, uses }` (from the validated
  manifest; `parsePluginSpecs` treats an absent field as none, like `cli`/`panels`). The project's
  `serviceProviders` map comes from main with every `activate` message. The registry keeps each
  plugin's declarations: `setSpec(spec)` runs on activate and on `plugin.reload` (a dev reload can
  change the declared services), and `unload` removes them. A reload does not change the choices:
  a choice change restarts the host.
- **Restart paths** that already rebuild specs and so recompute the choices: enable/disable and
  `settingsChanged` (→ `restart(projectId)`), install/update/uninstall (`restartForPlugin` /
  `reloadPlugin`), plus the new pick change. Disabling the picked provider leaves a stale pick,
  which counts as no choice.
- **One selection rule**: `src/shared/services.ts` exports `selectProvider` and `serviceStatus`.
  The host registry (runtime) and main (Plugins page) both use them, over the same set of plugins:
  the specs main actually built for the host (a plugin dropped by `buildSpec`, e.g. invalid
  settings, is in neither), so the UI warnings and the runtime errors cannot disagree. Status per
  plugin: what it provides/uses and problems (`missing`, `ambiguous`, `version-mismatch`); per
  service: candidates and the selected one.

## What Goes Where
- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: pushing `sdk/types.ts` to the public example repo, manual check in the dev app.

## Implementation Steps

### Task 1: Manifest `services` field and validation [model: sonnet]

**Files:**
- Modify: `src/shared/manifest.ts`
- Modify: `src/main/plugins/validate.ts`
- Create: `src/shared/services.ts`
- Modify: `test/unit/manifest.test.ts`
- Create: `test/unit/services-status.test.ts`

- [x] add `services?: { provides?: Record<string, number>; uses?: Record<string, number> }` to `PluginManifest` and `MANIFEST_SCHEMA` (name pattern, integer 1..9999, at most 32 entries each); confirm the schema stays tolerant of unknown top-level keys
- [x] in `validateManifest`, refuse a name that is both provided and used by the same plugin, with a clear error
- [x] create `src/shared/services.ts` with the pure `selectProvider(service, plugins, choices)` and `serviceStatus(plugins, choices)` described in Technical Details (missing, ambiguous, version-mismatch, selected provider; a choice naming a plugin that is not a provider in the set counts as no choice). Tasks 2-6 use these, never their own copy of the rule
- [x] write tests for valid manifests (with and without `services`) and the schema/validate errors
- [x] write tests for `serviceStatus`: none, one, two unpicked, two picked, stale pick, version mismatch
- [x] run tests - must pass before next task

### Task 2: Host service registry: provide, use and calls [model: opus]

**Files:**
- Create: `src/host/services.ts`
- Create: `test/unit/host-services.test.ts`

- [x] create `ServiceRegistry` holding, per host, each plugin's declared `services`, the project's choices, the registered implementations and a way to await a plugin's activation state (injected, so the unit test needs no loader)
- [x] `provide(pluginId, name, impl)`: only declared names, impl must be a plain object of functions with valid method names, `on` reserved; a second `provide` of the same name by the same plugin replaces the first
- [x] `use(pluginId, name)` returns the Proxy handle; undeclared names throw synchronously; `then` is undefined
- [x] implement the call flow steps 1-6 (including 3a, cycle detection) from Technical Details, resolving the provider on every call with `selectProvider` from Task 1
- [x] write tests: successful call, args/results copied (mutation on either side doesn't leak), class instance arrives as a plain object, waits for a still-activating provider, every error message (missing, ambiguous, version, errored provider, never provided, unknown method, function/symbol in data, provider throw rethrown as a fresh Error)
- [x] write tests: A calls B while B calls A during activate fails at once with the cycle error (and a three-plugin cycle); A calling B during A's activate with no cycle works
- [x] write tests: provider replaced between two calls (second call reaches the new implementation); provider removed (call fails with the missing/never-provided error)
- [x] run tests - must pass before next task

### Task 3: Service events [model: opus]

**Files:**
- Modify: `src/host/services.ts`
- Modify: `test/unit/host-services.test.ts`

- [x] `emit(pluginId, service, event, data)`: only the selected provider of a service it declares; others dropped and logged once per plugin and service; event name pattern checked
- [x] `on(consumerId, service, event, fn)` from the handle, returning a disposer; delivery async, data cloned per listener, a listener throw caught and logged to the consumer's log
- [x] `release(pluginId)`: drop the plugin's implementations, its subscriptions (consumer side) and its "logged once" flags; keep other plugins' subscriptions to its services
- [x] write tests: delivery to several consumers, disposer stops delivery, non-selected provider's emit dropped, listener throw contained, subscriptions survive provider release and re-provide, released consumer receives nothing
- [x] ➕ decisions: a consumer whose `uses` major differs from the provider's gets no events (stays subscribed; consistent with calls failing); an emit with no subscribers is a silent no-op; the event name and plain-data checks run before the drop and the subscriber lookup, so they throw even then
- [x] ➕ a handle obtained before its consumer's `release` can no longer subscribe (a leftover timer of the old copy would otherwise listen beside the new copy); Task 4's ctx must call `use` again in the new activation, which it does naturally
- [x] run tests - must pass before next task

### Task 4: Wire services into the host loader and ctx [model: opus]

**Files:**
- Modify: `src/host/loader.ts`
- Modify: `src/host/ctx/index.ts`
- Modify: `src/host/index.ts`
- Modify: `src/main/plugins/host-manager.ts`
- Modify: `src/sdk/types.ts`
- Modify: `src/cli/guide/api.md` (and the manifest topic if it lists manifest fields)
- Modify: `test/unit/host-loader.test.ts`, `test/unit/host-manager.test.ts`, and drift tests if needed (`cli-guide.test.ts`, `claude-plugins.test.ts`)

- [x] `HostPluginSpec` gains `services` (from the validated manifest, set by main); `parsePluginSpecs` treats an absent field as none; the host's activate message carries the project's `serviceProviders`, which host-manager reads through a new dependency `serviceProviders(projectId)` (Task 5 backs it with the project record; here it is stubbed in tests and returns `{}` in `main/index.ts`)
- [x] one `ServiceRegistry` per host; `ctx.services` = `{ provide, use, emit }` bound to the plugin id; `setSpec` on activate and `plugin.reload`, declarations removed on `unload`; `release` called wherever a ctx is released (deactivate, reload, unload, errored activation)
- [x] loader `activationOf(id)` that also covers the reload gap (Technical Details step 3)
- [x] ➕ loader `isActivating(id)`: synchronous, true while `activationOf(id)` is unsettled (the reload gap included); Task 2's `ServiceRegistry` takes `{ activationOf, isActivating, log? }` and needs it for cycle detection (a promise cannot be asked synchronously whether it settled)
- [x] remove `Loaded.exports` and the "reserved for cross-plugin" comments in `loader.ts` and `sdk/types.ts`; `activate`'s return value is ignored (document it)
- [x] add `ServicesApi` and `ServiceHandle` types to `src/sdk/types.ts`
- [x] document `services` in the manifest and `ctx.services` in `src/cli/guide/api.md` in this same task (CLAUDE.md: a new `ctx` member needs its guide text in the same change, and the drift tests check it)
- [x] write tests: two plugins in one loader, consumer calls provider while both activate concurrently; a call issued mid-`reload` of the provider waits and reaches the new copy; a reload that changes the provider's declared services is honoured; `parsePluginSpecs` with and without `services`; host-manager passes `services` and the stubbed choices into the host
- [x] ➕ the loader owns the registry (`loader.services`; ctx gets it through a `services` getter dep); a reload sets the new spec first and keeps it through the gap (`unload(id, { keepSpec })`), plain `unload` removes it at once; `parseServiceProviders` reads the activate's picks
- [x] ➕ `npm run build:example` does not copy `sdk/types.ts`; it is a plain `cp src/sdk/types.ts examples/plugin/sdk/types.ts` (Task 8 too)
- [x] run tests - must pass before next task

### Task 5: Project provider choice in main [model: opus]

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/projects/registry.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/router.ts`
- Modify: `src/main/index.ts` and/or `src/main/plugins/host-manager.ts`
- Modify: matching unit tests (registry, router)

- [x] project record gains optional `serviceProviders: Record<string, string>` (absent in older records = no choices); back Task 4's `serviceProviders(projectId)` dependency with it
- [x] IPC `settings.pluginServices` (status for the asking window's project, via `serviceStatus` over the specs main built for that project's host) and `settings.pluginServiceProvider { service, pluginId | null }`, matching the page's existing `settings.plugin*` channels. Find how the existing project-scoped `settings.*` handlers learn the asking window's project (Settings is a layer inside the project window) and do the same; never take a project id from the renderer. Main checks that the service is known and that the plugin is a provider of it in that project; a change restarts that project's host
- [x] the restart paths listed in Technical Details recompute the choices; a stale choice (picked provider disabled or uninstalled) counts as no choice, no cleanup needed
- [x] write tests for the registry field, the IPC validation (unknown service, non-provider, another project's plugin), the restart on change, and that disabling the picked provider gives "no choice" status (not an error)
- [x] run tests - must pass before next task

### Task 6: Plugins page shows services, warnings and the provider pick [model: sonnet]

**Files:**
- Modify: `src/renderer/settings/PluginsPage.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `test/e2e/settings-plugins.spec.ts`
- Create: fixture plugins under `test/fixtures/plugins/` as needed (e.g. `svc-provider`, `svc-provider-2`, `svc-consumer`)

- [x] each plugin row shows "Provides: triage v1" / "Uses: triage v1" when declared (plain text)
- [x] warnings on the consumer's row: "Needs a plugin that provides triage", "Uses triage v2, but <name> provides v1"
- [x] when two enabled plugins provide one service, a project-level select "Plugin used for triage" lists them; picking calls `settings.pluginServiceProvider`
- [x] write e2e: missing-provider warning appears and goes away once a provider is enabled; with two providers the select appears and picking one is saved
- [x] run tests - must pass before next task

### Task 7: End-to-end calls and events between real plugins [model: sonnet]

**Files:**
- Create: `test/e2e/plugin-services.spec.ts`
- Modify: the fixture plugins from Task 6 (provider exposes a method and emits an event; consumer calls it and reports results through a panel, `ctx.log` or a CLI command, whichever existing fixtures already use to report)

- [ ] e2e: the consumer's call returns the provider's answer in a running app
- [ ] e2e: an event emitted by the provider reaches the consumer
- [ ] e2e: with the provider disabled, the consumer still runs and its call reports the missing-provider error
- [ ] e2e: with two providers, the picked one answers, and changing the pick switches it
- [ ] run tests - must pass before next task

### Task 8: Guide polish and example plugin types [model: sonnet]

**Files:**
- Modify: `src/cli/guide/api.md` (the base text landed in Task 4)
- Modify: `examples/plugin/sdk/types.ts` via `npm run build:example` (copies `src/sdk/types.ts`)

- [ ] complete the guide text with what Tasks 5-7 added: the copy rule (plain data only, class instances arrive as plain objects), every error a consumer can get, the cycle rule, the provider pick on the Plugins page, and a short provider + consumer example
- [ ] run `npm run build:example` so the example's copy of the types matches; keep the example plugin itself free of services (it stays listed and minimal)
- [ ] run drift tests and the full unit suite - must pass before next task

### Task 9: Verify acceptance criteria [model: sonnet]
- [ ] verify all requirements from Overview and the four agreed decisions are implemented
- [ ] verify edge cases: concurrent activation, provider reload, provider error, stale pick, version mismatch, non-cloneable data
- [ ] run full test suite: `npm test`, `npm run typecheck`, `npm run lint`
- [ ] run e2e tests: `npm run test:e2e` (only the known host failures listed in Testing Strategy may fail)

### Task 10: [Final] Update documentation [model: sonnet]
- [ ] `docs/design.md`: §1 decisions log row for plugin services, §5 manifest and ctx tables, replace the "reserved for cross-plugin" text; keep the "silos" data-model row accurate
- [ ] `docs/features.md`: add plugin services to features, remove "a cross-plugin API" from the not-built list
- [ ] `CLAUDE.md`: one implementation-pattern line (services are host-local, resolved per call, plain data only; main decides specs and choices)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification:**
- In the dev app (`CC_COCKPIT_DATA_DIR=~/.cache/cc-cockpit-dev npm run dev`), link two small plugins with `ccc plugin link`, call a service from one to the other, edit the provider and check the consumer keeps working after the dev reload.

**External system updates:**
- Push the updated `sdk/types.ts` to `BronOS/cc-cockpit-plugin-example` (CLAUDE.md: a change to `src/sdk/types.ts` must also go there).
- Bump the plugin API version only if the team decides `ctx.services` needs it (adding a field is backward compatible; old plugins ignore it).
