# Redesign round: components, slots, overlay toolbar, settings, sessions plugin, marketplace, Inbox v2

## Overview
- Build the agreed redesign from Oleg's real-work feedback: the app changes of `docs/design-next.md`
  (component stylesheet, slots, overlay toolbar / types / buttons / loader / Discuss, sessions as a bundled
  plugin, one Settings place with global values and project overrides, marketplace previews, paging, Update all)
  and Inbox v2 with the `inbox-feed` v2 contract (`~/Projects/cc-cockpit-inbox/docs/design-v2.md`), with Gmail,
  Chat, Jira moved to feed v2 and Calendar filling the `agenda` slot.
- Sources of truth, read fully before any task: `docs/design-next.md`, `~/Projects/cc-cockpit-inbox/docs/design-v2.md`,
  `docs/feedback/20261104-real-work.md` (decisions 1-15), `docs/design.md` for everything they do not change, and
  this repo's `CLAUDE.md`. Every open question in both designs is decided **as recommended** (their "Decided
  questions" sections); the plan writes the decided answer in where it matters.
- Target: app 0.10.x, plugin API stays `api: 1` (every change is additive; a plugin checks for a new member with
  `typeof`). Inbox 0.2.0, Gmail/Chat/Jira/Calendar next minor, released together after the app (Post-Completion).
- The plan is executed task by task by subagents with **no human available**. Each task names its repo, files,
  tests and commands; when a task finds the design silent on a detail, it picks the simplest choice consistent
  with the design, writes it into this plan under the task with a ➕ or ⚠️ line, and goes on.

## Context (from discovery)
- **Panel SDK**: `src/sdk/panel.ts` (classic script, no `require`; adopts one constructable sheet, the thin
  scrollbars, `document.adoptedStyleSheets = [sheet, ...]`), `src/sdk/panel-core.ts`, `src/sdk/types.ts`
  (copied by hand to `examples/plugin/sdk/types.ts`), raw imports declared in `src/cli/raw.d.ts`,
  `electron.vite.config.ts` (the shared-chunk trap, CLAUDE.md). Shell styles: `src/renderer/styles.css` (3.3k lines).
- **Guide**: `src/cli/guide/*.md` (api, cli, dev-loop, overview, panels, plugins, settings-secrets, webview),
  topic list in `src/cli/guide.ts`; drift tests `test/unit/cli-guide.test.ts`, `test/unit/claude-plugins.test.ts`;
  the `cc-cockpit` skill text `src/main/claude-plugins/core-skill.md` (plugin-review rule).
- **Panels and headers** (the path slots follow): `ctx.panels.header` in `src/host/ctx/ui.ts` → HostApi
  `panels.header` (`src/main/plugins/host-api.ts`, `parsePanelHeader` in `src/shared/panel-header.ts`) →
  `LayoutService.setHeader` (`src/main/layout/layout-service.ts`) → `PanelInfo` → renderer
  `src/renderer/zones/{PluginPanel,PanelArea,PanelHeaderBar}.tsx`; ports `src/main/plugins/panel-ports.ts`,
  renderer `src/renderer/plugins/{PluginFrame.tsx,panel-port-bus.ts}`; serving `src/main/plugins/plugin-protocol.ts`.
- **Picks**: `src/shared/services.ts` (`selectProvider`, `serviceStatus`, `OPEN_FILE_PICK`, `BUILTIN_VIEWER`),
  `src/main/plugins/service-choices.ts`, `src/main/projects/registry.ts` (accepts service names and `@open-file`
  in `serviceProviders`), `src/main/plugins/host-manager.ts` (skips `@open-file` when walking picks),
  `src/renderer/settings/PluginsPage.tsx` (pick rows).
- **Overlays**: `src/main/overlays/overlay-manager.ts` (`parseOverlaySpec` returns a clean copy: unknown keys are
  dropped, so an older app ignores new spec fields), `overlay-protocol.ts`, `electron-url-view.ts`; host side
  `src/host/ctx/ui.ts` (handles, `overlay.message`); renderer `src/renderer/overlays/{OverlayStack,HtmlOverlay,
  TerminalOverlay}.tsx` (title bar `overlay-header`, `overlay-title`, `overlay-close`).
- **Sessions**: `src/host/ctx/sessions.ts`, `src/main/sessions/{session-registry,send-gate,open-file}.ts`,
  `src/main/restore.ts`, renderer `src/renderer/status/{TopStrip,strip-order,use-sessions,StatusDot,QueuedChip}`,
  `src/renderer/sessions/SessionsPanel.tsx`, `src/renderer/tabs/{TabsPane,TabBar,CloseTabDialog}.tsx`;
  `sessionFilesShown` in `app.json` (`src/main/index.ts`, router `settings.sessionFilesShownSet`).
- **Settings**: `src/renderer/settings/SettingsOverlay.tsx` (sections today: Projects, Plugins, Marketplace, This
  project, Appearance and keys), `PluginsPage.tsx`, `MarketplacePage.tsx`, `ProjectPage.tsx`, `AppearancePage.tsx`,
  `PluginSettingsForm.tsx`; main `src/main/settings/{settings-service,project-settings-service,plugin-settings,
  plugin-config}.ts`, `src/shared/plugin-config.ts`, `src/host/ctx/settings.ts`, secrets
  `src/main/secrets/`, schema rules `src/main/plugins/validate.ts`.
- **Marketplace**: `src/shared/marketplace.ts` (`parseEntry`), `src/main/marketplace/{fetch-index,
  marketplace-service,marketplace-view}.ts`, `marketplace/tools/src/{check-entry,build-index,common,auto-merge}.ts`
  (dist committed, byte-compared by a unit test; `npm run build:marketplace-tools`), `marketplace/README.md`,
  shell CSP in `src/renderer/index.html`.
- **Bundled plugins**: `plugins/{browser,reviewer,editor,files,hello}`, `BUNDLED_PLUGINS` in
  `src/main/plugins/bundled.ts`, `electron-builder.yml` extraResources, `npm run test:plugins`
  (`node --test plugins/*/test/`). Reviewer page `plugins/reviewer/src/page/review.js` → `overlay/review.bundle.js`
  (`npm run build:reviewer`); reviewer host `plugins/reviewer/dist/host.js` + `dist/lib/review.js` (`annotate`,
  Discuss / New session / Edit today); editor host `plugins/editor/dist/host.js`.
- **Plugin repos** (plain JS, no build, `npm test` = `node --test test/`, fake ctx in `test/fakes.js`):
  `~/Projects/cc-cockpit-inbox` (0.1.0: `dist/lib/{feed,rank,settings,state,cli}.js`, `panels/{main,rowlogic,
  settings,settingslogic,timeline}.js`), `~/Projects/cc-cockpit-gmail` (0.4.0), `~/Projects/cc-cockpit-chat` (0.2.0),
  `~/Projects/cc-cockpit-jira` (0.6.0), `~/Projects/cc-cockpit-calendar` (0.2.0, `panels/timeline.js`,
  `dist/lib/service.js`). Each source's v1 feed is `dist/lib/feed.js` + `provide('inbox-feed', …)` in `dist/host.js`.
- **Jev service** (`~/Projects/cc-cockpit-jev`, read only): `jev.grid(items, questions, { min, workers })` →
  `{ results: { [id]: { answers } | { error } }, stats }`; `noul` questions; errors reject `jev: <reason>`.
- **In-flight fixes (done separately, right now)**: the overlay opening at once with a loader, Discuss with Claude
  without a note or comment, and Discuss / New session selecting the new tab. Tasks 9-13 build on them (below).

## Development Approach
- **testing approach**: Regular (code first, then tests in the same task).
- complete each task fully before moving to the next; small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: after every task, the touched repo is green**: in `~/Projects/cc-cockpit` `npm test`,
  `npm run typecheck`, `npm run lint`, plus `npm run test:plugins` when a `plugins/` folder changed and the e2e
  specs the task names (`npm run build` first, then `npx playwright test <spec>`); in a plugin repo `npm test`.
  Known e2e failures in this Linux tiling-WM session, failing before this plan too: `cli.spec.ts:97`,
  `tab-command-overlays.spec.ts:51`, both `window-bounds.spec.ts` tests; `zone-auto-hide.spec.ts:82` is flaky.
  Anything else red blocks the next task.
- **CRITICAL: update this plan file when scope changes during implementation** (➕ new items, ⚠️ blockers).
- **Commits: local only.** Commit each task in the repo(s) it changed, as `Oleg Bronzov <oleg.bronzov@gmail.com>`
  (pass `-c user.name='Oleg Bronzov' -c user.email=oleg.bronzov@gmail.com` when the repo's config differs), message
  ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only the files the task changed
  (`git add <paths>`, never `git add -A`): another agent may be committing in the same repo. **Never push, tag,
  release, open a marketplace PR or push the example repo**: those are Post-Completion.
- **No real personal data** in any repo: no work email, employer name, real names, real ids, issue keys or
  addresses in code, tests, fixtures or docs. Use made-up data (`lead@example.com`, `PROJ-12`, `spaces/S1`).
- **Never touch real data**: no reads or writes under `~/.config/*` real app data or the app data dir; tests set
  `CC_COCKPIT_DATA_DIR` to a temp dir and use fakes (fake `claude`, fake secrets, `CC_COCKPIT_NO_BUNDLED=1` where a
  spec needs it). Never type into a real Claude session.
- **Public example / SDK sync**: tasks marked **[SYNC]** change `src/sdk/types.ts` or `examples/plugin`. In those
  tasks run `cp src/sdk/types.ts examples/plugin/sdk/types.ts` and `npm run build:example` when `examples/plugin`
  changed; the push to `BronOS/cc-cockpit-plugin-example` is Post-Completion. The example stays free of exec,
  sessions, overlays and secrets (CLAUDE.md).
- **Guide drift**: a new `ctx` member, `ccc` command or skill rule gets its guide text in the same task
  (`cli-guide.test.ts` / `claude-plugins.test.ts` fail otherwise).
- **Old apps keep loading the plugins**: a source plugin guards every new member (`typeof ctx.overlay.buttons ===
  'function'`, `typeof ctx.slots === 'object'`); new spec fields are dropped by an older `parseOverlaySpec`.

## Testing Strategy
- **app unit**: vitest (`npm test`), next to the module (`test/unit/<module>.test.ts`).
- **app e2e**: Playwright, temp data dir, fixture plugins under `test/fixtures/` (follow `services-collect.spec.ts`,
  `panel-header.spec.ts`, `reviewer-annotate.spec.ts`, `plugin-sessions.spec.ts`, `settings-*.spec.ts`).
- **bundled plugins**: `node:test` suites in `plugins/*/test` (`npm run test:plugins`).
- **plugin repos**: `npm test` with the repo's fake ctx in `test/fakes.js`, grown with the new members (`slots`,
  `panels.slots`, `overlay.buttons`, `settingsPage`, handle `onButton`/`setButtons`/`onDiscuss`).
