# cc-cockpit

Electron desktop app: Claude Code terminal tabs, a core Claude status view, and a plugin system
(project = folder, one window per project). Read `docs/design.md` first (source of truth).

## State

Phase 1 is implemented; the plan and its notes are in
`docs/plans/completed/20261029-phase1-cockpit.md`. See README.md for an overview and docs/features.md for features and known
limitations. Concrete data plugins (Jira, Gmail, calendar, Forgejo, file tree, editor) are out
of phase 1; each gets its own design session. The Claude-operable foundation (guide, plugin CLI,
skills, webview, bundled browser plugin) is in `docs/plans/20261031-claude-operable-foundation.md`.

## Commands

- `npm test` (vitest), `npm run test:coverage`; `npm run test:e2e` (builds, then Playwright; the OAuth spec needs `openssl` on PATH).
- `npm run typecheck`, `npm run lint`.
- `npm run build` (runs `build:hello` and `build:browser` first), `npm run build:hello` (rebuild after editing
  `plugins/hello`; the dist is committed), `npm run build:browser` (same for `plugins/browser`; its
  `dist/host.js` is committed and shipped through extraResources), `npm run build:example` (same for `examples/plugin`, the
  master copy of the public repo `BronOS/cc-cockpit-plugin-example`; a change here, or to `src/sdk/types.ts`, which it copies
  to `sdk/types.ts`, must also be pushed there, and it is listed, so it stays free of exec, sessions, overlays and secrets), `npm run build:marketplace-tools` (rebuild after
  editing `marketplace/tools/src` or the `src/shared` files it imports, `git-source.ts` and `marketplace.ts` above all;
  `marketplace/tools/dist` is committed because the index repo's CI runs it with plain node and no install, and a unit
  test compares the bytes), `npm run package` (unsigned mac build),
  `npm run package:dir` (unpacked app in `release/`, for a smoke launch).

## Implementation patterns

- Core is the foundation for plugins plus the base functions every user needs without any plugin
  (docs/design.md §1, "What belongs in core"); everything else is a plugin. No accounts in core.
- Electron-only modules sit behind adapter files so logic stays testable under vitest:
  `node-pty` only in `main/pty/node-pty-backend.ts` (fake: `test/fakes/fake-pty-backend.ts`),
  `utilityProcess` only in `main/plugins/host-process.ts`; `WebContentsView` for plugin web views only in
  `main/webview/electron-webview.ts` (fake in `test/unit/webview-manager.test.ts`); `safeStorage` is imported only by
  `main/index.ts` and reached through `main/secrets/secret-store.ts`. Do not import them elsewhere
  (rule stated in `main/index.ts`).
- `CC_COCKPIT_DATA_DIR` overrides the data dir (default: Electron `userData`); tests always set it.
- `CC_COCKPIT_TEST=1` enables test hooks on `globalThis.__ccTest`; never active in packaged builds.
  `CC_COCKPIT_FAKE_SECRETS=1` swaps the keychain for an in-memory store; it needs
  `CC_COCKPIT_TEST=1` and is ignored when packaged.
  `CC_COCKPIT_NO_BUNDLED=1` skips the bundled plugins (browser); it too needs `CC_COCKPIT_TEST=1`
  and is ignored when packaged (`isTestRun`, `main/test-run.ts`, checked in `main/plugins/bundled.ts`).
- Electron takes one `registerSchemesAsPrivileged` call: `cc-overlay`, `cc-plugin` and `cc-preview`
  are registered together (`overlay-protocol.ts`, `plugin-protocol.ts`, `preview-protocol.ts`). A new scheme goes in that call.
- `<data>/claude-plugins/` is generated (by `main/claude-plugins/`) and rebuilt at start and when the
  plugin set changes; never edit it. Claude tabs get it through `--plugin-dir`; nothing goes to
  `~/.claude`. The guide topics in `src/cli/guide/*.md` are bundled into the CLI and guarded by
  drift tests (`cli-guide.test.ts`, `claude-plugins.test.ts`): a new `ccc` command, `ctx` member or
  skill rule needs its guide text in the same change.
- Send gate (`main/sessions/send-gate.ts`): text is delivered only in *waiting for input* (idle
  is not sendable), as a bracketed paste plus Enter, paste markers stripped, text starting
  with `/`, `!`, `#` or `&` refused, queued while busy, one delivery per `Stop`.
- Plugin settings schemas may not use regexes (ReDoS in main). `"format": "secret"` goes only on a
  top-level string property, with no `default` and no keyword but type/format/title/description/
  `$comment`, and a schema with one has no `$ref`/`$anchor`/`$id` or other reference keyword
  (design.md §6 "Secret settings field"; enforced in `main/plugins/validate.ts`).

## Conventions

- TypeScript throughout; React for the shell UI.
- Dense explanatory comments: say why, name the edge case or the incident behind a check.
- Exec is argv-only, never through a shell; untrusted text travels as one argument or on stdin.
- main is the only authority: renderers and plugin hosts ask, main checks which window/host is
  asking. Never trust a project or tab id passed by a plugin.
- A marketplace index is untrusted input: validate and cap it, show its repos as plain text, enforce revocations only from the default index or the one a plugin was installed from.
- Marketplace install and update: main clones the tag, checks `rev-parse HEAD` against the pinned commit in staging, and
  refuses when the repo and commit the UI showed (`expect`) differ from the current entry. See `src/shared/marketplace.ts`,
  `src/main/marketplace/`, `docs/design.md` §5 "Marketplace".
- `marketplace/` is the template of the separate index repo, not app code. Its CI runs the tools from the base commit or
  main, never from a PR branch, and auto-merge fails closed: a revoked commit, a `repo` change or duplicate head commits go
  to a human.
- Never type into a Claude session unless its status is *waiting for input*; a keystroke could
  answer a permission prompt.
- The CLI must never fail a Claude hook: when the app is not running it exits 0 silently.
- Tests use temp dirs and fakes (a fake `claude` script); nothing touches the real app data dir
  or `~/.claude`.
- Do not edit the `[model: x]` tags or `External review:` line in plan files.
