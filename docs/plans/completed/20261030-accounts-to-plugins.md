# Core rule, and accounts move out of core

External review: sol / high

## Overview

- Write down what "core" is, so "core or plugin?" questions have one answer: **core is the
  foundation for plugins plus the base functions every user needs without any plugin.** A feature
  is core only if at least one holds:
  1. everyone needs it with no plugin installed (projects and windows, terminal tabs, Claude in a
     tab with status, send gate, hooks and resume, themes, keys, settings, the `ccc` CLI);
  2. only main can do it safely (PTYs, checking which window or host asks, the OS keychain, typing
     into a Claude session);
  3. it connects parties that cannot reach each other directly (plugins ↔ Claude sessions,
     plugins ↔ their panels, the outside world ↔ the app through `ccc` and hooks, later
     plugin ↔ plugin).
  Everything else is a plugin, even if every user installs it.
- Accounts fail all three, so they leave core: the Accounts settings page, per-project account
  picking, the manifest's `contributes.accounts` and `ctx.account(kind)` are removed. A plugin that
  needs a sign-in brings its own UI and flow.
- What stays in core is what only main can do:
  - **`ctx.secrets`**: a small keychain-backed store per plugin (rule 2: `safeStorage` exists only
    in main; the plugin host is a `utilityProcess` and cannot reach the keychain).
  - **a "secret" settings field**: a token-style sign-in becomes one password field in the
    plugin's own settings form; the value is stored encrypted and never reaches a renderer.
  - **`ctx.oauth`**: an optional helper wrapping the existing loopback + PKCE code (system browser,
    loopback redirect, code exchange, refresh). Hard to get right, already written and tested.
- A CLI-style login (`gh auth login`) needs nothing new: a plugin already opens a terminal overlay
  with `ctx.overlay.open` and checks the result with `ctx.exec`.
- Sharing one sign-in between several features is done by one plugin with several panels (a
  "Google" plugin with mail, calendar and drive panels), not by core.
- Breaking the plugin API now is fine: `api` stays 1, no outside plugin exists yet, and only the
  in-repo `hello` plugin and the test fixtures use accounts.

## Context (from discovery)

- Account code: `src/main/accounts/` — `account-store.ts` (602 lines), `cli-auth.ts` (199),
  `oauth.ts` (695, `OAuthService`, `startLoopback`, `pkcePair`, `parseTokenResponse`),
  `secret-store.ts` (176, the only `safeStorage` user, with the test-only fake store).
- Other source files that mention accounts: `src/shared/{types,manifest,ipc}.ts`,
  `src/sdk/types.ts`, `src/host/ctx/index.ts`, `src/main/{index,child-registry,test-hooks,paths}.ts`,
  `src/main/settings/{settings-service,project-settings-service}.ts`,
  `src/main/plugins/{host-manager,host-api,validate}.ts`, `src/main/projects/registry.ts`,
  `src/main/ipc/router.ts`, `src/main/store/json-file.ts`,
  `src/renderer/settings/{AccountsPage,ProjectPage,SettingsOverlay}.tsx`, `src/renderer/styles.css`.
- Tests that mention accounts: unit `account-store`, `oauth`, `cli-auth`, `manifest`,
  `host-loader`, `settings-service`, `ipc-router`, `project-settings-service`, `project-registry`,
  `hello-dist`, `host-manager`, `paths`, `host-api`, `ctx-ui`; e2e `accounts`, `settings-oauth`
  (needs `openssl`), `settings-plugins`, `settings-project`, `hello`, `fixtures.ts`; fixtures
  `test/fixtures/plugins/host-accounts/`, `test/fixtures/plugins/settings-ui/plugin.json`.
- `plugins/hello` demonstrates accounts (`plugin.json` `contributes.accounts`, `src/host.ts`
  section "accounts"); its `dist` is committed and rebuilt with `npm run build:hello`.
- Patterns to keep (CLAUDE.md): `safeStorage` only behind the secret-store adapter; main is the
  only authority; argv-only exec; plugin settings schemas may not use regexes; tests use temp dirs
  and `CC_COCKPIT_FAKE_SECRETS=1` with `CC_COCKPIT_TEST=1`.
