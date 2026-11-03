# Panels and the panel SDK

A panel contribution (`contributes.panels`) gives `id`, `title`, `entry` (the html page),
optional `icon` and `defaultZone` (`left`, `right` or `bottom`). The user can move it between
zones. With `"kind": "webview"` the panel is a web view instead and has no `entry`: see
`ccc guide webview`.

The `icon` (a path in the plugin folder) is an SVG or PNG used as a single-colour mask: only its
shape and alpha count, colours in the file are ignored, and the strip paints it in its own text
colour (so it follows the theme, hover and open states). Recommended: an SVG with
`viewBox="0 0 24 24"`, drawn at the strip's icon size (18px). Without an icon, or when it fails to
load, the strip shows the title's first letter.

## The page

- Served from the plugin's own folder as `cc-plugin://<pluginId>/<entry>` in a sandboxed frame.
- CSP (sent with the page): scripts, fonts and `fetch`/XHR only from the plugin's own files;
  images from its own files and `data:`; styles from its own files and **inline**, so a `<style>`
  block and `style="..."` attributes work; no inline script, no inline event handlers, no network,
  no frames, no form posts, no `<base>`. Put code in a separate `.js` file next to the html.
  Module scripts work: `<script type="module" src="main.js">` with static `import` and dynamic
  `import('./x.js')` of your own files (and top-level `await`), so split code into ES modules
  without a bundler; an import from another host or a bare package name (`import 'lodash'`)
  fails (no import maps: they would be inline script). The frame is sandboxed with scripts
  only: its origin is opaque, so no `localStorage` or cookies; keep state in the host.
- A panel or overlay page cannot submit a `<form>`: the frame is sandboxed without
  `allow-forms`, so its `submit` event never fires (Enter in a field included). Use buttons
  (`type="button"`) and act on their `click`.
- Include the SDK first: `<script src="/__sdk/panel.js"></script>`. It defines `ccPanel`.

## `ccPanel`

- `ccPanel.post(message)`: send JSON (at most 1 MiB) to the plugin host, where
  `ctx.panels.onMessage(panelId, fn)` hears it. Messages posted before the connection is up are
  queued.
- `ccPanel.onMessage(listener)`: hear what the host sends with `ctx.panels.post`. Returns an
  unsubscribe function.
- `ccPanel.theme.current`: the app's current theme `{ kind, vars }`; the CSS variables are
  already set on `:root` (and `color-scheme` is `kind`), so style with `var(--...)`.
  `ccPanel.theme.onChange(listener)` fires on every change. The shell sends the theme in a
  message after the page loads, so the first paint can come before it.

## Theme variables

Every variable below is set on a panel's `:root`, in light and dark and in any theme, since a
theme a plugin contributes is laid over the built-in one of its `kind` and so never lacks a name.
A theme may also bring names of its own, which panels get too.

- Surfaces: `--cc-bg` (window), `--cc-bg-bar`, `--cc-bg-menu`, `--cc-bg-banner`, `--cc-bg-error`
  (a tinted error background), `--cc-surface-1`, `--cc-surface-2`, `--cc-surface-3` (raised
  steps), `--cc-terminal-bg`.
- Text: `--cc-fg`, `--cc-fg-muted`, `--cc-fg-subtle` (the two weaker steps).
- Lines: `--cc-border`, `--cc-border-strong`.
- Accent: `--cc-accent`, `--cc-accent-hover`, `--cc-accent-fg` (text on an accent fill),
  `--cc-accent-soft` (a translucent tint), `--cc-focus` (focus ring).
- `--cc-shadow`: a shadow colour.
- Status, the colours the Claude tabs use: `--cc-status-starting`, `--cc-status-idle` (greys),
  `--cc-status-working` (blue), `--cc-status-needs-permission` (orange, a warning),
  `--cc-status-waiting` (green, ok), `--cc-status-ended` (red, an error).
- Project colours: `--cc-project-red`, `-orange`, `-yellow`, `-green`, `-teal`, `-blue`,
  `-purple`, `-grey` (each prefixed `--cc-project-`).

There is no separate error or success token: use `--cc-status-ended` / `--cc-status-waiting` for
red and green text or dots, and `--cc-bg-error` behind an error message.

A panel has no API of its own: everything goes through its plugin host, which decides what the
page may do. Fetch data in the host (`ctx.exec`, network) and post the result.

## Overlay pages

An html overlay (`ctx.overlay.open({ kind: 'html', file })`) is a plugin page loaded the same way.
It answers with `ccPanel.post({ result: value })`, which closes the overlay and resolves `open`
with `{ kind: 'value', value }`.

Opened with `ctx.overlay.start(spec)` instead, the page and the plugin also talk while it is open:
`ccPanel.post(message)` without a `result` key leaves the overlay open and reaches the handle's
`onMessage`; `ccPanel.onMessage(fn)` hears the handle's `post` (sent once the page has loaded). A
message is at most 1,040,384 chars of JSON (1 MiB less 8 KiB); a larger page message is dropped
with a console warning. Only the plugin that opened the overlay hears its page. Esc (or ✕,
Cmd+Shift+W) closes the overlay as `{ kind: 'dismissed' }` without asking the page: a page with a
draft should post it as it changes, so nothing is lost when the user presses Esc.

```js
// host
const chat = ctx.overlay.start({ kind: 'html', file: 'chat.html', title: 'Chat' })
chat.post({ history })                       // queued until the page has loaded
chat.onMessage((m) => saveDraft(m.draft))    // the page posts { draft } on every change
const result = await chat.result             // { kind: 'value', value } or { kind: 'dismissed' }
// page
ccPanel.onMessage((m) => render(m.history))
input.addEventListener('input', () => ccPanel.post({ draft: input.value }))
send.addEventListener('click', () => ccPanel.post({ result: input.value }))
```

## Badges

`ctx.badge(panelId, n | 'dot' | null)` shows a count or a dot on the panel's icon.
