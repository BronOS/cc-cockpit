# Distribution for the first public release
External review: auto

## Overview
- Make cc-cockpit installable without a source checkout: a version tag builds a draft GitHub Release, the maintainer tries
  it and publishes by hand, and publishing updates the Homebrew cask.
- Tell users when a new version exists, without replacing anything under running Claude sessions.
- Keep `ccc` and the app honest about being different versions after an upgrade over a running app.
- Rewrite the README's install, network and platform text to match.

## Context (from discovery)
- Packaging: `electron-builder.yml` (`publish: null`, `mac.identity: null`, mac dmg and zip for arm64 and x64, Linux AppImage
  and deb), `scripts/package.mjs`, guarded by `test/unit/packaging-config.test.ts`.
- The app repo has no `.github/workflows`. `marketplace/.github/workflows` is a separate repo's template and shows the style:
  first-party actions only, least permissions, tokens only where needed.
- `ccc`: `src/cli/client.ts` (`runHook` for hooks with a 500 ms budget, `runCommand` and `runPlugin` for user commands),
  `src/main/socket/socket-server.ts`, `src/main/socket/handlers.ts`. The wrapper (`src/main/hooks/ccc-wrapper.ts`) is rewritten
  at each start and runs the CLI inside the app bundle, so `ccc` already updates with the app.
- Safe fetching to copy: `src/main/marketplace/fetch-index.ts` (no redirects, timeout, size cap, injected fetcher, no real
  network in test runs).
- `isTestRun` in `src/main/test-run.ts`. Settings: `AppSettings` in `src/shared/ipc.ts`, `src/main/settings/settings-service.ts`.
- Two known failures would turn CI red: `test/unit/dev-watch.test.ts:394` and `test/e2e/plugin-ctx.spec.ts:12`.

## Development Approach
- **testing approach**: Regular (code first, then tests)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions, apart from the known Linux failures this plan
  has not fixed yet
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility
- commits use `oleg.bronzov@gmail.com`

## Testing Strategy
- **unit tests**: required for every task
- **e2e tests**: the update notice and the Settings toggle get an e2e test in the same task as the UI. No e2e test reaches the
  real network: main uses an injected fetcher in test runs, as the marketplace does.
- **workflows** can't run locally: tests read the workflow files and test the scripts they call. Their first real run is in
  Post-Completion.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

**One source of builds.** A `v*` tag runs `release.yml`: tests, then builds on `macos-14` (arm64) and `ubuntu-latest` (x64), then
`gh release create --draft`. A draft is invisible to users and to the update check, because `releases/latest` never returns a
draft or prerelease. Publishing by hand runs `publish-cask.yml`, which writes the cask to `BronOS/homebrew-tap`.

**electron-builder never publishes.** `publish: null` stays, and a test guards it. The upload is one explicit `gh` step.

**Notice-only updates.** No `electron-updater`: it needs signing on Mac and would restart under running sessions. One code path
for both systems.

**Version check.** User commands compare the reply's version with their own and warn on stderr, so stdout stays clean for `--json` and scripts. The command
still runs. Hooks are untouched, because they must never fail or print.

**Platforms.** Mac arm64 only, unsigned, ad-hoc signed. Linux x64 `.deb` and AppImage. No Windows. The app stays `0.x`, and the
plugin API keeps its own number (`PLUGIN_API_VERSION`).

## Technical Details

**Version in the CLI.** The CLI is a bundle run by Electron as Node, so `app.getVersion()` doesn't exist there. Inject
`__APP_VERSION__` from `package.json` with electron-vite `define`.

**Protocol.** Only the reply changes: `Reply` in `src/shared/protocol.ts` gains an optional `appVersion`, which `parseReply` must keep
(it rebuilds the object and drops unknown fields today). Main sets it on ok and error replies through a `SocketServerOptions` field.
The CLI does the comparing, so the request carries no version. An old app sends none, and a missing version never warns. The value is
validated as a version and passed through `plainLine` before printing. `runPlugin` makes two trips: warn once, from the spec reply. Warning text: `ccc: the app is running version X, this ccc is version Y. Restart cc-cockpit.`