- **Trust boundary (decided with the user after plan review):** one plugin host process serves
  every plugin of a project window (`host-manager.ts:17-23`). Main knows which host (so which
  project) asks; the `pluginId` in a request comes from the payload and is only checked to be one
  of THIS host's plugins (`host-api.ts:17-18`, `plugin()` at ~`:493`). Plugins sharing a host can
  therefore act in each other's name — accepted today because installed plugins are trusted code
  and can already `ctx.exec` anything as the user. `ctx.secrets` keeps this boundary: the project
  host, not the plugin. Design §6 states it plainly; tests check that an id not in this host is
  refused (not that a forged id is ignored — that cannot be detected).
- `ctx.storage` is not an RPC: it runs inside the host on a path main hands it
  (`src/host/ctx/storage.ts`). `ctx.secrets` must be an RPC, since only main has `safeStorage`.
- Settings to the host are synchronous today: `hostSettingsOf` (`src/main/index.ts` ~414),
  `deps.settings`/`settingsOf` (`host-manager.ts` ~232, ~1137), the spec build (~739-760),
  `settingsChanged` (~501-517), `devReload` (~866-867). `SecretStore.decrypt` is async.
- Plugin settings validation uses ajv with `strict:false, validateFormats:false`
  (`validate.ts` ~479-481); the schema walker is ~283-433. The settings save result echoes
  values (`ipc.ts` ~255-257) and the `problem` view sends raw stored values
  (`plugin-settings.ts` ~37-42).
- `OAuthService` (`oauth.ts` ~368-695) is tied to the account store throughout; its token
  exchange (`post`, ~664) is private. Free functions worth keeping: `startLoopback`, `pkcePair`,
  `safeEqual`, `parseTokenResponse`, `httpsUrl`. It is wired in `src/main/index.ts` ~224.
- The OAuth e2e (`settings-oauth.spec.ts`) runs an https fake server with a test CA
  (`NODE_EXTRA_CA_CERTS`) and records `openExternal` (~12-15, ~41-52). The `settings-ui` fixture
  declares `contributes.accounts`.
- Line numbers above are from the review on 2026-10-30; confirm before relying on them.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task), as in phase 1
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for its code changes, success and error
  cases
- **CRITICAL: all tests must pass before starting the next task** — `npm run typecheck`,
  `npm run lint`, `npm test`, and `npm run test:e2e` when the task touches UI, IPC, the host or
  `plugins/hello`
- **CRITICAL: update this plan file when scope changes during implementation**
- backward compatibility: none needed for the accounts API (see Overview). Old data files are
  left on disk and ignored, never deleted (see Technical Details).
- Do not edit the `[model: x]` tags or the `External review:` line in this file.

## Testing Strategy

- **unit tests** (vitest) for every new module and every changed one.
- **e2e tests** (Playwright, `npm run test:e2e`): the removed Accounts page and account pickers
  lose their specs; new specs cover the secret field in a plugin settings form, `ctx.secrets`
  through a fixture plugin, and `ctx.oauth.authorize` against the existing local fake OAuth server
  used by `settings-oauth.spec.ts` (needs `openssl`).
- Nothing touches the real keychain, the real app data dir or `~/.claude`.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; document blockers with ⚠️ prefix
- keep the plan in sync with the work actually done

## Solution Overview

1. Design first: `docs/design.md` gets the core rule and the new plugin-auth story before code
   changes, so every later task follows the written design.
2. Remove accounts in one task, keeping the two primitives that stay (`secret-store.ts`,
   the loopback/PKCE/token-exchange parts of `oauth.ts`) and moving them to `src/main/secrets/`
   and `src/main/oauth/`. `hello` drops its account demo in the same task so the tree stays green.
3. Add `ctx.secrets`, then the secret settings field (built on the same store), then `ctx.oauth`.
4. `hello` demonstrates all three; e2e covers them.

## Technical Details

### `ctx.secrets` (plugin API)

```ts
readonly secrets: {
  /** The value, or null when not set. */
  get(key: string): Promise<string | null>
  /** Encrypts and stores; rejects when the OS cannot encrypt (never stores plaintext). */
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /** Keys this plugin has set, sorted. */
  keys(): Promise<string[]>
}
```

- Scope: **app-wide per plugin** (one store per plugin id, shared by all projects). A plugin that
  wants per-project sign-ins names its keys itself (`google:work`) and lets the project pick one
  through a normal project setting.
- Identity: an RPC from the host (`secrets.get|set|delete|keys` with `{ pluginId, ... }`), going
  through the same `plugin()` check as every other host request: the id must be one of this
  host's plugins, else refused. The boundary is the project host (see Context › Trust boundary).
