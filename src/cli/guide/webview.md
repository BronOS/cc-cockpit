# Webview panels

A panel with `"kind": "webview"` is a native web view that the app lays over the panel: a small
browser your plugin drives from its host with `ctx.webview`. Use it to show a web page, a local
dev server or a local html file (a design mock-up) inside the app.

## Manifest

```json
"contributes": {
  "panels": [{ "id": "view", "title": "Preview", "kind": "webview", "defaultZone": "right" }]
}
```

A webview panel has no `entry` (the manifest is refused if it has one); an html panel (`kind`
absent or `"html"`) still needs its `entry`. The plugin needs a `main` to drive the view.

## Driving it

```js
exports.activate = (ctx) => {
  ctx.webview.onNavigate('view', (page) => ctx.log.info('showing', page.url, page.title))
  // An http(s) URL, or an absolute file path (resolve a relative one against the caller's cwd).
  void ctx.webview.navigate('view', 'http://localhost:5173/')
}
```

- `ctx.webview.navigate(panelId, target)`: the view is created on the first call and closed when
  the plugin deactivates or the window closes. Resolves once the page loaded (or after 10 s for a
  slow one); rejects when it failed to load before that (nothing listening on the port, a refused
  connection), with the error in the message. There is no browser error page: the view shows an
  empty page at the failed URL, `current()` carries the error and the toolbar shows it.
- `ctx.webview.back(panelId)`, `forward(panelId)`, `reload(panelId)`: no-ops before the first
  navigate.
- `ctx.webview.current(panelId)`: `{ url, title }`, empty strings before the first navigate. The
  url is cut at 8192 characters, the title at 1024, with control characters turned into spaces.
  After a failed load also `error` (`ERR_CONNECTION_REFUSED (-102)` and the like), the title is
  empty; the next page that loads clears it.
- `ctx.webview.onNavigate(panelId, fn)`: pages the view commits (links, redirects, history),
  failed loads (with `error`) and title changes, at most one call per 100 ms (a burst reports its
  first and its last state).
  Returns a disposer.
- `panelId` must be one of your own webview panels (anything else throws); `ctx.panels.post`
  and `ctx.panels.onMessage` throw for a webview panel.

## In the window

- The panel shows a toolbar (back, forward, reload, the page's URL, open in the system browser
  for an http(s) page) above the view; after a failed load a line between the two says why
  (Reload tries again). A panel starts closed like any other: call
  `ctx.panels.show(panelId)` when a command should bring it into sight (it unhides it, opens it
  and expands its zone).
- The view is a native layer above the window, so the app hides it while it cannot be seen
  properly: the panel closed, hidden or in a collapsed zone, a splitter being dragged, or a menu,
  the command palette, a dialog, settings or an overlay up. It comes back where the panel is.
- Keys typed into the page stay with the page, except the app's own chords with Cmd, Ctrl or Alt
  (new tab, toggle a zone, the palette, ...), which run in the app as if typed there.
- With web access a browser view of a project open on a desktop shows a placeholder in the panel
  ("available on the desktop"): the view is a native layer of the desktop window.
- In server mode (the app on a server with no display, used only from browsers) the panel works: the
  page runs in an off-screen view on the server and is streamed to every browser that shows the panel
  (pictures with some latency; the browser's click, scroll, keys, typing, paste and copy go back), and
  `navigate`, `back`, `forward`, `reload`, `current` and `onNavigate` behave as on the desktop. Local
  files, a dev server on the server's localhost and external sites all load. A `navigate` for a panel
  no browser shows yet is kept and loads when one first shows it (a `navigate` made while one of your
  `ccc` commands runs loads at once, so `ccc browser open` gets its result). At most 4 views per
  project and 12 per app: a `navigate` past that rejects with the reason, so catch it (a navigate at
  activation must not fail your plugin). Not there: file uploads, downloads, sound, and the page's own
  `alert`/`confirm`/`prompt` (silenced); a `<select>` in an iframe is keyboard-only. The panel has one
  size, set by the last screen the person used.

## Local files

A file is served read-only from its folder as `cc-preview://<token>/<file>`, so css, images and
scripts next to it load with relative URLs. The token is random and dies with the view.

- Refused: a relative path, a dot-file, a file whose folder is `/`, the home folder or one of its
  ancestors (under any spelling, `/System/Volumes/Data/...` included), the top folder of a disk
  (`/Volumes/<disk>`), or a shared temp folder itself (`/tmp`, `/var/tmp`, `$TMPDIR`: put the file
  in a folder of its own there), files inside `~/Library` (except a cloud drive's folder in
  `~/Library/CloudStorage` or `~/Library/Mobile Documents`), and files with a dot-folder anywhere
  on their real path (`~/.ssh`, a project's `.git`, `/opt/.x/...`, a Claude Code worktree under
  `.claude/worktrees`). Move or copy the file into a project folder (from a worktree: into a folder
  of its own outside the dot-folder, for example under `/tmp`).
- Never served: dot-files and anything in a dot-folder, anything a symlink leads outside the
  folder, files over 50 MiB. A plugin's pages in a project get a 503 while their responses not yet
  read hold over 100 MiB in total, until they read or drop them.
- The page's CSP allows its own token only (inline script and style, `data:` and `blob:`
  included): no fetch, XHR, image, frame or form post to http(s). It sends no referrer. That does
  not cut it off the network: a link or script can still navigate the view to an http(s) URL with
  data in the query, and dns-prefetch/preconnect hints and WebRTC are not covered by the CSP
  (WebRTC is kept off non-proxied UDP). Do not show a page you do not trust from a folder with
  anything secret in it.

## What a page may do

- Links, scripts and redirects may go to http(s) and to the view's own `cc-preview` pages;
  anything else (`file:`, another view's token, custom schemes) is dropped.
- `window.open` and `target="_blank"` open in the system browser (http(s) only, at most 3 per
  10 s per view; the rest are dropped).
- No permissions (camera, notifications, ...), no downloads, no access to the app. Cookies and
  storage live in memory, per project and plugin, until the app quits.