**Update check** (`src/main/updates/update-check.ts`):
- GET `https://api.github.com/repos/BronOS/cc-cockpit/releases/latest`, `redirect: 'error'`, timeout, size cap, `Accept:
  application/vnd.github+json`, no credentials. Rate limits are per IP and unauthenticated (60 an hour), far above one a day.
- The body is untrusted. Accept only `tag_name` matching `v<major>.<minor>.<patch>`. Build the release link from a fixed base and
  that validated version, and never use the response's `html_url` or `body`.
- Any failure is silent, including 404, which is what a private repo returns. It is logged at most, never shown.
- Runs at launch and every 24 hours, gated by `AppSettings.updateCheck` (default on). Off means no request at all.
- `isTestRun`: never the real network.

**Notice.** A dismissible bar in each project window: the new version, the action, and a link to the release. Mac: `brew upgrade
--cask cc-cockpit`. Linux: a download link. Both: "Quit cc-cockpit before upgrading, or restart it afterwards." Dismissing stores
`updateDismissed: <version>` in app settings, so a newer version shows again. The link opens through a new argument-less
`updates.openRelease` IPC call, because main opens the URL it built itself. `app.openExternal` accepts any http(s) URL, so it isn't used.

**Cask** (`scripts/render-cask.mjs`, a pure function plus a CLI): version, sha256 of the arm64 dmg, `depends_on arch: :arm64`,
`app "cc-cockpit.app"`, a `zap` stanza for the data folder, and a `caveats` block with the first-launch step and the quit-first note.
Version and hash are validated before they are written into Ruby.

## What Goes Where
- **Implementation Steps**: everything in this repo.
- **Post-Completion**: creating `BronOS/homebrew-tap` and its token, real runs on GitHub, testing on real machines, making the
  repo public.

## Implementation Steps

### Task 1: Make the checks CI will run pass on Linux [model: sonnet]

**Files:**
- Modify: `test/unit/dev-watch.test.ts`
- Modify: `test/e2e/plugin-ctx.spec.ts`

- [x] find why `test/unit/dev-watch.test.ts:394` fails on Linux and fix the test so it passes on both systems. If the cause is a
      real bug in the watcher, fix the code instead and say so in the commit
- [x] fix the key-order assumption in `test/e2e/plugin-ctx.spec.ts:12`
- [x] run `npm test` and the plugin-ctx spec; both pass on Linux

### Task 2: Packaging config for the agreed targets [model: sonnet]

**Files:**
- Modify: `electron-builder.yml`
- Modify: `test/unit/packaging-config.test.ts`

- [ ] mac: arm64 only, `dmg` target only, with stable artifact names through `artifactName` so the workflows and the cask don't guess
- [ ] mac: `identity: "-"` for ad-hoc signing with `hardenedRuntime: false`: 26.18 supports the value, and its docs say the default
      hardened runtime conflicts with ad-hoc signing. Proving it launches is in Post-Completion
- [ ] Linux: keep AppImage and deb, x64. Replace the `.invalid` maintainer only if the deb build needs a real address
- [ ] update the comments in the file that state the old targets
- [ ] write tests for the targets, the architecture, the artifact names and `publish: null`
- [ ] run tests - must pass before next task

### Task 3: CLI and app version check [model: opus]

**Files:**
- Modify: `electron.vite.config.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/cli/client.ts`
- Modify: `src/main/socket/socket-server.ts`
- Modify: `src/main/index.ts`
- Modify: `src/cli/guide/cli.md`
- Modify: `test/unit/` (the existing client and socket-server tests)