- Limits (checked in main): key matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, value at most 64 KiB,
  at most 100 plugin-set keys per plugin (the `setting:` keys below do not count). Reserved prefix
  `setting:` (used by secret settings fields) is refused for `set`/`delete` from plugins and hidden
  from `keys()`.
- Storage: `<data>/secrets.json` = `{ [pluginId]: { [key]: <encrypted> } }`, written atomically
  like the other JSON stores, values from `SecretStore.encrypt`. Errors never contain a secret.
- Cleanup: uninstalling a plugin deletes its whole entry. This differs on purpose from per-project
  plugin data, which stays (`installer.ts` ~9, ~339): secrets are credentials, and keeping them
  after the user removed the plugin is a surprise. Forgetting a project (`registry.forget`,
  `registry.ts` ~140) drops every plugin's `setting:project:<projectId>:*` keys.

### Secret settings field

- In a plugin's `contributes.settings.app` or `.project` JSON Schema, a **top-level** string
  property with `"format": "secret"`. ajv ignores formats here (`validateFormats:false`), so the
  rule lives in the schema walker: `format:"secret"` is allowed only on a top-level
  `properties.<name>` of `type: "string"`, and the manifest is refused when it appears anywhere
  else (nested objects, `items`, `allOf`/`anyOf`/`oneOf`, `$ref` targets) or together with a
  `default`. Otherwise a nested secret would travel to the renderer inside `values`.
- The value is stored through the plugin's secret store under `setting:app:<field>` or
  `setting:project:<projectId>:<field>`, never in the settings JSON files.
- Validation: `checkPluginSettings` validates the stored JSON with secret properties removed from
  the schema's `properties` and `required`. An unset required secret does not mark the plugin's
  settings invalid or disable it; `ctx.settings` simply lacks the field, and the form shows it as
  "Not set".
- The renderer never receives a value: every payload that carries settings values (the load
  result, the save result that echoes `values`, and the `problem` view of stored values) has
  secret properties stripped. The set/not-set state travels in a separate field,
  `secretFields: { [name]: { set: boolean } }`, not inside `values` (the rjsf form expects a
  string there). A custom rjsf widget keyed on `format:"secret"` shows "Set" / "Not set" with
  Replace (password input) and Clear, styled like the redesigned settings screen. Saving sends a
  new value once (or a clear); main encrypts it.
