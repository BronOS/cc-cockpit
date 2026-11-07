# Rendered file views and "Open with" rules

External review: auto

## Overview

Three pieces, shipped together as app 0.14.0 (all three live in this repo: the Reviewer and Files are bundled plugins):

1. **Reviewer renders what it can.** A markdown file opens rendered, with a Rendered / Source switch; a PDF opens in a
   pdf.js view with a text layer; an image (png, jpg, gif, webp, svg) opens as a preview. Today the first shows as text
   and the other two fall back to core's built-in viewer (a pager on binary bytes, which is useless).
2. **Core: `ctx.sessions.openCommand({ argv, cwd, title, focus })`.** A plugin may open a command tab that runs an argv
   (no shell). Until now design.md says plugins cannot open command tabs; Oleg decided (2026-11-07) that a command the
   person wrote in a plugin's settings is the person's choice, and plugins can already run anything through `ctx.exec`
   and terminal overlays. The one safeguard kept: the tab shows which plugin opened it.
3. **Files: "Open with" rules.** App settings of `cockpit.files`: a list of rules, each an extension list and an action:
   the system app, a terminal command (in an overlay or a new tab), or the project's file opener (the Reviewer by
   default). A tree click takes the first matching rule; the context menu lists every matching rule plus the default.

Clicks on a Sessions card's changed files are not affected by the rules: they go through core's open-file routing to the
Reviewer, where the diff is what the person wants (the Reviewer's markdown switch applies there too).

## Context (from discovery)

- Reviewer: `plugins/reviewer/dist/host.js` (backend, plain JS), `dist/lib/files.js` (`readSides`, `MAX_SIDE_BYTES`
  400 KiB, `ReviewError({ fallback: true })` for binary and too big), `dist/lib/review.js` (inputs), page
  `src/page/review.js` bundled by `scripts/build-reviewer.mjs` into the committed `overlay/review.bundle.js` (1.08 MB),
  `src/page/sanitize.mjs` (allow-list HTML rendering of annotate's HTML mode, notes on selections), `links.mjs`.
- The overlay page is a plugin file (`cc-plugin://cockpit.reviewer/overlay/review.html`), served with `pluginCsp`
  (`src/main/plugins/plugin-protocol.ts`): `script-src`/`connect-src` self, `img-src self data:`, sandboxed frame
  (`allow-scripts allow-popups`, opaque origin). Host → page messages are capped at 1,040,384 chars of JSON.
- Core command tabs: `src/main/tabs/tab-manager.ts` (`createCommand`, `restoreTab`; a command tab runs
  `$SHELL -l -i -c <command>` from the user's settings via `tab-commands.ts`), restore in `src/main/tabs/restore.ts`.
  (restore lives in `src/main/restore.ts`, not under `tabs/`; a saved command record needs `label` + `command`,
  ~80-84; the spawn branch is `tab-manager.ts` ~581-583, `requireCommand`; `RestoreTabOptions`).
  `ctx.sessions.openShell` (`src/main/plugins/host-api.ts` `openShell`, `openShellTab` dep, `src/host/ctx/sessions.ts`)
  is the model for the new call: cwd realpath'd inside the project, shares the 5-a-minute limit of `open`.
- Files: `plugins/files/dist/host.js` (`m.type === 'open'` → `ctx.files.open(rel)`, `open-system` →
  `ctx.files.openWithSystem`, the editor service), `panels/tree.js` / `tree.html` (click, context menu), `plugin.json`
  (app settings `hideHidden`, `hideIgnored`).
- Settings schemas may not use regexes (`main/plugins/validate.ts`); arrays of objects are allowed (Jira, Autopilot).
- Guide drift tests: `test/unit/cli-guide.test.ts`, `claude-plugins.test.ts`; types in `src/sdk/types.ts`, copied by hand
  to `examples/plugin/sdk/types.ts` (and pushed to `BronOS/cc-cockpit-plugin-example`).

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task (success and error cases)
- **CRITICAL: all tests must pass before starting next task**: `npm test`, `npm run test:plugins`, `npm run typecheck`,
  `npm run lint`
- **CRITICAL: update this plan file when scope changes during implementation**
- after editing the reviewer page, `npm run build:reviewer` and commit the bundle (an unchanged rebuild must leave no diff)
- backward compatibility: a project file opener other than the Reviewer, an older saved tab file, and a Files settings
  file without rules keep working

## Testing Strategy

- **unit tests**: vitest for core (`test/unit`), `node:test` suites in `plugins/*/test` for the bundled plugins
- **e2e tests** (Playwright, `npm run test:e2e`): a spec for `openCommand` in Task 6 (a plugin opens a command tab; it
  shows the plugin marker; it is restored not started); the Reviewer page views are
  covered by pure-function tests plus a manual check in the dev app

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- keep plan in sync with actual work done

## Solution Overview

**Reviewer, markdown.** The page gets markdown-it (bundled, `html: false` so raw HTML in the file is shown as text, and
`linkify`), renders the file's text to HTML and passes that through the existing `sanitize.mjs` path, so rendering,
links and notes on a selection reuse annotate's HTML mode. A toolbar switch Rendered / Source: a file with no diff opens
Rendered; a file with a diff opens on the diff (Source), and Rendered shows the new version rendered (no change marks in
this round). Notes taken in Rendered are sent like HTML-mode notes: the quoted text, with the file path.

**Reviewer, images and PDF.** `files.js` classifies by extension before the binary check: `image` (png, jpg, jpeg, gif,
webp, svg) and `pdf`. Those read the bytes (caps: images 10 MiB, PDF 25 MiB; over the cap → today's fallback) and send
them to the page base64 in chunks under the message cap. Images show as a `data:` URL (`img-src data:` is allowed; svg
in an `<img>` runs no script). PDF: pdf.js (`pdfjs-dist`, `isEvalSupported: false`) in a separate bundle file loaded
only for a PDF, so the markdown/diff page does not grow by a megabyte. Pages render to canvas with the text layer, so a
selection can carry a note (sent with the page number and the quote). There is no diff for either; the "Changed by
Claude" context shows the current file.

⚠️ Spike first (Task 4): the page is a sandboxed frame with an opaque origin. A `new Worker(cc-plugin://…)` from it may
be refused (cross-origin worker), and pdf.js's fake-worker fallback does a dynamic `import()` that may need CORS on the
scheme. If neither runs under the current CSP, the fallback options are, in order: pdf.js's main-thread mode with the
worker code in the page bundle; a narrow `worker-src` addition to `pluginCsp`. The spike also covers: JPX images
(recent pdf.js decodes them with WASM, which needs `'wasm-unsafe-eval'`, not in `pluginCsp`; default decision: no
CSP change, JPX images are not shown); `cMapUrl` / `standardFontDataUrl` fetched from the opaque origin (bundle them
in `overlay/` or pass the data in); the pdfjs ESM build's `import.meta.url` against the classic IIFE that
`build-reviewer.mjs` emits. Decide from the spike and note it here.

**Spike outcome (Task 4, 2026-11-07):** pdf.js 6.4.299 runs in the sandboxed page with no CSP change. Its worker
code is bundled with it into `overlay/pdf.bundle.js` and published as `globalThis.pdfjsWorker`, so pdf.js uses its
main-thread "fake worker" (no Worker, no fetch, no dynamic import). `useWasm: false` (no `'wasm-unsafe-eval'`): JPEG
2000 pictures inside a PDF stay blank. No cMaps or standard font data are fetched (system fonts stand in; CJK PDFs
without embedded CMaps may show boxes). The IIFE's empty `import.meta` is only read on pdf.js's Node path and by the
WASM decoders, both unused. The bundle loads only when a PDF is shown.

**Core, openCommand.** A new tab variant: kind `command` with `argv` instead of the user's command string, plus
`openedBy: pluginId`. It spawns the argv directly (no shell; the same env and PATH as every tab), cwd realpath'd inside
the project folder, title clamped like a tab command's label (1-60 chars, one line). `argv` is 1-64 strings, each at
most 4096 chars, no NUL. The tab's tooltip names the plugin ("Opened by Files (cockpit.files)"; the bare id when the
name cannot be resolved). It is saved and restored not started with Restart, like a user command tab, but only while
its plugin is installed and not revoked by the marketplace; otherwise the saved tab is dropped at restore. Rate: shares
`open`'s 5 a minute per plugin. `focus` as for `openShell`. Unknown params keys are ignored, as `openShell` does.

**Files, rules.** App setting `openWith`: an array (at most 30) of `{ extensions: string, action: "system" |
"terminal" | "default", command?: string, where?: "overlay" | "tab", waitForKey?: boolean }`. `extensions` is a comma
or space list, matched case-insensitively against the last extension (`.tar.gz` matches `gz`; a rule may name
`tar.gz` and match the full suffix). The command is split into words host-side (double and single quotes group, no
other shell syntax), and every word that is exactly `{file}` becomes the project-relative path as one argv element (a path
starting with `-` is passed as `./-…`). `{file}` inside a larger word (`--in={file}`, `"glow {file} | less"`) is
refused when the rule is saved and when it runs: once argv[0] is a shell, a substituted word is shell text, and a
repo file named `$(curl x|sh).md` would run on a click. Pipes are written with the path as a positional argument:
`sh -c 'glow "$1" | less -R' sh {file}`. Cwd is the project folder. `waitForKey` (overlay and tab; a command tab
that exits 0 closes at once, design.md "tabExit" `close-clean`, so without it `jq` output vanishes in both):
argv becomes `['sh', '-c', '"$@"; s=$?; printf "\n[exit %s, press Enter]" "$s"; read -r _', 'sh', ...argv]`, so the
path is still an argument, never shell text. A tree click: first matching rule; no match → today's
`ctx.files.open`. Context menu: "Open" (the project's file opener) and one item per matching rule ("Open with: <label>"
where the label is the command's first word or "System app").

## Technical Details

- Chunked transfer: only after the page asks (the existing `{ type: 'content' }` handshake, `host.js` ~394-401 and
  ~697-704), because main queues at most 100 messages / 8 MiB for a page that has not loaded and throws past that
  (`overlay-manager.ts` ~234-250); a 25 MiB PDF is ~33 MiB of base64. Host posts `{ type: 'bytes-begin', id, kind,
  size }`, then `{ type: 'bytes', id, seq, b64 }` chunks of 768 KiB of base64, then `{ type: 'bytes-end', id }`; the
  page drops a transfer whose id is not the current one and caps the total it accepts (10 / 25 MiB) itself.
- markdown-it options: `html: false`, `linkify: true`, `typographer: false`; fenced code stays `<pre><code>` (no
  highlighter this round). Relative image links in markdown show as their alt text (CSP), relative links to other
  project files open through the existing link handler.
- `TabInfo` gains `openedBy?: string` (display only, never an authority); the saved tab record gains `argv` and
  `openedBy` for a plugin command tab; `restore.ts` validates both (an invalid record is dropped, like other bad
  records).
- `host-api` call `sessions.openCommand { pluginId, argv, cwd?, title?, focus? } -> { tabId }`; `ctx.sessions.openCommand`
  in `src/host/ctx/sessions.ts`; `typeof ctx.sessions.openCommand === 'function'` is the feature check for plugins.

## What Goes Where

- **Implementation Steps**: code, tests, guide, design.md, README changes in this repo
- **Post-Completion**: manual checks in the dev app, the example repo push, the release

## Implementation Steps

### Task 1: Reviewer backend classifies and streams previewable files [model: opus]

**Files:**
- Modify: `plugins/reviewer/dist/lib/files.js`
- Modify: `plugins/reviewer/dist/host.js`
- Modify: `plugins/reviewer/test/*` (files and host tests)

- [x] add `viewKindOf(rel)` in `files.js`: `markdown` (`.md`, `.markdown`; `.mdx` stays `text`), `image`, `pdf`, else
      `text`
- [x] image/pdf: read bytes with their own caps (10 / 25 MiB) before the binary check; over cap keeps the fallback
- [x] host: tell the page the view kind in the init message; stream bytes in chunks (begin / chunks / end) only after
      the page's `{ type: 'content' }` request, dropped when the overlay closed or a newer open replaced it
- [x] write tests: nothing is posted before the page asks
- [x] write tests: kind by extension (case, double extension, no extension), caps, chunk sizes stay under the message cap
- [x] write tests: a closed overlay stops the stream; binary non-image still falls back
- [x] run `npm run test:plugins` - must pass before next task

### Task 2: Reviewer page renders markdown with a Rendered / Source switch [model: opus]

**Files:**
- Modify: `package.json` (markdown-it dev dependency, pinned)
- Create: `plugins/reviewer/src/page/markdown.mjs`
- Modify: `plugins/reviewer/src/page/review.js`, `plugins/reviewer/overlay/review.html`, `review.css`
- Modify: `plugins/reviewer/overlay/review.bundle.js` (rebuilt)
- Modify: `plugins/reviewer/test/html.test.js` (or a new `markdown.test.js`)

- [x] `markdown.mjs`: markdown-it (`html: false`) to HTML, then the existing `sanitize.mjs` data path (no innerHTML)
- [x] switch in the toolbar: no diff → Rendered first; diff → Source (the diff) first, Rendered = new version
- [x] notes in Rendered reuse HTML-mode notes (quote + file path); switching views keeps notes already taken
- [x] write tests: headings, lists, tables, code, links, raw `<script>`/`<img onerror>` in markdown shown as text
- [x] write tests: switch default per case (diff / no diff), relative image link becomes alt text
- [x] `npm run build:reviewer`; run tests - must pass before next task
- [x] ➕ e2e `test/e2e/reviewer-views.spec.ts`: rendered/source defaults, switch, sanitized raw HTML, a text note kept across views
- [x] ➕ links in the Rendered view open only http(s) URLs written in the file (`review.textLinks`); relative links are refused (not opened as project files this round)

### Task 3: Reviewer page shows images [model: sonnet]

**Files:**
- Modify: `plugins/reviewer/src/page/review.js`, `review.css`
- Create: `plugins/reviewer/src/page/bytes.mjs` (chunk reassembly, pure)
- Create/Modify: `plugins/reviewer/test/bytes.test.js`

- [x] `bytes.mjs`: reassemble chunks by id and seq, reject out-of-order or oversize, produce a `data:` URL with the
      MIME type from the extension
- [x] image view: fit to the overlay, click toggles 100 %; dimensions and size in the header; no notes on images
- [x] write tests for reassembly (in order, missing chunk, stale id, total over the page-side cap of 10 / 25 MiB)
- [x] `npm run build:reviewer`; run tests - must pass before next task
- [x] ➕ e2e: a png (size, fit toggle) and an svg with a script that does not run

### Task 4: Reviewer page shows PDF with pdf.js [model: opus]

**Files:**
- Modify: `package.json` (`pdfjs-dist`, pinned)
- Modify: `scripts/build-reviewer.mjs` (today one output argument; build both `overlay/review.bundle.js` and
  `overlay/pdf.bundle.js`, plus the worker if used)
- Modify: `test/unit/reviewer-plugin.test.ts` (~27-31: byte-compare the new bundle(s) like `review.bundle.js`)
- Create: `plugins/reviewer/src/page/pdf.js`
- Modify: `plugins/reviewer/src/page/review.js`, `review.html`, `review.css`
- Create: `plugins/reviewer/src/page/pdf-entry.mjs` (the pdf.bundle.js entry)
- Modify: `plugins/reviewer/test/review.test.js` (page notes), `test/e2e/reviewer-views.spec.ts` (instead of a pdf.test.js)

- [x] spike: load pdf.js in the sandboxed overlay frame under `pluginCsp`; record the worker outcome under Solution
      Overview (⚠️ note) and pick the mode
- [x] lazy-load `pdf.bundle.js` only for a PDF; `isEvalSupported: false`; render pages to canvas on scroll with the
      text layer
- [x] notes on a text selection carry the page number and quote; send to Claude like other notes
- [x] write tests for the note format (cleanDraft, order, wording); a broken PDF shows why in the preview ("not a valid PDF"), e2e
- [x] `npm run build:reviewer`; run tests - must pass before next task

### Task 5: Core plugin command tabs (tab manager and restore) [model: opus]

**Files:**
- Modify: `src/main/tabs/tab-manager.ts` (`RestoreTabOptions`, the spawn branch ~581-583 `requireCommand`),
  `src/main/restore.ts` (saved record: `argv` + `openedBy` as an alternative to `label` + `command`, ~80-84),
  `src/main/tabs/claude-argv.ts` (or where command argv is built)
- Modify: `src/shared/ipc.ts` (`TabInfo.openedBy`)
- Modify: renderer tab strip tooltip (`src/renderer/...` tab component)
- Modify: `test/unit/tab-manager.test.ts`, `test/unit/restore.test.ts`

- [ ] `createPluginCommand(projectId, { argv, cwd, title, openedBy })`: spawns argv directly, same env as every tab
- [ ] save `argv` + `openedBy`; restore not started with Restart, only while the plugin is installed and not revoked
      (else dropped); validate on read (bad record dropped)
- [ ] tooltip shows "Opened by <plugin name> (<id>)", the bare id when the name is unknown; a user command tab shows
      no marker
- [ ] write tests: spawn argv verbatim (no shell), cwd check, restore not started, plugin gone/revoked dropped, bad
      saved records dropped
- [ ] run `npm test` - must pass before next task

### Task 6: `ctx.sessions.openCommand` API, guide and design [model: opus]

**Files:**
- Modify: `src/main/plugins/host-api.ts`, `src/main/index.ts` (dep wiring)
- Modify: `src/host/ctx/sessions.ts`, `src/sdk/types.ts`, `examples/plugin/sdk/types.ts`
- Modify: `src/cli/guide/api.md`, `docs/design.md` (custom commands: plugins may open command tabs through
  openCommand, argv only, marked)
- Modify: `test/unit/host-api*.test.ts`, guide drift tests if they list ctx members

- [ ] validate params (argv 1-64 strings ≤ 4096, no NUL; title 1-60 one line; cwd string; focus boolean); ignore
      unknown keys, as openShell does
- [ ] share `open`'s 5-a-minute limit; project from the host, never from params
- [ ] guide text and the design.md paragraph in the same change
- [ ] write tests: success, each validation error, rate limit shared with open/openShell, cwd outside the project refused
- [ ] e2e spec: a test plugin opens a command tab; it shows the marker; after a restart it is restored not started
- [ ] run `npm test`, typecheck, lint, `npm run test:e2e` - must pass before next task

### Task 7: Files "Open with" rules: schema and pure matching [model: sonnet]

**Files:**
- Modify: `plugins/files/plugin.json` (app setting `openWith`)
- Create: `plugins/files/dist/lib/open-with.js`
- Create: `plugins/files/test/open-with.test.js`

- [ ] schema: array ≤ 30 of the rule object (no regex keywords; `command` ≤ 2048 chars; enums for action/where)
- [ ] `matchRules(rel, rules)` (first match and all matches), `parseExtensions`, `splitCommand` (quotes, no other shell
      syntax), `buildArgv(rule, rel)` substituting only words that are exactly `{file}` (embedded `{file}` refused),
      and the `waitForKey` wrapper ("press Enter")
- [ ] write tests: extension forms (`pdf`, `.PDF`, `tar.gz`), no match, quoting, `{file}` with spaces / `$(…)` / leading
      `-` (path passed as `./-x` form), empty command refused, embedded `{file}` refused, wrapper keeps the path as `"$@"`
- [ ] write the injection test: a file named `$(touch pwned).md` with the rule `sh -c 'cat "$1"' sh {file}` really run
      through `sh` creates nothing
- [ ] run `npm run test:plugins` - must pass before next task

### Task 8: Files tree click and context menu use the rules [model: sonnet]

**Files:**
- Modify: `plugins/files/dist/host.js`, `plugins/files/panels/tree.js`
- Modify: `plugins/files/test/*`

- [ ] click: first matching rule → `openWithSystem` / `ctx.overlay.start({ kind: 'terminal', argv, title })` /
      `ctx.sessions.openCommand` (when the function is missing on an older app, fall back to the overlay); the
      `waitForKey` wrapper applies to both overlay and tab; no match → `ctx.files.open`
- [ ] context menu: "Open" plus one "Open with: …" item per matching rule; the panel gets the item labels from the host
- [ ] a failing rule (program not found, refused) shows a notice and logs, never falls through silently
- [ ] write tests for click dispatch per action and for the menu items
- [ ] run `npm run test:plugins` - must pass before next task

### Task 9: Verify acceptance criteria [model: sonnet]

- [ ] markdown opens rendered from the tree, the diff stays default from a Sessions card, the switch works both ways
- [ ] PDF and images preview; over-cap files fall back
- [ ] a rule opens a PDF in the system app, JSON in an overlay with `jq` waiting for a key, and in a new tab marked
      "Opened by Files"
- [ ] run full test suite: `npm test`, `npm run test:plugins`, `npm run typecheck`, `npm run lint`
- [ ] run e2e tests: `npm run test:e2e`

### Task 10: [Final] Update documentation [model: sonnet]

- [ ] `plugins/reviewer/README.md` (views, caps), `plugins/files/README.md` (rules, examples; pipes only in the form
      `sh -c 'glow "$1" | less -R' sh {file}`, and why `{file}` inside a word is refused)
- [ ] bump `plugin.json` versions of `cockpit.files` (0.2.0 → 0.3.0) and `cockpit.reviewer` (minor)
- [ ] `docs/features.md`; CLAUDE.md if a new pattern came up (plugin command tabs)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification:**
- dev app on `~/ccc-test-data`: a real README, a long PDF (scrolling, selection notes), an svg, a big png over the cap
- a rule with a missing program; a tab rule restored after an app restart

**External system updates:**
- push `examples/plugin/sdk/types.ts` to `BronOS/cc-cockpit-plugin-example`
- release app 0.14.0 (GitHub release, cask, AUR files) on Oleg's word