- **manual**: a test copy of the app (`npm run package:dir` + a copied data dir) with the real plugins linked:
  Post-Completion only.

## Progress Tracking
- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview
- **Phase A, components (tasks 1-3)**: `src/sdk/components.css` in `@layer cc`, adopted first by the panel SDK and
  imported by the shell; `ccc guide style`; bundled pages, hello and the example moved to it.
- **Phase B, slots (tasks 4-8)**: `contributes.slots` providers, panel `slots` hosts, `ctx.panels.slots`
  placements (top / bottom), `ctx.slots.onOpen`, picks under `@slot:<type>`, frames drawn by the shell with their
  own port to the provider; the app slot `sessions-strip` in the top bar.
- **Phase C, overlay (tasks 9-14)**: spec extras (`type`, `buttons`, `ready`, `discuss`), the app's toolbar and
  loader, opener and by-type buttons through the host, core Discuss with Claude; reviewer and editor migrated.
- **Phase D, html settings page (task 15)**: `contributes.settings.page` + `ctx.settingsPage.onOpen`, pulled ahead of
  the Settings phase because the Inbox rules editor needs it (see Technical Details, "Order").
- **Phase E, feed v2 (tasks 16-25)**: the Plugins-page major-mismatch warning; Inbox feed validation and source
  store; Gmail, Chat, Jira on feed v2 with overlay buttons and `ready: 'manual'` opens; Calendar's agenda slot.
- **Phase F, Inbox v2 (tasks 26-32)**: rules and groups, Jev conditions, Done / Rest / search, host wiring with the
  agenda slot, panel, settings page, CLI.
- **Phase G, sessions plugin (tasks 33-36)**: `ctx.sessions` scope `all`, focus / close / rename / openFile, the
  `access` declaration; `cockpit.sessions` bundled plugin; the renderer's panel and strip removed.
- **Phase H, settings (tasks 37-40)**: pages General / Appearance / Keybindings / Plugins / This Project /
  Projects; global values of project fields with overrides; the panel gear.
- **Phase I, marketplace (tasks 41-44)**: preview and category in the index and its CI tools; preview fetch;
  one Plugins page with paging, search and filters; Update all.
- **Phase J (tasks 45-46)**: acceptance check, docs, plan moved to completed.