- The plugin host sees the plaintext in `ctx.settings` (the plugin is the value's owner). Because
  the settings path to the host is synchronous and decrypt is async, main keeps a **decrypted
  cache** of secret field values per plugin and scope: filled (awaited) before a host is spawned
  and before `devReload` rebuilds a spec, updated on save/clear before `settingsChanged` fires,
  and dropped on uninstall and project forget. The sync readers (`hostSettingsOf`, `settingsOf`,
  the spec build) merge from the cache. The cache never feeds a renderer payload.

### `ctx.oauth` (optional helper)

```ts
readonly oauth: {
  /** Opens the system browser; resolves after the loopback redirect and code exchange. */
  authorize(spec: OAuthSpec): Promise<OAuthTokens>
  /** Exchanges a refresh token for a fresh access token. */
  refresh(spec: OAuthSpec, refreshToken: string): Promise<OAuthTokens>
}
interface OAuthSpec { authUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scopes: string[] }
interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: number }
```

- `authUrl`/`tokenUrl` must be https, always (the e2e fake server is https with a test CA, so no
  exception is needed). PKCE always; the existing timeouts and response-size limits stay, and so
  do the old exchange's safety checks: `redirect: 'error'` on token requests and the check on
  where a client secret may be sent (old `oauth.ts` ~625; Task 2 deletes that file's class, so
  read it with `git show <task-2 base>:src/main/accounts/oauth.ts`).
- At most one `authorize` per plugin at a time and 5 a minute. The rate window lives in that
  project's `HostApi`, so the limit is per plugin per project, not app-wide; that is accepted.
- Cancellation: a pending `authorize` is aborted (loopback closed, promise rejected) when its
  plugin host stops or its project window closes, not left up for the 5-minute login timeout.
- Storage of the tokens is the plugin's job (`ctx.secrets`); the client id/secret come from the
  plugin or its settings (the secret one as a secret field). The old app-level "OAuth clients"
  section goes away with the Accounts page.

### Removed

- Manifest `contributes.accounts` (schema rejects it: a manifest still declaring it fails
  validation with a message naming the replacement APIs), `AccountContribution` types,
  `ctx.account(kind)`, `PluginAccount`, the account IPC channels, the Accounts settings page and
  the per-plugin account pickers on This project, project settings' account choices,
  `cli-auth.ts`, `account-store.ts`.
- Old data: `accounts.json` (and any project's stored account choices) is ignored, not deleted;
  the README notes that it can be removed by hand.

## What Goes Where

- **Implementation Steps**: code, tests and docs in this repo.
- **Post-Completion**: manual checks in the running app.

## Implementation Steps

### Task 1: Write the core rule and the new plugin-auth design into docs/design.md [model: sonnet]

**Files:**
- Modify: `docs/design.md`

- [x] add the core rule (Overview above) at the end of §1 "What cc-cockpit is", as a short
      subsection "What belongs in core"
- [x] update §1 Phase 1 scope, the decisions log ("Plugins vs projects", "Phase-1 plugin API") and
      the §2 process diagram (`accounts` line → `secrets`)
- [x] rewrite §6 "Accounts" as "Plugin sign-ins and secrets": `ctx.secrets`, the secret settings
      field, `ctx.oauth`, CLI logins through a terminal overlay, sharing through one plugin with
      several panels (Technical Details above), and the trust boundary stated plainly: plugins in
      one project share a host and can read each other's secrets; the boundary main enforces is
      the project
- [x] update the §5 manifest example and host API table (drop `accounts`, add `secrets`, `oauth`),
      and the §6 Settings list (no Accounts page; This project has no account pickers)
- [x] no code changes, no tests in this task; check the doc has no remaining mention of named
      accounts outside a "removed in 2026-10" note

### Task 2: Remove accounts from core [model: opus]

**Files:**
- Delete: `src/main/accounts/account-store.ts`, `src/main/accounts/cli-auth.ts`,
  `src/renderer/settings/AccountsPage.tsx`, `test/unit/account-store.test.ts`,
  `test/unit/cli-auth.test.ts`, `test/e2e/accounts.spec.ts`, `test/e2e/settings-oauth.spec.ts`
  (Task 5 writes its replacement), `test/fixtures/plugins/host-accounts/`
- Move: `src/main/accounts/secret-store.ts` → `src/main/secrets/secret-store.ts`;
  `src/main/accounts/oauth.ts` → `src/main/oauth/oauth.ts` keeping ONLY the free functions
  (`startLoopback`, `pkcePair`, `safeEqual`, `parseTokenResponse`, `httpsUrl` and their constants);
  the `OAuthService` class is deleted with its wiring in `src/main/index.ts` (~224)
- Modify: the source files listed in Context, `test/fixtures/plugins/settings-ui/plugin.json`
  (drop `contributes.accounts`), `plugins/hello/{plugin.json,src/host.ts}` and its `dist`,
  `CLAUDE.md` (the `safeStorage` adapter path), affected unit and e2e tests

- [x] remove `contributes.accounts` from the manifest schema and types; a manifest that still has
      it fails validation with a clear message
- [x] remove `ctx.account`, `PluginAccount`, account IPC channels and handlers, project settings'
      account choices, the Accounts page and nav entry, the account pickers on This project
- [x] move `secret-store.ts` and the kept free functions of `oauth.ts`; delete `OAuthService` and
      its wiring; update the import rule comment in `src/main/index.ts` and the adapter line in
      `CLAUDE.md`
- [x] drop the account demo from `plugins/hello`, rebuild with `npm run build:hello`
- [x] update tests: manifest rejects `contributes.accounts`; settings/project-settings/registry
      tests no longer expect account data; `oauth.test.ts` keeps covering loopback, PKCE and token
      parsing only; old `accounts.json` in a temp data dir is ignored without error
- [x] run typecheck, lint, unit and e2e — must pass before task 3 (no spec may still reference
      accounts)

### Task 3: Add `ctx.secrets` [model: opus]

**Files:**
- Create: `src/main/secrets/plugin-secrets.ts`, `test/unit/plugin-secrets.test.ts`,
  `test/fixtures/plugins/host-secrets/` (fixture plugin for the e2e), `test/e2e/plugin-secrets.spec.ts`
- Modify: `src/sdk/types.ts`, `src/host/ctx/index.ts`, `src/main/plugins/host-api.ts`,
  `src/main/plugins/installer.ts` (delete on uninstall), `src/main/projects/registry.ts` (forget
  drops `setting:project:<id>:*`), `src/main/paths.ts`, `src/main/index.ts`

- [x] `plugin-secrets.ts`: per-plugin get/set/delete/keys over `<data>/secrets.json` with the
      limits and the reserved `setting:` prefix from Technical Details; atomic writes; errors
      without secret text
- [x] host API: `secrets.*` requests go through the existing `plugin()` check (id must be one of
      this host's plugins); wire into `ctx.secrets`; document the project-host trust boundary in
      the `host-api.ts` header comment
- [x] uninstall removes the plugin's secrets; project forget removes that project's secret
      setting keys
- [x] unit tests: round trip, separate stores per plugin id, limits (key pattern, size, 100-key
      cap excluding `setting:` keys), reserved prefix refused and hidden from `keys()`, encryption
      unavailable → `set` rejects and stores nothing, uninstall and forget cleanup, a `pluginId`
      not run by this host is refused
- [x] e2e: the `host-secrets` fixture plugin sets and reads a secret across an app restart (fake
      secret store)
- [x] run typecheck, lint, unit and e2e — must pass before task 4

### Task 4: Add the secret settings field [model: opus]

**Files:**
- Modify: `src/main/plugins/validate.ts`, `src/main/settings/settings-service.ts`,
  `src/main/settings/project-settings-service.ts`, `src/renderer/settings/PluginSettingsForm.tsx`,
  `src/shared/ipc.ts`, `src/main/ipc/router.ts`, `src/main/plugins/host-manager.ts`
- Modify: `test/fixtures/plugins/settings-ui/plugin.json`, related unit tests,
  `test/e2e/settings-plugins.spec.ts`, `test/e2e/settings-project.spec.ts`

- [x] schema walker: allow `"format": "secret"` only on top-level string `properties`; refuse it
      nested, under `items`/`allOf`/`anyOf`/`oneOf`/`$ref`, or with a `default`
- [x] store values through `plugin-secrets` under the `setting:` keys; the settings JSON files
      never hold them; `checkPluginSettings` validates without secret properties (an unset
      required secret does not invalidate or disable the plugin)
- [x] strip secret properties from every renderer payload (load, save result, `problem` view in
      `plugin-settings.ts`); send `secretFields: { [name]: { set } }` separately
- [x] form: a custom rjsf widget for `format:"secret"` — "Set" / "Not set", Replace (password
      input) and Clear, styled like the rest of the redesigned settings screen
- [x] decrypted cache in main feeding the synchronous host settings path (filled before host
      spawn and `devReload`, updated on save/clear before `settingsChanged`, dropped on uninstall
      and forget); host receives plaintext in `ctx.settings`
- [x] unit tests: walker accepts top-level and refuses each nested/default form; value never in
      the settings file, the save result, the problem view or any renderer payload; project scope
      keyed by project id; clear removes it; required-but-unset secret keeps the plugin enabled;
      the host spec carries the decrypted value after save and after restart
- [x] e2e: set, replace and clear a secret field app-wide and per project; the page never shows
      the value
- [x] run typecheck, lint, unit and e2e — must pass before task 5

Notes from implementation: the decrypted cache lives in `PluginSecrets` (`loadSettings`,
`writeSettings`, `cachedSetting`, `hasSetting`), so uninstall and forget drop it where they drop
the keys; it is filled in `index.ts` `hostPlugins`, which every launch and dev reload awaits
before building a spec, so `host-manager.ts` only gained comments. The host settings merge is
`hostSettingsOf` in `plugin-settings.ts`; the new tests are in `test/unit/secret-settings.test.ts`.
Secret field names must match the contribution-id pattern (they become part of a secrets.json key),
and a `$ref` to the root, `#/properties` or a secret property is refused in a schema with secrets.

### Task 5: Add the `ctx.oauth` helper [model: opus]

**Files:**
- Create: `src/main/oauth/plugin-oauth.ts`, `test/unit/plugin-oauth.test.ts`,
  `test/fixtures/plugins/host-oauth/`, `test/e2e/plugin-oauth.spec.ts` (the e2e spec replaces the
  `settings-oauth.spec.ts` deleted in Task 2; reuse its fake server, test CA and `openExternal`
  recorder setup from git history: `git show <task-2 base>:test/e2e/settings-oauth.spec.ts`)
- Modify: `src/main/oauth/oauth.ts`, `src/sdk/types.ts`, `src/host/ctx/index.ts`,
  `src/main/plugins/host-api.ts`

- [x] `authorize(spec)` and `refresh(spec, refreshToken)` on top of the kept loopback/PKCE code,
      with the token exchange written again (keep `redirect: 'error'` and the client-secret
      destination check from the old class); https only, no exception; one `authorize` per plugin
      at a time, 5 a minute per project (`HostApi` window); the system browser is opened by main
- [x] cancellation: abort a pending `authorize` (close the loopback, reject) when the plugin host
      stops or the project window closes
- [x] spec validation in main (URL scheme, scope count and lengths, client id length) before any
      browser opens
- [x] unit tests: success, user cancel / timeout, state mismatch, oversized token response,
      redirect refused, concurrency and rate limits, abort on host stop, refresh success and
      failure
- [x] e2e: the test writes the fake server's dynamic URLs into the `host-oauth` fixture plugin's
      project settings; the plugin runs `authorize` (with `NODE_EXTRA_CA_CERTS` and the
      `openExternal` recorder as in the old spec) and stores the refresh token with `ctx.secrets`
- [x] run typecheck, lint, unit and e2e — must pass before task 6

Notes from implementation: the spec checks are `checkOAuthSpec` in `plugin-oauth.ts` (scopes: at
most 50 RFC 6749 scope-tokens; client id 1-500, secret at most 4096 characters, an empty secret
means none; URLs at most 2048). The old client-secret destination check compared token URLs across
plugins sharing an account kind; with the secret and URLs from one plugin it became: the secret
goes only in the POST body to the checked token URL (no redirects), and an auth URL with a
`client_secret` parameter is refused. `refresh` has no per-minute budget but at most 4 in flight
per plugin, works while a host is stopping (like `ctx.secrets`) and is dropped when it is gone; a
dev reload of one plugin also aborts its pending `authorize`. The e2e sets the fixture's project
settings through a new test hook, `savePluginProjectSettings` (`index.ts`).

### Task 6: Show the new APIs in the hello plugin [model: sonnet]

**Files:**
- Modify: `plugins/hello/plugin.json`, `plugins/hello/src/host.ts`, its panel, `plugins/hello/README.md`,
  `plugins/hello/dist` (rebuilt), `test/unit/hello-dist.test.ts`, `test/e2e/hello.spec.ts`

- [x] add a secret app setting and show "set / not set" in the hello panel (never the value)
- [x] add a `ctx.secrets` example (a counter or note kept in the secret store)
- [x] document `ctx.oauth` in the hello source comments without calling a real provider
- [x] rebuild with `npm run build:hello`; update the hello unit and e2e tests
- [x] run typecheck, lint, unit and e2e — must pass before task 7

### Task 7: Verify acceptance criteria [model: sonnet]

- [x] every item in Overview is implemented; no `account` API, page or manifest key remains
      (`grep -ri account src plugins/hello/src` shows only intended mentions)
- [x] `safeStorage` is imported only by `src/main/secrets/secret-store.ts` (as written this is wrong:
      secret-store.ts has no `electron` import so unit tests load it in plain Node. Real rule,
      verified: `safeStorage` is imported only in `src/main/index.ts`, which hands it to
      `safeStorageSecretStore()`; every use goes through `src/main/secrets/secret-store.ts`)
- [x] run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`
- [x] run `npm run test:coverage`; new modules are covered on success and error paths

### Task 8: [Final] Update documentation [model: sonnet]

- [x] README.md: remove Accounts from features, describe plugin secrets and sign-ins, note that an
      old `accounts.json` in the data dir can be deleted by hand
- [x] CLAUDE.md: adapter paths, the core rule in one line pointing to design §1
- [x] move this plan to `docs/plans/completed/` (skipped - the harness moves the plan)

## Post-Completion

**Manual verification**
- In the running app: Settings has no Accounts page; This project has no account pickers.
- The hello plugin's secret setting can be set, replaced and cleared; the value never shows.
- Real keychain: set a secret with the dev app and confirm macOS asks for keychain access once,
  then restart and read it back.

**Follow-up (Plan B, separate plan)**
- `ccc guide`, the SessionStart note, the Claude skill install, the plugin dev loop
  (`ccc plugin new|link|logs`), plugin-contributed `ccc` subcommands and plugin skills, and the
  browser plugin as the real-world test: a plugin bringing a panel, settings, `ccc browser open
  <url>` and a skill, so Claude can show pages inside the app.
