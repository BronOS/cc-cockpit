# Plugin marketplace

External review: sol / high

## Overview
- Users browse and install external plugins from a Marketplace tab in Settings, instead of having
  to know a plugin's git URL and tag.
- A marketplace is a static `index.json` in a public git repo. Authors list a plugin by PR. There is
  no backend and no GitHub API use.
- Plugins have full Node access, so the feature must not imply safety: entries are "listed", never
  "verified". The index pins the exact commit (tags can move) and can revoke a known-bad commit.
- Builds on the existing git install path (`PluginInstaller`). Replaces design.md's "no registry".

## Context (from discovery)
- `src/main/plugins/installer.ts`: `install(url, tag)`, `update(id, tag)`, `stage` (shallow clone into
  a staging folder, validates, takes a `refuse(manifest)` callback), `refreshEntry` (sets `PluginState`),
  `gitUrlProblem`, `gitTagProblem`, an injected `GitRunner`. No commit is recorded today.
- `src/main/plugins/plugin-index.ts`: the installed-plugin records. `validate.ts`: manifest validation.
- `src/main/settings/settings-service.ts`, `src/shared/ipc.ts`, `src/main/index.ts`: `settings.*` IPC.
- `src/renderer/settings/PluginsPage.tsx`, `SettingsOverlay.tsx`: the Settings UI.
- `src/main/oauth/plugin-oauth.ts`: precedent for main using `fetch`.
- `scripts/build-hello.mjs`: precedent for a committed esbuild bundle.
- `test/unit/installer.test.ts`, `test/e2e/settings-plugin-install.spec.ts`: bare repo over `file:///`,
  no network, no developer git config. New e2e follows that pattern.
- Patterns: Electron-only modules behind adapters; `isTestRun` switches ignored when packaged; main is
  the only authority; dense why-comments.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions. Exception to
  "all": the failures known before this plan on Linux (`dev-watch.test.ts:394`, `plugin-ctx.spec.ts:12`,
  `window-bounds.spec.ts:40` and `:62`) are not caused by it; do not fix them here.
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility: a plugin record without a commit stays valid

## Testing Strategy
- **unit tests** (vitest): index validation, cache, revocation matching, pin check, update detection
- **e2e tests** (Playwright): marketplace install, pin refusal, revoke, update, all against a local
  `file:///` index and bare repo. Nothing touches the network.
- `npm run test:e2e` rebuilds `out/` and breaks a running `npm run dev`; stop the dev app first.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- keep plan in sync with actual work done

## Solution Overview
- **Index repo**: one source file per plugin, generated into `index.json`, served as a static file.
  Its template and tools live in this repo under `marketplace/` and are copied to the public repo.
- **App**: main fetches and validates each configured index, caches it, computes install/update/revoke
  status, and hands the renderer a checked view. Installing goes through the existing installer with
  a pinned commit.
- **Decisions**:
  - The pin is enforced after the clone by `git rev-parse HEAD`, inside the staging step and before `.git`
    is removed, so a mismatch never reaches the plugins folder.
  - Every git install records its commit, including "Install from git URL", so revocation covers it.
  - Revocation matches `id` + full `commit`. It is enforced only from the default index or the index
    recorded on the plugin (`marketplace`). Commit hashes are public, so any other added index could
    otherwise disable a plugin of its choosing; a revocation from one of those shows as a warning naming
    that index, and does not disable. Linked dev folders have no commit and are never matched.
  - An enforced revocation has no override. The user can move to a non-revoked version from the same index,
    downgrades included, or uninstall. The downgrade matters because uninstall wipes the plugin's secrets.
  - Revocations keep working offline (from the cache), and a failed fetch never clears them.
  - An update is offered only from the index recorded on the plugin, and only when the entry's repo equals
    the installed plugin's repo. A changed repo (an ownership change) is shown as a note and needs an
    uninstall and a fresh install. Enablement and per-project data survive an uninstall today, so a
    marketplace install whose repo differs from the one that id last came from warns in the confirmation
    and stays disabled in every project until enabled again.
  - An entry whose id is a bundled or linked plugin is shown as such and has no Install: `syncBundled`
    yields a bundled id to a git install, so a listing could otherwise replace the built-in browser.
  - An `https:` index may list only `https:` repos, and a `file:` repo needs a `file:` index. `git@` is
    refused from any index: `gitUrlProblem` accepts it for hand-typed installs, but from an index it would
    make the app use the user's ssh agent on a host the index chose.

## Technical Details

