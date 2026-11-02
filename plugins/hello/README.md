# hello

The reference plugin for cc-cockpit. It uses every contribution point and most of the host
API (not `sessions.open`, `dataDir`, `log.info`, `storage.delete/keys` or `url`
overlays), so copy it as the starting point of a real plugin. The API itself is typed in
`src/sdk/types.ts` (host side) and `src/sdk/panel.ts` (panel side); `docs/design.md` §5 explains it.

## Link it in development

```sh
npm run build:hello          # builds dist/host.js (committed, but rebuild after every edit)
```

Then, in the app: Settings > Plugins > "Link folder…", and pick `plugins/hello`. Open a project,
Settings > This project, tick "Enable Hello". The "Hello" icon appears in the left strip.
A linked folder is watched: after a rebuild the plugin host restarts by itself.

## Rebuild

```sh
npm run build:hello          # node scripts/build-hello.mjs: esbuild, CommonJS, node22
npm run build                # runs it first, then the app
```

The build is deterministic (fixed target, no minifier, no absolute paths), and
`test/unit/hello-dist.test.ts` rebuilds into a temp dir and compares bytes with the committed
`dist/host.js`, so a source edit without a rebuild fails the unit tests.

A plugin ships built JavaScript: `main` in `plugin.json` points at `dist/host.js`, and the app
never compiles TypeScript. The host file imports **types only** from the SDK, so nothing of the
app's code ends up in the bundle.

## Walkthrough

| File | What it shows |
| --- | --- |
| `plugin.json` | The manifest: `api: 1`, `main`, and every `contributes` key: a panel, project and app settings (JSON Schema, no regex `pattern`), a command with a default key, a theme. |
| `src/host.ts` | The host side. One `activate(ctx)`; each section is one `ctx` member (see below). |
| `panels/hello.html`, `panels/hello.js` | The panel page. Script must be a separate file: the plugin's CSP allows script from the plugin's own files only, no inline script, no network. |
| `panels/pick.html`, `panels/pick.js` | A page opened as an html overlay. |
| `icons/hello.svg` | The panel's icon. |
| `themes/hello-dusk.json` | A theme (CSS variables plus xterm colours); the same format as `src/themes/*.json`. |

### Host side (`src/host.ts`)

- **settings**: `ctx.settings.project` / `.app` come validated with the manifest defaults applied;
  `ctx.onSettingsChange` fires when the user saves. Here the greeting (project) and "shout" (app)
  feed the panel heading, and `tickSeconds` re-creates the schedule.
- **secret setting**: `apiToken` in the app schema is a top-level string with `"format": "secret"`
  (no other keyword than `type`, `format`, `title`, `description`, `$comment`). The form shows
  "Set" / "Not set" with Replace and Clear; main stores the value encrypted, and the plugin host
  (never a renderer) sees it as a string in `ctx.settings.app.apiToken`. The panel gets only
  `tokenSet`, a boolean: it never shows the value.
- **secrets**: `ctx.secrets.get/set/delete/keys` is an app-wide, per-plugin store encrypted with the
  OS keychain, for tokens a plugin obtains itself. The "Bump" button keeps a counter there. The
  `setting:` key prefix belongs to secret settings fields: readable, but not writable, and not
  listed by `keys()`.
- **oauth**: `ctx.oauth.authorize(spec)` / `refresh(spec, refreshToken)` (authorization code +
  PKCE, https URLs only) is described in a source comment but not called, since it needs a real
  provider. Keep the tokens it returns in `ctx.secrets`.
- **storage**: `ctx.storage.get/set` is a per-plugin, per-project JSON store. It counts how many
  times the plugin started in this project (`visits`).
- **schedule and badge**: `ctx.schedule(seconds, fn)` runs a job without overlap (the first run is
  one interval from now); `ctx.badge('hello', n)` puts a counter on the panel's icon (`'dot'`, or
  `null` to clear). An error thrown in the job shows as a warning on the icon.
- **exec**: `ctx.exec(['git', 'status', '--short'])` runs a program, never through a shell. A
  non-zero exit code resolves (`result.code`); it rejects when the program cannot start or its output passes 10 MiB.
- **sessions**: `ctx.sessions.list()` and `onChange` give this window's Claude tabs;
  `ctx.sessions.send(tabId, text)` types the text only while the tab waits for input, and queues
  it for the tab's next Stop otherwise (the result says which). Text starting with `/`, `!`, `#` or `&` is
  refused, and sends are rate limited.
- **overlay**: `ctx.overlay.open({ kind: 'terminal', argv })` runs a program in an overlay and
  resolves with its exit code; `{ kind: 'html', file }` shows one of the plugin's own pages, which
  answers with `ccPanel.post({ result })`. The call resolves when the overlay ends.
- **commands**: `ctx.commands.register('say-hello', fn)`; the id must be declared in the manifest.
  The default key can be changed by the user in Settings > Appearance and keys.
- **panels**: `ctx.panels.post(panelId, json)` and `ctx.panels.onMessage(panelId, fn)`. A panel
  that is not shown drops messages, so the page sends `ready` when it loads and the host answers
  with its whole state. Treat every message from a panel as untrusted input.

### Panel side (`panels/hello.js`)

The page loads `/__sdk/panel.js`, which defines `window.ccPanel`: `post(json)`, `onMessage(fn)`,
and `theme` (the app theme is applied to `:root` as `--cc-*` CSS variables, so a page that uses
`var(--cc-bg)` and `var(--cc-fg)` follows light/dark and plugin themes for free).
Render with `textContent`, not `innerHTML`.

## Tests

- `test/unit/hello-dist.test.ts`: the committed bundle is what the build produces, and the
  manifest passes the app's validation (including the secret setting field).
- `test/e2e/hello.spec.ts`: the plugin in the real app with the fake `claude`: panel,
  `git status`, badge ticks, overlays that return a result to the panel, the command, the theme,
  sending text to a Claude tab (queued while it works, delivered on `/stop`), and the secret
  setting (shown only as set / not set) with the `ctx.secrets` counter.