- [ ] inject `__APP_VERSION__` into the CLI bundle, with a declaration for typecheck and a fallback for tests
- [ ] replies carry `appVersion` as described under Technical Details, and `parseReply` keeps it
- [ ] on a mismatch print the one-line warning to stderr and carry on, with the exit code and stdout unchanged
- [ ] `runHook` and its request line stay byte-for-byte as they are
- [ ] add a line to the guide, as the drift tests require
- [ ] write tests: match prints nothing; mismatch warns on stderr only; `--json` stdout still parses; a reply with no `appVersion`
      (an older app) prints nothing; an `appVersion` of a wrong type, huge length or with control characters prints nothing unsafe;
      a plugin command warns exactly once
- [ ] write a test that a hook request has no version field and a hook prints nothing
- [ ] run tests - must pass before next task

### Task 4: Update check in main [model: sonnet]

**Files:**
- Create: `src/main/updates/update-check.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/settings/settings-service.ts`
- Modify: `src/shared/ipc.ts`
- Create: `test/unit/update-check.test.ts`

- [ ] implement the check with an injected fetcher and clock, following `fetch-index.ts`
- [ ] strict tag validation, and version comparison with `compareVersions` from `src/shared/marketplace.ts`
- [ ] build the release URL from a fixed base and the validated version only
- [ ] `updateCheck` and `updateDismissed` in `AppSettings`, with defaults; the timer stops when the setting goes off and on quit
- [ ] never reach the real network in a test run
- [ ] write tests for newer, same, older, and a dismissed version followed by a newer one
- [ ] write tests for failures: 404, network error, redirect, oversized body, invalid JSON, hostile `tag_name` values, and that
      `html_url` and `body` are never used
- [ ] write tests that the setting off makes no request
- [ ] run tests - must pass before next task

### Task 5: Update notice and setting in the UI [model: sonnet]

**Files:**
- Modify: `src/main/ipc/router.ts`
- Create: `src/renderer/updates/UpdateNotice.tsx`
- Modify: the renderer's project window root and `src/renderer/styles.css`
- Modify: the Settings page that holds app-wide options
- Create: `test/e2e/update-notice.spec.ts`

- [ ] the bar: version, action per platform, the quit-first note, Dismiss. All text through React, none from the response
- [ ] the link uses the argument-less `updates.openRelease`; the renderer never passes a URL
- [ ] Settings: "Check for new versions" toggle, showing the current version
- [ ] write unit tests for the view model per platform
- [ ] write the e2e test with a test-hook fake result: shown, dismissed, stays dismissed after a relaunch, shows again for a newer
      version, and absent with the setting off
- [ ] run tests and e2e - must pass before next task

