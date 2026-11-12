---
name: browser
description: Show the user a web page, a local HTML file (a design mock-up) or a local dev server inside cc-cockpit's browser panel. Use when the user should look at something visual instead of reading about it.
---

# Browser panel

cc-cockpit has a built-in browser panel next to the terminal. Use it instead of an external browser
whenever the user should see a page: a mock-up you wrote, a local HTML file, a dev server you started.

Commands (run them in the terminal; they work only inside a cc-cockpit tab):

- `ccc browser open <url>` shows an http(s) URL, for example `ccc browser open http://localhost:5173/`.
- `ccc browser open <file>` shows a local file. A relative path is resolved against the current
  directory, so `ccc browser open ./mockup/index.html` works. The file's folder is served read-only
  (css, images and scripts next to it load). The page may not fetch, load images, frames or post
  forms to http(s), but that does not cut it off the network: a link or script can still navigate
  to an http(s) URL with data in it. Do not show a page you do not trust from a folder with
  anything secret in it.
  Always give a full URL with `http://` or `https://`: a bare host such as `example.com` is read
  as a file path (only `localhost:PORT`, `IP:PORT` and `[::1]:PORT` get `http://` added, with any
  path, `?query` or `#fragment` after the port).
- `ccc browser url` prints the current URL and the page title, or `failed to load: <error>` in
  place of the title when the page did not load.
- `ccc browser reload` reloads the page, for example after you edited the file.

`open` also brings the panel into sight. Notes:

- Put a mock-up in its own folder inside the project. A file directly in the home folder, in `/tmp`
  itself or with a dot-folder anywhere on its path (`.git`, `~/.config`, a worktree under
  `.claude/worktrees`) is refused; from such a place, copy the mock-up's folder to a folder of its
  own (for example under `/tmp`) and open it there.
- Start a dev server first (in the background), then open its URL. If nothing answers yet,
  `ccc browser open` exits 1 with the error (`ERR_CONNECTION_REFUSED`, ...) and the panel shows an
  empty page with that error; once the server is up, run `ccc browser reload`. A page that takes
  longer than 10 s prints `ok`; check `ccc browser url` or the server's log then.
- The panel is for the user to look at. You cannot read the page's content back, only its URL and title.
- In server mode (cc-cockpit on a server, used only from a web browser) the panel works too: the page runs on
  the server and is streamed to the person's browser, so `ccc browser open` works the same (a dev server on
  the server's localhost, a local file and an external site all load). It is a picture with some latency; file
  uploads, downloads and sound do not work, and the page's own alert/confirm/prompt are silenced. At most 4
  pages per project: a `ccc browser open` past the limit exits 1 with the reason.
- `ccc browser --help` prints the usage. `ccc guide webview` explains the panel for plugin authors.
