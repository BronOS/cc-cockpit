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
- CSP: the plugin's own files only; no network, no inline script, no inline event handlers. Put
  code in a separate `.js` file next to the html.
- Include the SDK first: `<script src="/__sdk/panel.js"></script>`. It defines `ccPanel`.

## `ccPanel`

- `ccPanel.post(message)`: send JSON (at most 1 MiB) to the plugin host, where
  `ctx.panels.onMessage(panelId, fn)` hears it. Messages posted before the connection is up are
  queued.
- `ccPanel.onMessage(listener)`: hear what the host sends with `ctx.panels.post`. Returns an
  unsubscribe function.
- `ccPanel.theme.current`: the app's current theme `{ kind, vars }`; the CSS variables are
  already set on `:root`, so style with `var(--...)`. `ccPanel.theme.onChange(listener)` fires on
  every change.

A panel has no API of its own: everything goes through its plugin host, which decides what the
page may do. Fetch data in the host (`ctx.exec`, network) and post the result.

## Overlay pages

An html overlay (`ctx.overlay.open({ kind: 'html', file })`) is a plugin page loaded the same way.
It answers with `ccPanel.post({ result: value })`, which closes the overlay and resolves `open`
with `{ kind: 'value', value }`.

## Badges

`ctx.badge(panelId, n | 'dot' | null)` shows a count or a dot on the panel's icon.