Index file (`schema` is a major version; an unknown one is refused whole):
```jsonc
{
  "schema": 1,
  "plugins": [{
    "id": "bronos.jira", "name": "Jira", "description": "…", "author": "BronOS",
    "repo": "https://github.com/BronOS/cockpit-jira.git",
    "version": "0.3.0", "tag": "v0.3.0",
    "commit": "<40 lowercase hex>", "api": 1
  }],
  "revoked": [{ "id": "bronos.jira", "commit": "<40 lowercase hex>", "reason": "…" }]
}
```
Source file in the index repo (`plugins/<id>.json`): the same plugin fields plus `owners` (numeric GitHub
user ids allowed to bump it, since logins can be re-registered), which the generated `index.json` leaves out.

Validation (`src/shared/marketplace.ts`, no Electron imports, also bundled for the repo's CI):
- caps: 5 MiB body, 2000 plugins, 2000 revocations, per-field lengths; no regex from the index
- `repo` passes `gitUrlProblem`, `tag` passes `gitTagProblem`, `commit` is 40 lowercase hex
- `id` and `version` follow the manifest's existing rules
- a bad entry is dropped and counted (shown as "N entries skipped"); a bad body or unknown `schema`
  refuses the whole fetch and the last good cache stays
- a bad revocation is dropped and counted too
- a duplicate `id` in one index: all entries with that id are dropped and counted

Fetch and cache:
- marketplace URLs: `https:` or `file:` only, no embedded credentials; 15 s timeout; body size enforced
  while reading; `redirect: 'error'`, since a followed redirect could leave https
- cache: `<data>/marketplaces/<sha256 of url>.json`, holding the validated index and fetch time; read
  synchronously before `plugins.load()` so revocations apply before anything activates
- refresh: once at startup (not blocking the window), when the tab opens if older than 1 hour, and on
  a Refresh button
- app setting `marketplaces: string[]`, default the one official URL
  (`https://raw.githubusercontent.com/BronOS/cc-cockpit-marketplace/main/index.json`)
- `CC_COCKPIT_MARKETPLACE_URLS` (needs `isTestRun`, ignored when packaged) replaces the default;
  the e2e fixture sets it empty so existing specs never reach the network

Plugin record gains optional `commit` and `marketplace` (the index URL it came from). `PluginState` gains
`revoked` with the reason and source index; a revoked plugin is not activated, the same as any non-ok state.
`parseEntry` and `setState` in `plugin-index.ts` rebuild records field by field, so both must carry these.

Untrusted text: index strings are shown as React text only, never HTML, and never used as a path. The
author and repo are displayed as given; only `https:` repos become a link, opened in the system browser.

⚠️ Deviation (Task 6): the repo is shown as plain text, not a link. Nothing reaches `shell.openExternal`; a link
can be added later through main with an https-only check.

## What Goes Where
- **Implementation Steps**: everything in this repo, including the index repo's template
- **Post-Completion**: creating the public repo, listing the first plugin, manual checks

## Implementation Steps

### Task 1: Marketplace index format and validator [model: sonnet]

**Files:**
- Create: `src/shared/marketplace.ts`
- Create: `test/unit/marketplace.test.ts`
- Modify: `src/main/plugins/installer.ts`

- [x] add the index and entry types and `parseMarketplaceIndex(text, { indexUrl })` per Technical Details
- [x] move `gitUrlProblem`, `gitTagProblem` and `GIT_TAG_PATTERN` where `src/shared` can use them, re-exported
  from `installer.ts` so existing imports keep working
- [x] refuse a `file:` repo unless the index URL is `file:`
- [x] write tests for a valid index, dropped-and-counted entries and revocations
- [x] write tests for unknown `schema`, invalid JSON, caps, bad commit, `file:` repo from an `https:` index
- [x] run tests - must pass before next task

### Task 2: Record and enforce the commit in the installer [model: opus]

**Files:**
- Modify: `src/main/plugins/installer.ts`
- Modify: `src/main/plugins/plugin-index.ts`
- Modify: `test/unit/installer.test.ts`

- [x] add capped stdout to `GitResult` and `defaultGitRunner` (today it has stderr only and stdout is ignored)
- [x] in the staging step, read the commit with `git rev-parse HEAD` before `.git` is removed, and pass it to `refuse`
- [x] add an optional pin to `install` and `update`: `{ commit, id, version, marketplace }`; a mismatch
  throws `PluginInstallError` naming both commits and removes the staging folder
- [x] record `commit` on every git install and update, `marketplace` on a pinned one, through `parseEntry` and
  `setState`; old records stay valid
- [x] write tests for a matching pin, an annotated tag, and the recorded commit
- [x] write tests for a commit, id or version mismatch: refused, nothing left behind, the installed version
  untouched on a failed update
- [x] run tests - must pass before next task

### Task 3: Fetch and cache service [model: sonnet]

**Files:**
- Create: `src/main/marketplace/marketplace-service.ts`
- Create: `src/main/marketplace/fetch-index.ts`
- Create: `test/unit/marketplace-service.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/projects/registry.ts`
- Modify: `test/e2e/fixtures.ts`

- [x] `fetch-index.ts`: the injected fetcher for `https:` (timeout, size cap while reading) and `file:`
- [x] `MarketplaceService`: list of URLs, `refresh()`, `refreshIfStale()`, per-URL state (index, fetchedAt,
  error, skipped count), cache read at start and written after a good fetch
- [x] add the `marketplaces` app setting and `CC_COCKPIT_MARKETPLACE_URLS`; set it empty in the e2e fixture
  (registry.ts needed no change: the setting is optional and resolved by `marketplaceUrls`)
- [x] write tests for fetch-then-cache, offline start from the cache, the 1-hour staleness rule
- [x] write tests for a failed or invalid fetch keeping the last good index, an oversized body, a refused
  URL scheme, a corrupt cache file
- [x] run tests - must pass before next task

### Task 4: Revocation enforcement [model: opus]

**Files:**
- Modify: `src/main/plugins/installer.ts`
- Modify: `src/main/plugins/plugin-index.ts`
- Modify: `src/main/marketplace/marketplace-service.ts`
- Modify: `src/main/index.ts`
- Modify: `test/unit/installer.test.ts`
- Modify: `test/unit/marketplace-service.test.ts`
- Create: `test/e2e/marketplace-revoked.spec.ts`

- [x] give the installer a revocation lookup (`id` + `commit` → reason), checked in `refreshEntry`, which sets
  `revoked`
- [x] refuse to install or update to a revoked commit, on the git URL path too
- [x] add a serial `applyRevocations()`: `revalidate` skips git plugins, so it runs `refreshEntry`,
  `reconcileAndReload`, `afterHostsReload` and `changed` itself, and clears the manifest from `loaded` so reconcile
  cannot bring the plugin back; then show one system notification naming the plugin, the reason and the source index
- [x] enforce only from the default index or the record's `marketplace`; surface others as a warning
- [x] load the cache synchronously before `plugins.load()` at startup, not after the network answers
- [x] write tests for a match, the same id at another commit, a linked plugin, a record with no commit, and a
  revocation from an unrelated index only warning
- [x] write tests for a failed fetch keeping revocations and an install refused when revoked
- [x] write an e2e with a seeded cache: a revoked plugin never activates at startup (`index.ts` has no unit seam)
- [x] run tests - must pass before next task

### Task 5: Marketplace view and IPC in main [model: sonnet]

**Files:**
- Modify: `src/main/settings/settings-service.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/ipc/router.ts`
- Modify: `src/main/index.ts`
- Modify: `test/unit/settings-service.test.ts`
- Modify: `test/unit/ipc-router.test.ts`

- [x] `settings.marketplace`: entries of all indexes with status (available, installed, built-in, linked, update available,
  incompatible `api`, revoked, repo changed), per-URL errors and skipped counts
- [x] incompatible `api` entries are left out of the list, with a count
- [x] compare versions with a small semver comparison; offer a downgrade only for a revoked plugin
- [x] `settings.marketplaceInstall { indexUrl, id }` and `settings.marketplaceUpdate { indexUrl, id }`: main looks the
  entry up in its own validated state; repo, tag and commit are never taken from the renderer
- [x] `settings.marketplaceRefresh`, `settings.marketplaceSetUrls` (scheme checked in main)
- [x] write tests for each status, the same id in two indexes, a repo change offering no update
- [x] write tests for an unknown entry, a revoked entry, a refused URL, an entry naming a built-in id, and a
  revoked plugin moving to an older non-revoked version
- ➕ [x] include `MarketplaceService.revocationWarnings` for installed plugins in the view: Task 4 provides the warning,
  nothing shows it yet
- [x] run tests - must pass before next task

### Task 6: Marketplace page in Settings [model: sonnet]

**Files:**
- Create: `src/renderer/settings/MarketplacePage.tsx`
- Modify: `src/renderer/settings/SettingsOverlay.tsx`
- Modify: `src/renderer/settings/PluginsPage.tsx`
- Create: `test/e2e/settings-marketplace.spec.ts`

- [x] the list: filter box, name, description, author, version, source index, Install / Update / Installed
- [x] the install confirmation: says the plugin runs with full access to this computer and that "listed" does
  not mean reviewed for safety; shows author, repo, tag, commit and source index; warns when the repo differs from
  the one this id last came from; Cancel is the default
- [x] Refresh, last-fetched time, per-index errors, the skipped and incompatible counts, an offline state
- [x] marketplace URL list add/remove, with a warning that an added index can offer any plugin
- [x] `PluginsPage`: the revoked state with its reason and Uninstall, an update note; keep "Install from git URL"
- ➕ [x] show a revocation from an index without authority as a warning naming that index (it does not disable)
- [x] write e2e: `file:///` index and bare repo, browse, confirm, install, enable in the project
- [x] write e2e: pin mismatch shows the refusal, Cancel installs nothing, a revoked plugin stops and shows why,
  an update is offered and applied
- [x] run tests - must pass before next task

### Task 7: Index repo template and CI [model: opus]

**Files:**
- Create: `marketplace/README.md`
- Create: `marketplace/plugins/.gitkeep`
- Create: `marketplace/revoked.json`
- Create: `marketplace/tools/src/build-index.ts`
- Create: `marketplace/tools/src/check-entry.ts`
- Create: `marketplace/tools/src/auto-merge.ts` (the decision and its API reads), `marketplace/tools/src/common.ts`
- Create: `marketplace/tools/dist/*.js` (committed bundles)
- Modify: `src/shared/git-source.ts`, `src/shared/marketplace.ts`, `src/main/plugins/installer.ts`, `src/main/marketplace/marketplace-view.ts`, `src/main/marketplace/marketplace-service.ts` (`cloneArgs`, `gitEnv`, `compareVersions` and the default URL moved to shared, re-exported)
- Create: `marketplace/.github/workflows/check.yml`
- Create: `marketplace/.github/workflows/auto-merge.yml`
- Create: `marketplace/.github/workflows/publish-index.yml`
- Create: `scripts/build-marketplace-tools.mjs`
- Create: `test/unit/marketplace-tools.test.ts`
- Modify: `package.json`
- Modify: `.gitignore` (root `dist/` is ignored; the tools' dist is committed)
- Modify: `eslint.config.js`
- Modify: `tsconfig.node.json`

- [x] `build-index`: `plugins/*.json` + `revoked.json` → `index.json`, leaving `owners` out, through the shared
  validator; bundled with esbuild into a committed dist
- [x] `check-entry`: clones the entry's repo at the tag without running anything from it (no hooks, no submodules,
  no install), then checks commit, `plugin.json` id, version and api, and that the built `main` exists
- [x] `check.yml` on `pull_request` with read-only permissions and no secrets; never `pull_request_target`
- [x] `auto-merge.yml` runs on `workflow_run` after the check. `workflow_run.pull_requests` is empty for forks, so it
  resolves the PR from `head_sha`, re-checks it, and merges with the `sha` parameter so a later push cannot slip in
- [x] the auto-merge decision, as a pure function, read from `main` and from all pages of the PR's file list: exactly one
  file, status `modified`, filename equals the id, author's numeric id in that entry's `owners` on `main`, only
  `version`, `tag`, `commit` and `api` changed, version increased, commit not in `revoked.json`; anything else
  stays for a human
- [x] publishing: a merge made with `GITHUB_TOKEN` does not trigger other workflows, so `index.json` is published from
  the merge job as well as on a human's push to `main`, in a way branch protection allows (document the token it needs)
- [x] `marketplace/README.md`: how to list a plugin, what "listed" means, how to report a bad one
- [x] write tests for `build-index` and `check-entry` (good entry, each mismatch), and for the auto-merge decision:
  a second file, an added file, an edit to `owners`, `repo` or `name`, a non-owner, a lower version, a revoked commit
- [x] run tests - must pass before next task

### Task 8: Verify acceptance criteria [model: sonnet]
- [x] verify all requirements from Overview are implemented
- [x] verify a tampered tag, an offline start and a revoked plugin behave as specified (tampered tag: installer.test.ts "a %s mismatch refuses the install/update ..." and settings-marketplace.spec.ts "a pin mismatch is refused"; moved tag at CI: marketplace-tools.test.ts "reports a commit that is not where the tag is"; offline start: marketplace-service.test.ts "fetches, validates and caches, and a fresh service starts from the cache offline" and "applies from the cache offline"; revoked: marketplace-revoked.spec.ts + settings-marketplace.spec.ts "a revoked plugin stops and shows why")
- [x] run full test suite: `npm test`
- [x] run e2e tests: `npm run test:e2e`
- [x] run `npm run typecheck && npm run lint`

### Task 9: [Final] Update documentation [model: sonnet]
- [x] update `docs/design.md`: replace "no registry" in scope and the decisions log, add a marketplace section
- [x] update README.md: Marketplace feature, what "listed" means, the startup fetch of the index
- [x] update CLAUDE.md if new patterns were discovered; update `ccc guide` topics on publishing a plugin
- [x] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**External system updates**:
- Create the public repo `BronOS/cc-cockpit-marketplace` from `marketplace/`. It is public and outward-facing, so
  confirm with Oleg first. Until it exists the default index URL returns 404, which shows as a per-index error.
- Enable auto-merge and branch protection on that repo, and name who reviews new plugins.
- Listing the first real plugin (Jira, say) is a separate design session.

**Manual verification**:
- With the real repo live: browse, install and update through real HTTPS on macOS and Linux.
- Security read of the install confirmation wording.
- The app now contacts raw.githubusercontent.com at each launch. Check the README states this plainly.