## Technical Details
- **Order** (user's instruction, refining design-next "Order of work"): components → slots → overlay → feed v2 and
  sources → Inbox v2 → sessions plugin → Settings → marketplace. design-next puts Settings before Inbox because the
  Inbox's rules editor is an html settings page (§5.4); so §5.4 alone is pulled forward as task 15, shown on
  today's Plugins and This project pages, and task 39 moves it onto the reorganised pages. The rest of §5 stays after
  the sessions plugin.
- **In-flight fixes**: before tasks 9, 10 and 12, run `git log --oneline -30 -- src/main/overlays src/renderer/overlays
  plugins/reviewer src/main/sessions` and read the commits for the three fixes (loader, Discuss without a note, new
  tab selected). If `git status` shows uncommitted changes in those paths, another agent is mid-fix: do not edit
  those files; mark the task ⚠️ "waiting on in-flight fix" and stop the run. When a fix has landed, extend its code
  (its loader state becomes §3.4's loader, its tab selection becomes §3.5's); when it has not landed and the tree is
  clean, the task implements that part as the design says.
- **Slot pick keys**: `@slot:<type>` in `serviceProviders`, value a plugin id or `@none`; `selectProvider` over the
  plugins that declare the type; `registry.ts` accepts the key form; every walk of picks as services skips keys
  starting with `@` (CLAUDE.md). App slot types: `sessions-strip` (a constant list in `src/shared/slots.ts`).
- **Slot caps**: type `^[a-z][a-z0-9-]{0,63}$`; ≤ 10 provider slots per plugin; ≤ 4 types per panel; ≤ 4
  placements per call; height 24-600 px clamped to the provider's `minHeight`/`maxHeight`; `params` plain JSON ≤ 4 KiB;
  ≤ 8 slot frames per window.
- **Overlay extras**: type name `^[a-z][a-z0-9-]{0,63}$`, data plain JSON ≤ 4 KiB; ≤ 4 opener buttons; button id
  1-40 of `[A-Za-z0-9._-]`, label 1-40 plain text, `icon` by the panel-header rule; `ready` html only; more than 6
  buttons besides Discuss and ✕ fold into "…"; type-button providers 500 ms each, click 30 s busy bound, `onDiscuss`
  5 s; Discuss note ≤ 4,000, whole text ≤ 20,000 (context cut first, the note never), starts with `About:`; New
  session from Discuss 5 a minute per window; loader "Still loading…" after 10 s.
- **Sessions limits** per plugin and window: focus 10 / 10 s, close 10 / min, rename 30 / min, openFile 20 / 10 s;
  rename 1-60 characters, no control characters, `null` back to Claude's title.
- **Settings storage**: global values of project fields in `app.json` › `pluginProjectDefaults[pluginId]`; overrides
  in the project record as today ("use global" = key absent); secrets `setting:projectDefault:<field>` (global) and
  `setting:project:<projectId>:<field>` (override). Effective = override → global → schema default.
- **Marketplace**: `preview: { sha256 }` and `category` (`sources views tools themes claude other`) on entries;
  `preview.png` PNG ≤ 512 KiB, 640×400 to 1600×1000 (1280×800 recommended), no `acTL` chunk, regular file;
  published as `previews/<id>/<commit>.png`. Grace: the CI tools take the cut-off date as a parameter
  (`--preview-required-from YYYY-MM-DD`, read by the index workflow from `marketplace/preview-policy.json`
  `{ "requiredFrom": null }`); `null` = warning only. The date is set at release (60 days after it), Post-Completion.
- **Feed v2**: as design-v2 "The feed contract" (caps table). Inbox keeps ≤ 1000 items per source, buffers a source's
  events while its `snapshot()` is pending, takes `source` from the `pluginId` the registry passes.
- **Inbox rules**: design-v2 "Rules", with decided Q4: a rule has `when` (0-20 conditions), `jev`, or both; with
  both, the conditions are a pre-filter evaluated first and Jev is asked only for items that pass. At least one of
  the two. Snooze kept from v1 (decided Q2): the `s` key and menu stay; a woken item is placed by the rules, marked
  "back".
- **Versions**: Inbox 0.2.0; Gmail 0.5.0, Chat 0.3.0, Jira 0.7.0, Calendar 0.3.0 (the next minor of each
  `plugin.json`; if one already moved past, take its next minor). The app's own version bump is Post-Completion.

## What Goes Where
- **Implementation Steps**: code, tests and docs in `~/Projects/cc-cockpit` (app, bundled plugins, example master,
  marketplace template) and the five plugin repos.
- **Post-Completion**: releases, tags, pushes, the example repo sync push, marketplace PRs, the preview grace date,
  manual testing in a test copy.

## Implementation Steps

### Phase A — Component stylesheet (repo `~/Projects/cc-cockpit`)

### Task 1: `components.css` in the panel SDK and the shell [model: opus] [SYNC]

**Files:**
- Create: `src/sdk/components.css`
- Modify: `src/sdk/panel.ts`, `src/sdk/panel-core.ts` (only if the sheet install lives there), `src/cli/raw.d.ts`
  (a `*.css?raw` module declaration if missing), `electron.vite.config.ts` (only if `?raw` needs it)
- Modify: `src/renderer/styles.css` (import the same file; remove shell rules it replaces only where identical)
- Modify: `src/sdk/types.ts` (doc comment: the page gets the components) → copy to `examples/plugin/sdk/types.ts`
- Modify: `test/unit/panel-sdk.test.ts`

- [x] write `components.css` per design-next §1 "What is in it": fixed tokens (`--cc-space-1..6`, radii, text sizes,
  `--cc-control-h`, `--cc-row-h` and compact), colours only through existing theme tokens, every rule inside
  `@layer cc`, every component of the table (button + variants, inputs, `.cc-field`, `.cc-card`, `.cc-list`/`.cc-row`
  with hover/focus actions, `.cc-group` incl. `details.cc-group`, `.cc-chip` with `aria-pressed`, `.cc-badge` with the
  six palette names, `.cc-toolbar`, `.cc-tabs`, `.cc-empty`, `.cc-spinner`, `.cc-error-line`, `.cc-muted`, `.cc-kbd`)
- [x] `panel.ts` takes the text through a `?raw` import (inlined string, no shared chunk: check `out/sdk/panel.js` has
  no `require` after `npm run build`), builds a second constructable sheet and installs it **first** in
  `adoptedStyleSheets` (components, then scrollbars, then the page's own)
- [x] the shell's `styles.css` imports the file so shell forms and plugin pages are the same controls; check the
  settings screen, overlays and panels still look right (no layout regressions in e2e screenshots-free specs)
- [x] write tests: the SDK installs the sheets in order; every rule of the components sheet is inside `@layer cc`
  (parse the text); a plugin rule outside the layer wins (unit with a CSSOM stub or a string check of the layer)
- [x] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [x] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/panels.spec.ts
  test/e2e/settings-form.spec.ts test/e2e/overlays.spec.ts` — done when all green and `out/sdk/panel.js` has no `require`
- ➕ decided: the bare-element defaults (`button`, `input`, `select`, `textarea`) are scoped to
  `:where(:root:not(.cc-shell) …)` and the shell's `<html>` carries `class="cc-shell"`: the shell's own controls are
  styled by unlayered rules that set some properties but not all, so element defaults would leak a height or padding
  into icon buttons and menu rows. The shell gets the tokens and every `.cc-*` class; no shell rule was identical, so
  none was removed. Components install at SDK load (macOS too), the scrollbars still on the first theme; the order is
  kept by `sdkSheetsFirst` (panel-core.ts). No page background in the layer (see-through panels stay transparent).
  `tsconfig.web.json` includes `src/cli/raw.d.ts` for the `*.css?raw` declaration.

### Task 2: `ccc guide style` and the review rule [model: sonnet]

**Files:**
- Create: `src/cli/guide/style.md`
- Modify: `src/cli/guide.ts` (topic list), `src/cli/guide/plugins.md` ("before you publish"), `src/cli/guide/panels.md`
  (pointer), `src/main/claude-plugins/core-skill.md` (plugin-review rule names the topic)
- Modify: `test/unit/cli-guide.test.ts` (drift test), `test/unit/claude-plugins.test.ts` if it checks the skill text
- Modify: `docs/design.md` (§4 Panels: the second sheet; §5 Panel side; §7 guide topic list)

- [x] `style.md`: each component with a short HTML example, the spacing scale and sizes, the rules of design-next §1
  (rows for items, cards for non-items, one primary, destructive asks or offers undo, empty/loading/error always
  drawn, sentence case, `title` on icon-only controls, keyboard and visible focus, no settings forms in a panel, own
  controls only where none fits, still with the tokens)
- [x] drift test: every `.cc-*` class in `components.css` appears in `style.md` and every `.cc-*` in `style.md` exists in
  the CSS
- [x] design.md changes listed in design-next §1
- [x] run `npm test`, `npm run typecheck`, `npm run lint` — done when green and `ccc guide style` prints the topic
  (cli unit test)

### Task 3: Bundled pages, hello and the example on the components [model: sonnet] [SYNC]

**Files:**
- Modify: `plugins/hello/panels/*`, `plugins/files/panels/tree.{html,js}`, `plugins/reviewer/overlay/review.css`,
  `plugins/reviewer/src/page/review.js` (class names only), `examples/plugin/panels/*`
- Modify: `test/unit/hello-dist.test.ts`, `test/unit/example-plugin.test.ts`, `plugins/files/test/*` if they pin markup

- [x] replace home-made buttons, inputs, rows and empty states with the components (`.cc-btn`, `.cc-row`, `.cc-empty`,
  …); keep page-specific CSS (the diff view, the tree indent) unlayered with tokens; remove rules the layer now covers
- [x] partly styled `button` rules (a colour, no border) checked for the layer's border showing under them
- [x] `npm run build:hello`, `npm run build:reviewer`, `npm run build:example`; commit the rebuilt dists
- [x] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:plugins`, `npm run build`,
  `npx playwright test test/e2e/hello.spec.ts test/e2e/example-plugin.spec.ts test/e2e/reviewer-annotate.spec.ts
  test/e2e/bundled-plugins.spec.ts` — done when green
- ➕ decided: the layer styles bare buttons/inputs, so the pages only dropped their home-made rules and took `cc-primary`, `cc-ghost`, `cc-icon`, `cc-spinner`, `cc-error-line`, `cc-row` (tree rows keep their 22px height); `button.link`/`.icon`/`.note-del`/`#add-note` set `height: auto`. The built dists did not change (no markup in them). `reviewer-annotate.spec.ts` companion test fails with and without this change (pre-existing).

### Phase B — Slots (repo `~/Projects/cc-cockpit`)

### Task 4: Slot rules in shared code: manifest, types, picks [model: opus]

**Files:**
- Create: `src/shared/slots.ts` (type pattern, app slot types, caps, `SLOT_PICK_PREFIX = '@slot:'`, key helpers)
- Modify: `src/shared/manifest.ts` (`contributes.slots`, panel `slots`), `src/main/plugins/validate.ts` (needs `main`,
  ≤ 10 per plugin, ≤ 4 per panel, min ≤ max, entry is a plugin-relative html path, a panel may not list an app slot type)
- Modify: `src/shared/services.ts` (slot candidates through `selectProvider`; `serviceStatus`/Plugins view: a "pick a
  provider" row per slot type with several candidates; `@none`), `src/main/plugins/service-choices.ts` (set a slot
  pick), `src/main/projects/registry.ts` (accept `@slot:<type>` keys), `src/main/plugins/host-manager.ts` (skip every
  `@` key when walking picks as services)
- Modify: tests `test/unit/manifest.test.ts`, `services-status.test.ts`, `project-registry.test.ts`,
  `host-manager.test.ts`; if `manifest.ts`/`services.ts` feed `marketplace/tools`, `npm run build:marketplace-tools`
  and commit the dist

- [x] manifest forms of design-next §2 (provider and host), lenient top level as today
- [x] `selectProvider` over the project's enabled plugins declaring the type; one → it; several with no valid pick →
  none + problem row; `@none` → off; stale pick (plugin gone) → as services do
- [x] write tests: accepted / refused manifests (bad type names, caps, app type in a panel, missing `main`), picks with
  0/1/2 candidates, `@none`, a stale pick, the registry round-trip of `@slot:` keys, host-manager ignoring them
- [x] run `npm test`, `npm run typecheck`, `npm run lint` — done when green
- ➕ decided: a provider slot needs `type` and `entry`; `title` is optional (1-100); `minHeight`/`maxHeight` are
  integers in 24-600 (defaults 24 and 600), `min ≤ max`; duplicate types in one plugin are refused; `entry` must end
  in `.html`. A provider may declare an app slot type (`sessions-strip`: that is how the sessions plugin fills it);
  only a panel's `slots` refuses it. Panel `slots` are unique.
- ➕ decided: `HostPlugin` and `HostManager.servicePlugins` carry `slots` (from `main/index.ts`), so the pick rows and
  `ServiceChoices.setProvider('@slot:<type>', id | '@none' | null)` see the same set as services. A slot pick does not
  restart the host; re-sending the layout on a pick change is task 5. `PluginServicesView.slots` (`slotStatus`)
  lists every type with a candidate (`selected`: id, `@none`, or null when ambiguous) for task 7's rows.

### Task 5: Slots in main: placements, frames, ports [model: opus]

**Files:**
- Modify: `src/main/plugins/host-api.ts` (`panels.slots` RPC, `slot.*` messages), `src/main/layout/layout-service.ts`
  (placements per project and panel, pushed with `PanelInfo`, cleared on ctx end / reload / host stop),
  `src/main/plugins/panel-ports.ts` (a port per slot frame to the provider's backend), `src/main/plugins/plugin-protocol.ts`
  (serve slot entries with the panel CSP), `src/shared/layout.ts`/`src/shared/types.ts` (placement and frame info types),
  `src/main/ipc/router.ts` (renderer asks for a frame's port, reports `setHeight`)
- Modify: `test/unit/host-api.test.ts`, `layout-service.test.ts`, `panel-ports.test.ts`, `plugin-protocol.test.ts`

- [x] HostApi checks of design-next §2 "Main enforces": type in that panel's manifest `slots`, not an app type, the
  panel is the calling plugin's (never trust ids), placements ≤ 4, height clamp, `params` ≤ 4 KiB plain JSON
- [x] resolve the provider per placement (task 4 rule); main tells the provider's host `slot.open { id, type, host,
  params }` / `slot.close`; the frame's port goes to the provider only (the host panel gets no handle); ≤ 8 frames per
  window (extra placements are not drawn, logged in the host plugin's log)
- [x] re-send the layout on a pick change, a provider enable/disable/reload (frames remount: close then open)
- [x] app placement `{ kind: 'app', place: 'top-bar' }` for `sessions-strip` (no host plugin; main places it itself)
- [x] write tests: each refusal, the clamp, the cap of 8, provider resolution, clear on host plugin reload/stop,
  remount on provider reload, removal on provider disable, port routed to the provider only
- [x] run `npm test`, `npm run typecheck`, `npm run lint` — done when green
- ➕ decided: the host learns of a frame with its port in ONE message, `{ "slotOpen": { pluginId, id, type, host,
  params } }` (HostManager.sendSlotPort, like `panelPort`), so an open never arrives without its port; the frame goes
  with the event `slot.close { pluginId, id }`. Open and close follow the shell's mount: `slots.connect` (renderer,
  frame id + nonce) opens, `slots.disconnect` (unmount) or the frame leaving the layout closes (once; a reconnect of
  the same id closes the old instance first). Task 6 parses both host-side; until then the host closes the port.
- ➕ decided: the renderer end comes back on `PANEL_PORT_CHANNEL` under the key `@slot/<frameId>` (`slotPortKey`), so
  the preload and `panel-port-bus.ts` need no change. Frame ids are main's (`s<n>`, `SLOT_FRAME_ID_PATTERN`), kept
  while host, position, index, type, params, provider and the provider's copy (an epoch bumped on every ready) are
  unchanged: a reload or a restart of the provider gives new ids, i.e. a remount.
- ➕ decided: the frame types live in `src/shared/ipc.ts` next to `PanelInfo` (`SlotFrameInfo`, `PanelInfo.slots`,
  `LayoutView.appSlots`), not in `layout.ts`/`types.ts`; `params` never go to the renderer. A provider draws only
  while it runs (activated, not reloading); `HostManager.onSlotsChanged` → `LayoutService.refreshSlots` publishes only
  when the frames changed. The cap of 8 counts per project (one window per project), app frames first, then panels
  in order; a placement over it is logged once in the host plugin's log.
- ➕ decided: heights are rounded and clamped to 24-600 by `parseSlotPlacements` (shared, for task 6 too), then to the
  provider's min/max by the layout service. `slots.height` (the page's `setHeight`, passed on by the renderer) is
  kept in main as `SlotFrameInfo.pageHeight` within `[minHeight, height]`; refused for the top bar. Router handlers
  are a new `registerSlotHandlers`; `plugin-protocol.ts` needed no change (a slot entry is a plugin file, already
  served with the panel CSP; a test pins it).

### Task 6: Slots in the plugin host and SDK [model: sonnet] [SYNC]

**Files:**
- Create: `src/host/ctx/slots.ts`
- Modify: `src/host/ctx/index.ts`, `src/host/ctx/ui.ts` (`ctx.panels.slots`), `src/host/loader.ts` (binding),
  `src/sdk/types.ts` (`SlotsApi`, `SlotInstance`, `SlotPlacement`, `ctx.panels.slots`), `src/sdk/panel-core.ts` /
  `src/sdk/panel.ts` (`ccPanel.slot = { type, setHeight(px) }` when the page is a slot)
- Modify: `test/unit/host-loader.test.ts` (or a new `test/unit/ctx-slots.test.ts`), `test/unit/panel-sdk.test.ts`

- [x] `ctx.slots.onOpen(type, listener)` (type must be in the plugin's `contributes.slots`, throws otherwise),
  `SlotInstance` with `post` / `onMessage` (panel message rules and caps) / `onClose`, `ctx.slots.available(type)`
  for a host plugin; listeners dropped on ctx end
- [x] `ctx.panels.slots(panelId, placements | null)` validated host-side for a fast error, re-checked by main
- [x] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [x] write tests: onOpen for an undeclared type throws, open/message/close routing, `available`, setHeight bounds
- [x] run `npm test`, `npm run typecheck`, `npm run lint` — done when green
- ➕ decided: the host learns what it may check from two optional spec fields main fills only when non-empty,
  `slotTypes` (the manifest's `contributes.slots` types) and `panelSlots` (panel id -> its `slots`). The frame arrives
  as `slotOpen` on the port (`slotOpenTag`, `HostContexts.attachSlotPort`); `slot.close` or the page's port closing
  ends it (`SlotHub` in `src/host/ctx/slots.ts`, with `onClose` told once, also to a listener added after the end).
- ➕ decided: `ctx.slots.available(type)` is a `Promise<boolean>` (not the design's sync `boolean`): main alone knows
  the pick, so it is a new RPC `slots.available` (HostApi dep `slotAvailable` -> `HostManager.slotProvider`).
- ➕ decided: the page side learns it is a slot from the shell's message `{ type: 'cc-plugin.slot', slot: { type } }`
  (`SLOT_MESSAGE`, sent once with the port: task 7) and `setHeight` posts `{ type: 'cc-plugin.slot-height', height }`
  to `window.parent` (`SLOT_HEIGHT_MESSAGE`, task 7 relays it to `slots.height`). `ccPanel.slot` is a getter that is
  `undefined` until then. A short guide text for `ctx.panels.slots`, `ctx.slots` and `ccPanel.slot` went in with this
  task (drift test); task 8 writes the full slots section.


### Task 7: Slot frames in the renderer and the pick rows [model: opus]

**Files:**
- Create: `src/renderer/zones/SlotFrame.tsx`
- Modify: `src/renderer/zones/PluginPanel.tsx` / `PanelArea.tsx` (the panel column: slots above/below the panel frame),
  `src/renderer/tabs/TabsPane.tsx` or `src/renderer/status/TopStrip.tsx` (the top-bar app slot between project name
  and "+", `no-drag` on macOS), `src/renderer/plugins/PluginFrame.tsx` (reuse for slot pages), `src/renderer/settings/
  PluginsPage.tsx` and/or `ProjectPage.tsx` (slot pick rows like `@open-file`)
- Modify: `test/unit/` a new `slot-layout.test.ts` for the pure column/height logic; `styles.css` with tokens

- [ ] column layout and height clamp in a pure function (unit-tested), `setHeight` within `[minHeight, placement height]`
- [ ] hidden or collapsed host panel unmounts its slot frames; the top-bar slot takes the bar's height and the space left
- [ ] pick rows: per slot type with candidates, plugin titles plus "None"
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 8: Slots e2e, guide and design.md [model: sonnet]

**Files:**
- Create: `test/e2e/slots.spec.ts` and fixtures under `test/fixtures/` (one host plugin placing `agenda`, two providers)
- Modify: `src/cli/guide/api.md` (ctx.slots, ctx.panels.slots, known slot types `agenda`, `sessions-strip`),
  `src/cli/guide/panels.md`, `docs/design.md` (§4 Panels column, §5 manifest, Host API table, reserved-key note next to
  Open file, §6 This project slot picks)

- [ ] e2e: two `agenda` providers → none drawn + pick row; pick one → its page draws with `params`; messages both ways;
  hide the host panel → `onClose`; disable the provider mid-session → frame gone; `@none` → no slot
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/slots.spec.ts
  test/e2e/panel-header.spec.ts test/e2e/panels.spec.ts` — done when green

### Phase C — Overlay toolbar, types, buttons, loader, Discuss (repo `~/Projects/cc-cockpit`)

Read Technical Details "In-flight fixes" before tasks 9, 10 and 12.

### Task 9: Overlay spec extras, shared button rule, SDK types [model: sonnet] [SYNC]

**Files:**
- Create: `src/shared/overlay-buttons.ts` (button parse rule shared by host and main, reusing `panel-header.ts`'s icon rule)
- Modify: `src/main/overlays/overlay-manager.ts` (`parseOverlaySpec` grows `type`, `buttons`, `ready`, `discuss`),
  `src/host/ctx/ui.ts` (host-side checks, lenient as main), `src/sdk/types.ts` (`OverlayExtras`, `OverlayButton`,
  `OverlayTypeButton`, `OverlayInfo`, handle `onButton` / `setButtons` / `onDiscuss`, result `discussed`)
- Modify: `test/unit/overlay-manager.test.ts`, `test/unit/ctx-ui.test.ts`

- [ ] parse per Technical Details "Overlay extras"; `ready` refused on non-html kinds; `discuss: false | { tabId? }`
- [ ] SDK types and doc comments in the file's style; `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [ ] write tests both sides: each cap and refusal, clean copy drops unknown keys, the icon rule shared
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 10: The app's overlay toolbar and loader [model: opus]

**Files:**
- Create: `src/renderer/overlays/OverlayToolbar.tsx`
- Modify: `src/renderer/overlays/{OverlayStack,HtmlOverlay,TerminalOverlay}.tsx`, `src/main/overlays/overlay-manager.ts`
  (put the overlay on the stack when the request arrives; ready state per kind), `src/main/overlays/electron-url-view.ts`
  (first `did-finish-load` / `did-fail-load`), `src/sdk/panel-core.ts` (`ccPanel.ready()`), `src/renderer/styles.css`
- Modify: `test/unit/overlay-manager.test.ts`, a new `test/unit/overlay-toolbar.test.ts` (pure fold/order logic)

- [ ] one row per design-next §3.2: title (ellipsis + tooltip), opener buttons, divider, type buttons (plugin-title
  order), Discuss slot (wired in task 12), ✕ placed by the tab close side setting; > 6 buttons fold into "…"; React
  text, keyboard reachable, no chords; Esc unchanged; terminal overlays get the same toolbar
- [ ] loader §3.4: `.cc-spinner` until html `pageReady` (default) or `ccPanel.ready()` with `ready: 'manual'`, url first
  load or fail, terminal first PTY output; "Still loading…" after 10 s; ✕ always works. Build on the in-flight loader fix
- [ ] write tests: fold and order logic, ready transitions per kind, the 10 s text (fake timers)
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/overlays.spec.ts
  test/e2e/tab-close-side.spec.ts` — done when green

### Task 11: Opener and by-type buttons through the host [model: opus]

**Files:**
- Create: `src/host/overlay-buttons.ts` (the host's registry of `ctx.overlay.buttons` providers)
- Modify: `src/host/ctx/ui.ts` (`ctx.overlay.buttons`, handle `onButton` / `setButtons`), `src/host/index.ts` /
  `src/host/rpc.ts` (the `overlay.buttons` and `overlay.buttonClick` RPCs), `src/main/plugins/host-api.ts`,
  `src/main/overlays/overlay-manager.ts` (ask the window's host once per typed overlay; refresh after a click settles
  and on `setButtons`), `src/main/ipc/router.ts` (renderer click), `src/renderer/overlays/OverlayToolbar.tsx` (busy state)
- Modify: tests `test/unit/host-api.test.ts`, `overlay-manager.test.ts`, new `test/unit/host-overlay-buttons.test.ts`

- [ ] host: call every provider for the type with `OverlayInfo`, each bounded to 500 ms (slow or throwing skipped and
  logged in that plugin's log), keep `run` keyed by overlay, plugin and button id, answer plain data with plugin ids
  from the registering ctx; dispose on plugin reload/ctx end
- [ ] main: `setButtons` and opener clicks only for the opening plugin's overlay (looked up by plugin and handle);
  a type-button click only for a button main currently shows, not busy or disabled; refuse a plugin id that is not one
  of that host's plugins; 30 s busy bound; `{ close: true }` dismisses the overlay
- [ ] a click never reaches the overlay's page
- [ ] write tests: timeouts, attribution, refresh after click, dispose on reload, each main refusal, `close: true`
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 12: Discuss with Claude in core [model: opus]

**Files:**
- Create: `src/renderer/overlays/DiscussPopover.tsx`, `src/main/overlays/discuss.ts` (composition, pure)
- Modify: `src/main/overlays/overlay-manager.ts`, `src/main/plugins/host-api.ts` (`onDiscuss` RPC, 5 s), `src/host/ctx/ui.ts`
  (handle `onDiscuss`), `src/main/sessions/send-gate.ts` (only if a hook is missing), the open-tab path in main
  (the one `ctx.sessions.open` uses, its own 5 a minute per window budget), `src/main/ipc/router.ts`
- Modify: tests new `test/unit/discuss.test.ts`, `overlay-manager.test.ts`, `send-gate.test.ts` if touched

- [ ] shown on overlays with a `type` or an `onDiscuss` handler unless `discuss: false`; hidden on bare overlays
- [ ] popover per design-next §3.5: target list (this window's Claude tabs with status, and New session; preselect
  `discuss.tabId` → active Claude tab → New session), optional note ≤ 4,000, Send (Enter in the list, Cmd/Ctrl+Enter in
  the note), Esc closes the popover only
- [ ] composition: `About: <title>`, the type line (`File: …`, `Item: <source> …`, unknown as `name: k=v` ≤ 500), the
  opener's text, the note; ≤ 20,000 with the context cut first; `onDiscuss` throw/timeout → error in the popover, nothing
  sent; `null` → no extra context
- [ ] existing tab through the send gate (queued chip as today; target re-checked as a Claude tab of the overlay's
  window just before the send); New session opens a Claude tab in the project folder with the text as first prompt
- [ ] close with `{ kind: 'discussed', tabId, queued }` and select the tab in the window. Build on the in-flight
  "Discuss without a note" and "select the new tab" fixes; remove any duplicate path they leave
- [ ] write tests: composition caps and ordering, preselection, the `/`-refusal never firing, throw/timeout/null
  answers, target re-check, the per-window new-session budget
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 13: Reviewer and editor on the toolbar [model: opus]

**Files:**
- Modify: `plugins/reviewer/dist/host.js`, `plugins/reviewer/dist/lib/review.js` (`annotate` gains `type?`),
  `plugins/reviewer/src/page/review.js` + `overlay/review.html` (drop Discuss, New session, Edit and the tab picker;
  answer a draft request), `plugins/reviewer/docs/design.md` (Buttons), `plugins/reviewer/README.md`
- Modify: `plugins/editor/dist/host.js` (`ctx.overlay.buttons('file', …)`), `plugins/editor/README.md`
- Modify: `plugins/reviewer/test/*.test.js`, `plugins/editor/test/host.test.js`, `test/unit/reviewer-plugin.test.ts`

- [ ] reviewer: a file review is `type: { name: 'file', data: { path } }`, `discuss: { tabId }` from the click,
  `onDiscuss` returns the review text it builds today (notes, comment, caps; asks the page for its draft); clears the
  draft on `discussed`; `annotate({ …, type })` passes a caller's type through (checked shape) so Gmail's thread there is
  an `inbox-item`
- [ ] editor: "Edit" for a `file` whose `path` resolves inside the project as `editor.open` does and is a text file it
  can open; `run` opens micro on top (the review stays under it)
- [ ] `npm run build:reviewer`; commit the bundle
- [ ] write tests: type and discuss passed, onDiscuss text, draft cleared, annotate `type` checked; editor button only for
  in-project text files, refused for `..`/absolute paths
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:plugins` — done when green

### Task 14: Overlay e2e, guide and design.md [model: sonnet]

**Files:**
- Create: `test/e2e/overlay-toolbar.spec.ts` and fixtures (an opener with buttons and a type, a second plugin with
  type buttons, a page with `ready: 'manual'`)
- Modify: `test/e2e/reviewer-annotate.spec.ts`, `src/cli/guide/api.md` (overlay extras, handle members,
  `ctx.overlay.buttons`, well-known types `file` and `inbox-item`, the open-first pattern), `docs/design.md` (§4 Overlay
  stack, Two-way html overlays, §5 Host API overlay row, reviewer paragraph)

- [ ] e2e: loader shown before `pageReady` and cleared by `ready()`; opener button click and `setButtons`; a type button
  from another plugin, busy then refreshed, `close: true`; Discuss to an existing tab (fake `claude`, delivered or
  queued) and to New session (tab selected); Discuss hidden on a bare overlay; reviewer Edit via the editor's button
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/overlay-toolbar.spec.ts
  test/e2e/overlays.spec.ts test/e2e/reviewer-annotate.spec.ts test/e2e/send.spec.ts` — done when green

### Phase D — Plugin html settings page (repo `~/Projects/cc-cockpit`)

### Task 15: `contributes.settings.page` and `ctx.settingsPage` [model: opus] [SYNC]

**Files:**
- Create: `src/host/ctx/settings-page.ts`, `src/renderer/settings/PluginSettingsPage.tsx`
- Modify: `src/shared/manifest.ts`, `src/main/plugins/validate.ts` (`page: { entry, scopes }`, needs `main`),
  `src/main/plugins/host-api.ts`, `src/main/plugins/panel-ports.ts` (port to the plugin's backend in the sender's
  window), `src/main/plugins/plugin-protocol.ts`, `src/renderer/settings/PluginsPage.tsx` (app scope, under the form),
  `src/renderer/settings/ProjectPage.tsx` (project scope), `src/sdk/types.ts`, `src/host/ctx/index.ts`, `src/host/loader.ts`
- Modify: `plugins/hello/plugin.json` + `plugins/hello/settings/index.html` (a small sample page) + `plugins/hello/src/host.ts`
  (`npm run build:hello`), `src/cli/guide/settings-secrets.md`
- Create: `test/e2e/settings-page.spec.ts`; Modify: `test/unit/manifest.test.ts`, `host-api.test.ts`

- [ ] design-next §5.4: sandboxed iframe from the plugin's folder, panel CSP, SDK with theme and components, one page
  frame per plugin at a time; `ctx.settingsPage.onOpen(page => …)` with `scope`, `post`, `onMessage`, `onClose`
- [ ] a plugin not enabled in this project: "Enable <plugin> in this project to edit this page" (the form still works)
- [ ] placement is on today's pages (Plugins = app scope, This project = project scope); task 39 moves it
- [ ] guide: the page has no settings API, store in `ctx.appStorage` / `ctx.storage`, never post secrets;
  `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [ ] write tests: manifest accepted/refused, the port goes to the sender window's host only, served only from the
  plugin's folder, e2e with hello's page (message round trip, not-enabled message)
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/settings-page.spec.ts
  test/e2e/settings-plugins.spec.ts test/e2e/hello.spec.ts` — done when green

### Phase E — Feed v2 and the sources

### Task 16: App: collected-service major warning and feed-event e2e [model: sonnet]

**Files (repo `~/Projects/cc-cockpit`):**
- Modify: `src/shared/services.ts` (`serviceStatus`: a problem on a collector when an enabled plugin provides the
  collected name at another major, "<Plugin> provides inbox-feed 1, <Collector> reads 2: update <Plugin>"),
  `src/renderer/settings/PluginsPage.tsx` (shows it), `test/unit/services-status.test.ts`,
  `test/e2e/services-collect.spec.ts` (+ fixtures: an `item` / `gone` / `sync` event case), `docs/design.md` (§5 services)

- [ ] the warning rule in `services.ts` only (host and Plugins page share it); no change to `useAll` (it still lists only
  providers at the collector's major)
- [ ] if `services.ts` feeds `marketplace/tools`, `npm run build:marketplace-tools` and commit the dist
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/services-collect.spec.ts`
  — done when green

### Task 17: Inbox: feed v2 validation [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-inbox`):**
- Modify (rewrite): `dist/lib/feed.js`; Modify: `test/feed.test.js`

- [ ] `describeOf`, `featuresOf`, `itemOf`, `syncOf`, `goneOf` per design-v2 "The item" caps table: cut titles/previews,
  refuse bad ids/action ids, drop unknown fields, one-line titles, labels ≤ 20 lowercase-compared, actions ≤ 8 with the id
  pattern, `read` boolean or null, palette names only, `message` ≤ 300; duplicate ids in one `sync` refused; ≤ 1000 per
  source keeping the newest by `time`; every function returns refused and over-cap counts, never throws on hostile input
- [ ] write tests: each cap, unknown fields, wrong types, duplicates, prototype keys (`__proto__`, `constructor`), counts
- [ ] run `npm test` — done when green

### Task 18: Inbox: the source store and event application [model: opus]

**Files (repo `~/Projects/cc-cockpit-inbox`):**
- Create: `dist/lib/sources.js`, `test/sources.test.js`; Modify: `test/fakes.js` (fake `useAll` with `on(event, (data,
  pluginId))`, providers joining/leaving, `snapshot` that resolves late)

- [ ] per source (keyed by the registry's `pluginId`, never a data field): `describe` once per provider instance,
  `snapshot()` on activate and on every `onChange` join; buffer that source's events while its `snapshot()` is pending,
  apply after; `item` replaces whole, `gone` removes, `sync` replaces the set; non-ok state keeps the last list marked
  stale with its message; a leaving provider removes its items; a change callback for the host
- [ ] write tests: item/gone/sync, buffering (an older snapshot never overwrites a newer item), a provider leaving and
  rejoining, a throwing snapshot (source error line, others unaffected), signedOut/error states, refused counts carried
- [ ] run `npm test` — done when green

### Task 19: Gmail: feed v2 [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-gmail`):**
- Modify (rewrite): `dist/lib/feed.js`; Modify: `dist/host.js`, `plugin.json` (`provides: { "inbox-feed": 2 }`, version
  0.5.0), `test/feed.test.js`, `test/host.test.js`, `test/fakes.js`, `README.md`

- [ ] stop: `level`, unread-only filter, noise rule, `limit`, `items` / `recent` / `markRead` / `markUnread` methods,
  `canUnread`, `jiraKey` field, `changed` event (design-v2 "Gmail")
- [ ] scope: the threads of its Unread and Read lanes (Inbox label, `unreadDays`, the read lane's days), alert threads
  each their own item; `describe().scope` "unread + read of the last N days" from settings; same line in its panel
  and settings description
- [ ] fields per the table (label map names, `important`, `starred`, `category:<name>`, `alert`, `alert:<name>`,
  `jira:KEY`), `to` from To/Cc/list, `rev` newest message id; `snapshot()` from the cache; `act(id, action)` checks the id
  is its own and the action is in that item's `actions` (open, markRead or markUnread), returns `{ ok, message }`
- [ ] a pure diff emitter (`diffFeed(prev, next)` → items and gone ids): `item` on any field change, `gone` on a missing
  id; emitted after each poll and right after a mark; `sync` after activate's first cached view, a sign-in and a
  recovered error
- [ ] write tests: mapping and caps, diff (each field change, missing id, no-op), `act` refusing a foreign id or an
  action the item lacks, sync triggers, plugin still activates on a fake ctx without `useAll`/`slots`/`overlay.buttons`
- [ ] run `npm test` — done when green

### Task 20: Gmail: overlay type, buttons, open first [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-gmail`):**
- Modify: `dist/host.js` (thread open), `panels/thread.js` (`ccPanel.ready()` once drawn), `test/host.test.js`,
  `test/fakes.js`, `README.md`

- [ ] thread overlays: `start({ …, type: { name: 'inbox-item', data: { source: '<own id>', id } }, ready: 'manual' })` at
  once, then fetch and `post`; through the reviewer: `annotate({ …, type })` (an older reviewer ignores it)
- [ ] `ctx.overlay.buttons('inbox-item', …)` when the function exists: the item's current actions except `open` when
  `data.source` is its own id and `data.id` one of its items, else `[]`; `run` = the same code as `act`; labels follow
  state (Mark read ↔ Mark unread); `onDiscuss` supplies the thread's text (subject, from, snippet; capped)
- [ ] write tests: buttons only for own items, run = act, `ready: 'manual'` spec sent before the fetch, no buttons
  registered on a fake ctx without the member
- [ ] run `npm test` — done when green

### Task 21: Chat: feed v2 [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-chat`):**
- Modify (rewrite): `dist/lib/feed.js`; Modify: `dist/host.js`, `plugin.json` (`inbox-feed` 2, version 0.3.0),
  `test/feed.test.js`, `test/host.test.js`, `test/fakes.js`, `README.md`

- [ ] as task 19 with design-v2 "Chat": stop `level`, the Mentions-and-DMs filter, noise, `limit`, `recent`,
  `canUnread` (no `markUnread` action where it cannot), `jiraKey`, `changed`; scope = unread conversations of every lane
  plus read ones of the last `recentDays`; `to` from the conversation kind, `mentionsMe` from `@you`, labels
  `mention:all`, `alert`, `alert:<name>`, `jira:KEY`; `place` = channel with the space's display name; `rev` latest
  message name; the same diff emitter, `snapshot`, `act`, `sync` triggers
- [ ] write the same tests as task 19
- [ ] run `npm test` — done when green

### Task 22: Chat: overlay type, buttons, open first [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-chat`):** `dist/host.js`, `panels/thread.js`, `test/host.test.js`, `test/fakes.js`, `README.md`

- [ ] as task 20 for Chat threads (`inbox-item { source, id }`, `ready: 'manual'`, buttons from the item's actions,
  `onDiscuss` with the conversation's latest messages, capped)
- [ ] write the same tests as task 20
- [ ] run `npm test` — done when green

### Task 23: Jira: feed v2 [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-jira`):**
- Modify (rewrite): `dist/lib/feed.js`; Modify: `dist/host.js`, `plugin.json` (`inbox-feed` 2 beside `jira`, version
  0.7.0), `test/feed.test.js`, `test/host.test.js`, `test/fakes.js`, `README.md`

- [ ] design-v2 "Jira": stop `level` and status hints in the feed, noise, `limit`, `dueAt`, `changed`; scope = issues of
  its Backlog, In progress, On hold and Mentioned lanes (Done lane → `gone`); `place` = project key + status name; labels
  `assigned`, `mentioned`, `priority:<name>`, `type:<name>`, `due:YYYY-MM-DD`, `label:<name>`; `preview` latest comment
  else description start from the cache; `rev` = `updated`; actions open, markRead / markUnread on its seen marks;
  same diff emitter, `snapshot`, `act`, `sync` triggers
- [ ] write the same tests as task 19, plus Done-lane issues emitted as `gone`
- [ ] run `npm test` — done when green

### Task 24: Jira: overlay type, buttons, open first [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-jira`):** `dist/host.js` (the issue open path, reviewer `annotate` and the own
`panels/issue.html` fallback), `panels/issue.js`, `test/host.test.js`, `test/fakes.js`, `README.md`

- [ ] as task 20 for issues (both the reviewer path and its own page get the type, `ready: 'manual'`, buttons,
  `onDiscuss` with key, summary, status and latest comment, capped); drop the own page's Discuss / New session buttons
  only when `ctx.overlay.buttons` exists (an older app keeps them)
- [ ] write the same tests as task 20
- [ ] run `npm test` — done when green

### Task 25: Calendar: the agenda slot [model: sonnet]

**Files (repo `~/Projects/cc-cockpit-calendar`):**
- Create: `slots/agenda.html`, `slots/agenda.js`, `test/agenda.test.js`
- Modify: `plugin.json` (`contributes.slots: [{ "type": "agenda", "entry": "slots/agenda.html", "title": "Today's agenda",
  "minHeight": 48, "maxHeight": 320 }]`, version 0.3.0), `dist/host.js` (`ctx.slots.onOpen('agenda', …)` when
  `ctx.slots` exists), `test/fakes.js`, `README.md`

- [ ] page from the event cache: today's timeline with the now line (reuse `panels/timeline.js` logic), the next event with
  a countdown and Join (backend opens the meeting URL with `ctx.openExternal`, https only), invitations with Accept /
  Decline (its RSVP); components stylesheet; `ccPanel.slot.setHeight` to fit; all provider text as text
- [ ] keep the `calendar` v1 service; no `inbox-feed`
- [ ] write tests: the pure render functions (timeline, next event, invitations, empty state), Join refusing non-https,
  RSVP answer checked, activation without `ctx.slots` (older app)
- [ ] run `npm test` — done when green

### Phase F — Inbox v2 (repo `~/Projects/cc-cockpit-inbox`)

### Task 26: Rules, groups and settings v2 [model: opus]

**Files:**
- Create: `dist/lib/rules.js`, `test/rules.test.js`
- Modify (rewrite): `dist/lib/settings.js`, `test/settings.test.js`; Delete: `dist/lib/rank.js`, `test/rank.test.js`

- [ ] `InboxSettings` v2 (design-v2 "Format", with decided Q4: `when` and/or `jev`), validated on every read; caps
  (groups ≤ 20, rules ≤ 200, conditions ≤ 20, `in` ≤ 50, names, question ≤ 300, `min` 0..1); defaults table (groups Chat,
  Mail, Jira, Rest collapsed; rules 1-4); `rest` always last; reset
- [ ] migration from 0.1.0 settings: weights, levels, boosts, counts dropped; the calendar position carried to `agenda`
  (`in the list` and `beside` → `top`)
- [ ] evaluation: every field/op of the table, case-insensitive NFKC lower-case, no regex, `to: none`, `time` minutes;
  first enabled rule that holds wins; none → Rest "no rule"; within a group newest `time`, then source, then id;
  reasons (`rule 3: Jev 0.86`, `rule 1: from.address is lead@example.com`, the rule's name when set); a full trace for
  `why`; a Jev rule calls an injected `jevAnswer(rule, item)` returning `{ score } | 'pending' | 'unavailable'`
- [ ] write tests: each op, first match, disabled rules, Rest, the stable order (same input → same list), pre-filter
  then Jev, pending/unavailable passing through, migration, bad settings replaced by defaults
- [ ] run `npm test` — done when green

### Task 27: Jev conditions [model: opus]

**Files:**
- Create: `dist/lib/jev.js`, `test/jev.test.js`

- [ ] answers through `ctx.services.use('jev').grid(items, { q: { type: 'noul', instructions } })`, text `title + "\n" +
  preview` cut to 1500; cache `jv:<hash(question)>:<hash(pluginId, id)>` in `ctx.appStorage` → `{ rev, score, at }`;
  a new `rev` asks again, read/label changes do not; threshold change needs no new answer
- [ ] batching: one `grid` per question every 2 s at most, 100 items a call; only items that reach the rule are asked
- [ ] pending → rule not holding and row "Jev…"; on answer the item moves once; unavailable (no provider, cap, error) →
  not holding, nothing cached, reason "rule N skipped: Jev unavailable", retry after 10 minutes; pruned with Done entries
- [ ] a "test" mode that reads cached answers only (never a request), for the settings page
- [ ] write tests (fake clock, fake jev): cache key with `rev`, batching sizes and pacing, pending then one move,
  unavailable then retry, no request in test mode, a hostile answer (missing or non-number score) treated as unavailable
- [ ] run `npm test` — done when green

### Task 28: Done, snooze, undo and search [model: sonnet]

**Files:**
- Modify: `dist/lib/state.js`, `test/state.test.js`; Create: `dist/lib/search.js`, `test/search.test.js`

- [ ] Done (design-v2 "Inbox's own memory"): `st:<pluginId>:<id>` (hashed when too long, v1 key form) → `{ kind: 'done',
  rev, at, title, pluginId, id }`; hidden until an `item` with a different `rev` (then "back: new activity"); read or
  label change alone does not bring it back; never calls the source; 14-day prune after last seen; `gone` keeps the entry
- [ ] undo of the last Done; Done view list (newest first, live title else stored) with "Back to Inbox"
- [ ] snooze kept from v1, a woken item returned to rule placement and marked "back"; drop v1's "done also marks read"
- [ ] search: case-insensitive substring over title, preview, from, place and labels of every item, Rest and Done
  included, Done ones marked
- [ ] write tests: rev change returns, read change does not, prune, undo, Done view order, v1 entries carried over,
  search over each field and over Done items
- [ ] run `npm test` — done when green

### Task 29: Inbox host v2 [model: opus]

**Files:**
- Modify: `dist/host.js`, `plugin.json` (version 0.2.0; `services: { uses: { "inbox-feed": 2, "jev": 1 }, collects:
  ["inbox-feed"] }`; panel `main` with `"slots": ["agenda"]`; `contributes.settings.page` `{ "entry":
  "settings/index.html", "scopes": ["app"] }`; no `calendar`), `test/host.test.js`, `test/manifest.test.js`, `test/fakes.js`
  (`panels.slots`, `slots.available`, `overlay.buttons`, `settingsPage`, `panels.header`, `badge`)

- [ ] wire tasks 18, 26, 27, 28: sources → rules (re-run one item on its `item` and Jev answer, all on a rules change) →
  groups → panel state; the app-version check (`typeof ctx.slots === 'object'` and `ctx.overlay.buttons`), with a clear
  message naming cc-cockpit 0.10.0 when missing
- [ ] header via `ctx.panels.header`: meta "updated HH:MM", a refresh action calling `snapshot()` on every source; no
  settings action (the app's gear)
- [ ] agenda: `ctx.panels.slots('main', [{ type: 'agenda', position, height: 140 }])` from the setting, `null` when off;
  re-placed when the setting changes; Inbox does not read the calendar
- [ ] `ctx.overlay.buttons('inbox-item', …)`: "Done (Inbox)" for items it holds, `run` marks Done and returns `{ close: true }`
- [ ] row actions route to `act(id, action)` on the item's provider handle (the `useAll` handle of that `pluginId`),
  `open` included; the result's `message` shown on failure
- [ ] badge: unread items in `badge: true` groups; settings read from `ctx.appStorage` `settings`, changes from the
  settings page applied at once in this window and on the next read in others
- [ ] write tests with the fake ctx: two sources then a third, a source leaving, rules applied, Jev move, Done via the
  overlay button, agenda placement per setting, badge, act failure message, missing app members → the message
- [ ] run `npm test` — done when green

### Task 30: Inbox panel v2 [model: opus]

**Files:**
- Modify (rewrite): `panels/main.html`, `panels/main.js`, `panels/rowlogic.js`; Delete: `panels/timeline.js`,
  `panels/settings.js`, `panels/settingslogic.js`, `test/settings-view.test.js`; Modify: `test/panel.test.js`

- [ ] design-v2 "The panel": toolbar (search `/`, chips All / per source / Done), source error lines `.cc-error-line` with
  refused and over-cap counts, groups `details.cc-group` with counts (Rest collapsed, open state remembered), rows
  `.cc-row` (badge, title, from · place · time, preview line muted, ≤ 3 labels `.cc-chip`, reason muted; actions on hover
  and focus: the source's actions except `open`, then Done), Done view, undo toast, snooze menu (v1)
- [ ] keys: `j`/`k`, Enter, `e`, `u`, `s` then `1`-`4`, `/`, Esc; everything from sources as text (no `innerHTML` of
  provider strings), colours by palette name; the components stylesheet, no own controls where one fits
- [ ] write tests for the pure render and key functions: rows, groups, reasons, chips, Done view, search results, error
  lines, empty states, hostile titles escaped
- [ ] run `npm test` — done when green

### Task 31: Inbox settings page [model: opus]

**Files:**
- Create: `settings/index.html`, `settings/index.js`, `settings/logic.js` (pure), `test/settings-page.test.js`
- Modify: `dist/host.js` (`ctx.settingsPage.onOpen`: send settings, sources, the test results; validate and store what the
  page sends)

- [ ] design-v2 "Settings page": Groups (add, rename, reorder, delete → its rules move to Rest, collapsed, badge), Rules
  (ordered list, move up/down, enable, duplicate, delete, inline edit of group + conditions and/or a Jev question with
  threshold), "Test" (count and five examples, Jev from cache only), Sources (read-only: label, scope, state, count, the
  note on keeping a source out), Agenda (top / bottom / off); a Jev rule shown inactive with no `jev` provider
- [ ] the host validates every save with `lib/settings.js`; a refused save shows the reason; no secrets posted
- [ ] components stylesheet; keyboard reachable
- [ ] write tests: pure logic (edits, reorder, delete group moving rules, Test results), host save round trip and refusal
- [ ] run `npm test` — done when green

### Task 32: `ccc inbox` v2 and the Inbox docs [model: sonnet]

**Files:**
- Modify: `dist/lib/cli.js`, `test/cli.test.js`, `plugin.json` (CLI entry text if needed), `README.md`,
  `docs/design-v2.md` (status: "built as 0.2.0", deviations)

- [ ] `ccc inbox [list]` (groups with numbered rows and reasons), `open <n|ref>`, `act <n|ref> <action>`, `done <n|ref>`,
  `undo`, `why <n|ref>` (the full trace), `snooze` (as v1), `help`; a ref is `<pluginId>:<id>`; bounded output
- [ ] README: what Inbox 0.2.0 shows, the feed v2 contract summary for a new source, rules, settings page, keys, CLI, needs
  cc-cockpit 0.10.0 and the source versions (Gmail 0.5.0, Chat 0.3.0, Jira 0.7.0, Calendar 0.3.0 for the agenda)
- [ ] write tests: each command, refs, bad arguments, empty inbox, `why` output
- [ ] run `npm test` — done when green

### Phase G — Sessions as a bundled plugin (repo `~/Projects/cc-cockpit`)

### Task 33: `ctx.sessions` scope, actions and the `access` declaration [model: opus] [SYNC]

**Files:**
- Modify: `src/shared/manifest.ts` (top-level `access: { sessions: 'all-windows' }`), `src/main/plugins/validate.ts`,
  `src/host/ctx/sessions.ts`, `src/main/plugins/host-api.ts` (sessions rows), `src/main/sessions/session-registry.ts`
  (summaries across windows), `src/main/windows/window-manager.ts` (raise another window), `src/main/sessions/open-file.ts`
  (route a recorded file), the close path with `CloseTabDialog` / `confirmTabClose`, `src/sdk/types.ts`,
  `src/renderer/settings/PluginsPage.tsx` and the install confirmation (show the declaration)
- Modify: `test/unit/host-api.test.ts`, `session-registry.test.ts`, `manifest.test.ts`, `open-file.test.ts`

- [ ] `list({ scope })` / `onChange(listener, { scope })` (4/s); `scope: 'all'` only with the declaration (throws
  otherwise) and only `SessionSummary` fields (status, tool, title, name, project name/colour, `own`) — never prompts,
  notes, files, cwd or terminal content
- [ ] `focus(tabId)` any Claude tab (raises its window); `close`, `openFile` only this window's tabs (main's lookup of the
  host's project); `close` through the person's close path (`closed: false` on Cancel); `openFile` only a file main
  recorded for that tab, routed by the `@open-file` pick else the built-in viewer
- [ ] limits per Technical Details "Sessions limits"; `send` unchanged (this window and the gate)
- [ ] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [ ] write tests: scope refusal without the declaration, field filtering, other-window ids refused for close/openFile,
  focus across windows, each limit, an unrecorded file refused
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 34: Session rename [model: sonnet] [SYNC]

**Files:**
- Modify: `src/host/ctx/sessions.ts` (`rename`), `src/main/plugins/host-api.ts`, `src/main/sessions/session-registry.ts`
  (`name` on `SessionInfo`), `src/main/restore.ts` (stored on the tab's restore record), `src/renderer/tabs/TabBar.tsx` and
  `src/renderer/tabs/tab-label.ts` (name over title), the core tab context menu (Rename), `src/sdk/types.ts`
- Modify: `test/unit/restore.test.ts`, `session-registry.test.ts`, `host-api.test.ts`; Create/Modify an e2e
  `test/e2e/session-rename.spec.ts`

- [ ] 1-60 characters, control characters refused, `null` back to Claude's title; 30 a minute per plugin and window;
  this window's tabs only; persisted over restore
- [ ] guide `api.md` sessions section (scope, focus, close, rename, openFile, the declaration) — together with task 33's
  members if task 33 did not write them; `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/session-rename.spec.ts
  test/e2e/restore.spec.ts test/e2e/plugin-sessions.spec.ts` — done when green

### Task 35: `cockpit.sessions` bundled plugin [model: opus]

**Files:**
- Create: `plugins/sessions/plugin.json`, `plugins/sessions/dist/host.js`, `plugins/sessions/dist/lib/*.js`,
  `plugins/sessions/panels/sessions.{html,js}`, `plugins/sessions/slots/strip.{html,js}`, `plugins/sessions/README.md`,
  `plugins/sessions/test/*.test.js`, `plugins/sessions/icons/*`
- Modify: `src/main/plugins/bundled.ts` (`BUNDLED_PLUGINS`), `electron-builder.yml` (extraResources),
  `eslint.config.js` (ignores like the other plain-JS plugins), `test/unit/bundled-plugins.test.ts`,
  `test/unit/packaging-config.test.ts`

- [ ] design-next §4.2: panel `sessions` (zone left) with today's cards (name or title, gist or last prompt, status, notes,
  steps, changed files first N with Show all, file click → `openFile`, card click → `focus`), header meta "N in this
  window"; slot `sessions-strip` (other windows' tabs, needs-you first and tinted, project colour dot, click → `focus`,
  nothing drawn without one); app setting `filesShown` 1-500 default 10; `"access": { "sessions": "all-windows" }`;
  plain DOM with the components, no React, public API only
- [ ] migration (no runtime privilege for `cockpit.*`): main seeds the plugin's app setting once at start, as a data
  migration like the layout key one: when `app.json` has `sessionFilesShown` and `cockpit.sessions` has no stored
  `filesShown`, store it as the plugin's app setting, then drop `sessionFilesShown` (a unit test in
  `test/unit/settings-service.test.ts` or next to the migration)
- [ ] write `node:test` tests: card rendering, strip ordering and tint, file list cap, the empty strip
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:plugins` — done when green

### Task 36: Remove the renderer's Sessions panel and strip [model: opus]

**Files:**
- Delete: `src/renderer/sessions/SessionsPanel.tsx`, the strip parts of `src/renderer/status/TopStrip.tsx` (keep what
  the top bar still needs: project name, "+", the slot frame), `strip-order.ts` if unused
- Modify: `src/main/layout/layout-service.ts` / `src/shared/layout.ts` (core Sessions panel key →
  `cockpit.sessions/sessions` at first load, same zone, order, open state), `src/renderer/status/use-sessions.ts`
  (drop the `own` strip snapshot IPC if nothing else uses it), `src/main/ipc/router.ts`, `src/main/index.ts`
  (`sessionFilesShown` setter gone after the migration)
- Modify: `test/e2e/sessions-panel.spec.ts`, `test/e2e/top-strip.spec.ts` (now through the plugin), a new e2e case with
  `cockpit.sessions` off (no strip, no panel, tabs, dots, `ccc sessions` and notifications fine), `test/unit/layout*.test.ts`
- Modify: `docs/design.md` (§1 core, §3 Claude status UI, §5 Host API sessions row, Bundled plugins), `CLAUDE.md`
  (bundled list in "Implementation patterns"), `src/cli/guide/*.md` mentions of the core Sessions panel, `docs/features.md`

- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:plugins`, `npm run build`,
  `npx playwright test test/e2e/sessions-panel.spec.ts test/e2e/top-strip.spec.ts test/e2e/status.spec.ts
  test/e2e/bundled-plugins.spec.ts test/e2e/zones.spec.ts` — done when green

### Phase H — Settings (repo `~/Projects/cc-cockpit`)

### Task 37: Settings pages reorganised [model: opus]

**Files:**
- Create: `src/renderer/settings/GeneralPage.tsx`, `src/renderer/settings/KeybindingsPage.tsx`
- Modify: `src/renderer/settings/SettingsOverlay.tsx` (sections General, Appearance, Keybindings, Plugins, This Project,
  Projects; Marketplace stays a section until task 43), `AppearancePage.tsx` (split), `ProjectPage.tsx`
- Modify: `test/e2e/settings-*.spec.ts`, `test/e2e/tab-command-keys.spec.ts`, `test/e2e/theme.spec.ts`, any spec that
  navigates by section name; `src/cli/guide/*.md` and `docs/features.md` naming settings locations

- [ ] design-next §5.1: every setting in exactly one page (General: tab behaviour, app-wide new-tab commands,
  notifications and sound, session gist, command line, update notice; Appearance: theme, window background, terminal
  font, tab close side; Keybindings: search, list, overrides, conflicts, Unbind, Reset; This Project: colour, enabled
  plugins, project new-tab commands, panel zones, slot and service picks, per plugin project settings)
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/settings-*.spec.ts
  test/e2e/tab-command-keys.spec.ts test/e2e/theme.spec.ts test/e2e/terminal-font.spec.ts` — done when green

### Task 38: Global values of project fields and overrides [model: opus] [SYNC]

**Files:**
- Modify: `src/main/settings/{project-settings-service,settings-service,plugin-settings,plugin-config}.ts`,
  `src/shared/plugin-config.ts`, `src/host/ctx/settings.ts` (effective values), `src/main/secrets/plugin-secrets.ts` (new `setting:projectDefault:<field>`), `src/main/projects/registry.ts`
  (`pluginProjectDefaults` in `app.json`), `src/cli/` `plugin config` (`--scope global|project`, `--use-global`),
  `src/cli/guide/cli.md` and `settings-secrets.md`, `src/sdk/types.ts` (doc comments)
- Modify: `test/unit/{project-settings-service,settings-service,plugin-settings,plugin-config,secret-settings,
  ctx-settings,plugin-cli}.test.ts`

- [ ] design-next §5.2: effective = override → global → default, top-level fields only; validation over the effective
  object; a save that makes any open project's values invalid is refused naming the project; `onSettingsChange` in every
  project whose effective values changed; secret global values in the plugin's secret store, never in JSON
- [ ] migration at first start: a stored project value equal to the schema default is dropped; others stay overrides;
  secrets stay overrides
- [ ] `cp src/sdk/types.ts examples/plugin/sdk/types.ts`
- [ ] write tests: merge (plain and secret), validation refusal naming the project, fan-out, migration, CLI flags
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 39: "Use global" in This Project, the global page, the html page placement [model: opus]

**Files:**
- Modify: `src/renderer/settings/{PluginSettingsForm,PluginsPage,ProjectPage,PluginSettingsPage}.tsx`, the router
  calls for global values and overrides, `test/e2e/settings-project.spec.ts`, `test/e2e/plugin-config.spec.ts`,
  `test/e2e/settings-page.spec.ts`

- [ ] Plugins › gear opens the plugin's **global** page: `app` fields plus the global values of `project` fields, then the
  html page with app scope; This Project per plugin: each project field "Use global" (default) or an override, then the
  html page with project scope
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/settings-project.spec.ts
  test/e2e/plugin-config.spec.ts test/e2e/settings-page.spec.ts test/e2e/plugin-secrets.spec.ts` — done when green

### Task 40: The panel gear, guide and design.md [model: sonnet]

**Files:**
- Modify: `src/renderer/zones/PanelHeaderBar.tsx` (gear after plugin actions, before "…", for a plugin with settings),
  the settings open path (target page and plugin), `src/cli/guide/panels.md` (no `settings` header action, no settings
  forms in a panel), `src/main/claude-plugins/core-skill.md` (review rule), `docs/design.md` (§6 Settings list, "forms plus
  an optional page", §6 CLI table, secrets reserved keys), `test/e2e/panel-header.spec.ts`

- [ ] the gear opens This Project at the plugin when it has project settings (schema or a page with project scope), else
  its global page
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/panel-header.spec.ts`
  — done when green

### Phase I — Marketplace (repo `~/Projects/cc-cockpit`)

### Task 41: Preview and category in the index and its CI tools [model: opus]

**Files:**
- Modify: `src/shared/marketplace.ts` (`parseEntry`: `preview: { sha256 }` optional, `category` with unknown → `other`),
  `marketplace/tools/src/{check-entry,build-index,common}.ts` (read `preview.png` from the checkout: regular file, no
  symlink, PNG signature, IHDR size in range, ≤ 512 KiB, no `acTL`; publish `previews/<id>/<commit>.png`; `category`
  refused when unknown; the `--preview-required-from` parameter: missing preview → warning before the date or when
  null, refusal after), `marketplace/preview-policy.json` (`{ "requiredFrom": null }`), the index workflows in
  `marketplace/.github/workflows/` that run `check-entry` / `build-index` (pass the date; publish `previews/`),
  `marketplace/README.md` (preview and category rules)
- Modify: `test/unit/marketplace.test.ts`, `marketplace-tools.test.ts` (fixture repo with good, oversized, wrong-size,
  animated and symlinked previews; with and without the date); run `npm run build:marketplace-tools` and commit the dist

- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green (the dist byte test included)

### Task 42: Preview fetch, cache and display [model: opus]

**Files:**
- Modify: `src/main/marketplace/{fetch-index,marketplace-service,marketplace-view}.ts` (lazy fetch from the index's own
  folder, no redirect, body ≤ 512 KiB, sha256 and PNG signature checked, cache in `<data>/marketplace/previews/`),
  `src/main/ipc/router.ts` (bytes to the renderer), `src/renderer/index.html` (`img-src blob:`), the card component,
  installed folder/git plugins' own `preview.png` through `cc-plugin://` when present
- Modify: `test/unit/marketplace-service.test.ts` (fake fetch: good, wrong hash, redirect, oversized, cache hit)

- [ ] placeholder with the name's initial when no preview; never the real network in tests
- [ ] run `npm test`, `npm run typecheck`, `npm run lint` — done when green

### Task 43: One Plugins page with paging, search and filters [model: opus]

**Files:**
- Create: `src/renderer/settings/plugin-list-model.ts` (pure paging, search, filters, categories), `test/unit/plugin-list-model.test.ts`
- Modify: `src/renderer/settings/PluginsPage.tsx` (cards: preview, name, author, version, repo as plain text, description,
  state; per card Install / Update / Move to safe version / Enable in this project / gear / Off in all projects / Uninstall),
  "Add plugin…" (git URL install, Link folder), collapsible index management at the bottom; Delete
  `src/renderer/settings/MarketplacePage.tsx` and its section in `SettingsOverlay.tsx`
- Modify: `test/e2e/settings-marketplace.spec.ts`, `settings-plugins.spec.ts`, `settings-plugin-install.spec.ts`,
  `marketplace-revoked.spec.ts`, `test/unit/settings-marketplace.test.ts`

- [ ] 20 per page; case-insensitive substring search over name, id, author, description (no regex); filters Installed /
  Available / Updates and category; the page touches the network only through the existing marketplace fetch
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/settings-marketplace.spec.ts
  test/e2e/settings-plugins.spec.ts test/e2e/settings-plugin-install.spec.ts test/e2e/marketplace-revoked.spec.ts` — done when green

### Task 44: Update all [model: opus]

**Files:**
- Modify: `src/main/marketplace/marketplace-service.ts` (sequential checked updates: clone the tag, `rev-parse HEAD`
  against the pinned commit, `expect` from the confirmation, revocation check, repo-change rule; failures collected,
  no rollback of successes), `src/main/ipc/router.ts`, `src/renderer/settings/PluginsPage.tsx` (button + one confirmation
  listing each plugin's current and new version, repo and commit; the failures after)
- Modify: `test/unit/marketplace-service.test.ts`; Create: `test/e2e/marketplace-update-all.spec.ts` (`file:` index, two
  updates, one failing)
- Modify: `docs/design.md` (§5 Marketplace: preview, category, Update all; §6 Settings list)

- [ ] linked, git-URL and revoked plugins never included; only plugins with a newer listed version from their recorded index
- [ ] run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx playwright test test/e2e/marketplace-update-all.spec.ts`
  — done when green

### Phase J — Verification and docs

### Task 45: Verify acceptance criteria [model: sonnet]
- [ ] verify decisions 1-15 of `docs/feedback/20261104-real-work.md` are implemented (one line each, with the test or file)
- [ ] verify design-next §1-§6 "Main enforces" items each have a test; design-v2 "Tests" list covered
- [ ] edge cases: no slot provider, two providers no pick, Inbox with no source, a source signed out, no `jev` provider,
  `cockpit.sessions` off, an overlay from an older plugin (no type: ✕ only)
- [ ] run in `~/Projects/cc-cockpit`: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:plugins`,
  `npm run test:e2e` (only the known failures of Development Approach may fail; list any other with ⚠️)
- [ ] run `npm test` in `~/Projects/cc-cockpit-{inbox,gmail,chat,jira,calendar}`
- [ ] scan all six repos' changes of this plan for a work email, employer name or real data (`git log -p` since the plan's
  first commit, grep for `@` addresses that are not `example.com`/`example.org`, real names, issue keys other than `PROJ-`)
- [ ] `diff src/sdk/types.ts examples/plugin/sdk/types.ts` is empty; list the [SYNC] tasks' example changes for the push

### Task 46: [Final] Update documentation [model: sonnet]
- [ ] `docs/design.md`: every "Changes to design.md" line of design-next §1-§6 applied (check each); `docs/design-next.md`
  status "built", with deviations; `docs/features.md`, `README.md` for the new features and known limitations
- [ ] `CLAUDE.md` "Implementation patterns": slots (`@slot:` picks, app slot types, frames drawn by the shell), overlay
  buttons (host registry, main checks), settings overrides storage, `cockpit.sessions` in the bundled list
- [ ] source plugin READMEs state their scope line and the app/Inbox versions they need
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification** (test copy: `npm run package:dir` + a copied data dir, real plugins linked):
- Inbox with real Chat, Gmail, Jira: default groups, a rule above them, a Jev rule moving the manager's mail once, Done
  returning on a new message, search into Rest and Done, the agenda slot top/bottom/off, Done (Inbox) and Mark read in the
  item's overlay, Discuss with and without a note to an existing and a new tab.
- Sessions strip and panel through `cockpit.sessions` with two windows; the plugin off; rename over a restart.
- Settings: every page, a project override vs global, the panel gear, Inbox's rules page.
- Marketplace: previews, paging, search, Update all.

**Releases (the user's word, in this order)**:
- app 0.10.0 (version bump, tag, publish, AUR) and the example repo push of the synced `sdk/types.ts` and `examples/plugin`
  changes (tasks marked [SYNC]: 1, 3, 6, 9, 15, 33, 34, 38).
- the index repo: the preview/category CI tools, then set `marketplace/preview-policy.json` `requiredFrom` to 60 days after
  the app release.
- Gmail 0.5.0, Chat 0.3.0, Jira 0.7.0, Calendar 0.3.0, Inbox 0.2.0 together (clean break of `inbox-feed`), each with a
  `preview.png`, a category, and a description naming cc-cockpit 0.10.0; marketplace PRs.

**Out of scope here**: a Jev "Improve triage" overlay button (a Jev-based plugin may add it later), Calendar invitations
as feed items, "in the Inbox" marks in source panels, inline slots, `ccc overlay --type`.