### Task 6: Release workflow from tag to draft [model: opus]

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/ci.yml`
- Create: `scripts/check-release-tag.mjs`
- Create: `test/unit/release-workflow.test.ts`

- [ ] `ci.yml` on PRs and pushes to `master`: typecheck, lint and unit tests on Mac and Linux. The e2e suite is not run in CI, because
      window tests depend on a window manager; it stays a manual step before tagging
- [ ] `release.yml` on `v*` tags: the same checks, then build per runner, then one job creating the draft
- [ ] `check-release-tag.mjs`: the tag must equal `v` + `package.json` version, and it must be a stable `x.y.z`; the run fails otherwise
- [ ] least permissions: read by default, `contents: write` on the release job only. First-party actions only, `persist-credentials:
      false`, a pinned Node version, no npm cache. Untrusted values reach shell through `env`, never interpolated into `run`
- [ ] the build job must never set a publish flag, and must never see a token other than what it needs
- [ ] uploads: the dmg, deb, AppImage and a `SHA256SUMS` file
- [ ] write tests for the tag script (match, mismatch, prerelease, junk) and for what the workflow files declare: draft, permissions,
      no `pull_request_target`, no third-party action
- [ ] run tests - must pass before next task

### Task 7: Cask generation and publishing [model: sonnet]

**Files:**
- Create: `scripts/render-cask.mjs`
- Create: `.github/workflows/publish-cask.yml`
- Create: `test/unit/render-cask.test.ts`

- [ ] `render-cask.mjs` as described under Technical Details, refusing an invalid version or hash
- [ ] `publish-cask.yml` on `release: published`, skipped when `release.prerelease` is set, with `tag_name` passed through `env`: download the dmg from that release, check it against `SHA256SUMS`, render the cask,
      push to `BronOS/homebrew-tap` with `TAP_TOKEN`
- [ ] the token appears only in the push step; a missing token fails the run with a clear message
- [ ] write tests: exact output for a known input; refusals for a bad version, a bad hash and Ruby-breaking input
- [ ] write tests for what the workflow declares: trigger, permissions, where the token is used
- [ ] if `ruby` is on PATH, run `ruby -c` on the output in the test; skip it otherwise
- [ ] run tests - must pass before next task

### Task 8: Verify acceptance criteria [model: sonnet]
- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases are handled
- [ ] build the AppImage and the deb on this Linux machine, with `CC_COCKPIT_DATA_DIR` set to a temp dir. This machine has no
      `libfuse.so.2` or `dpkg-deb`, so launch with `--appimage-extract-and-run`, and unpack the deb with `ar` and `tar`. Record results
      here with ⚠️ for anything that fails
- [ ] test hooks are off in a packaged app, so check tokenless `ccc` with `--project` and the wrapper's version warning. A `ccc` from a
      tab and a plugin install through the UI move to the maintainer's manual list below
- [ ] check the data folder survives a second build with a higher version, made with `-c.extraMetadata.version` so `package.json` is
      left alone
- [ ] run full test suite: `npm test`
- [ ] run e2e tests: `npm run test:e2e`, with only `window-bounds.spec.ts:40` and `:62` allowed to fail on Linux
- [ ] run `npm run typecheck` and `npm run lint`

### Task 9: [Final] Update documentation [model: sonnet]
- [ ] README: Install becomes brew and Linux downloads; running from source moves to Development
- [ ] README: the Mac first-launch step, stated before installing, with a placeholder marked for the result of the real test in
      Post-Completion; Intel Mac listed as not supported yet
- [ ] README: quit before upgrading, or restart after; the update check in the network note, and how to turn it off
- [ ] `docs/features.md`: the notice, the setting and the version warning; replace "packaged builds never launched" with the results
      from Task 8
- [ ] `docs/design.md`: a short section on distribution, and how to cut a release (`npm test`, e2e, bump, tag, try the draft, publish)
- [ ] `CLAUDE.md`: the new commands and rules: workflows, the version check, `publish: null` staying
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**External system updates**:
- Create the public repo `BronOS/homebrew-tap` and a fine-grained token limited to it (`Contents: read and write`), stored as the
  `TAP_TOKEN` secret on `BronOS/cc-cockpit`. Creating the repo may need the maintainer, because of the permission check.
- macOS runners count heavily against the free Actions minutes on a private repo. That stops mattering once it is public.

**While the repo is still private**:
- Push `v0.1.0` and watch `release.yml` make a draft. Its first real run will likely need fixes: on a retry, delete the draft and the
  tag, then tag again.
- On Linux, in the packaged app: `ccc` from a tab and a plugin install through the UI.
- On the Mac, download the dmg in a browser so it is really quarantined. Does it open with ad-hoc signing? Record the exact
  first-launch step, and put it in the README and the cask caveats. If it says "damaged", the Task 2 approach needs changing.
- On the Mac: `ccc` from a tab, a plugin install (git and the login-shell PATH), and upgrading over a running app: what the running app
  does, the version warning, and that data survives.
- On a recent Ubuntu: `.deb` and AppImage launch (the Chromium sandbox and FUSE).

**Only possible once public**:
- The update check gets 404 until the repo is public, and brew can't download private assets. So the notice, the cask flow and `brew
  install` get their first real test at the public release.
- Before opening: a screenshot for the README, and the final README read.
