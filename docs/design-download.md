# Downloads to the person's device — design

Status: implemented (2026-11-15, branch `download`, plan `docs/plans/20261114-download.md`; revision 3 of the design: revision 2
after a Fable review, all findings applied, and the owner's answer on the remote window). Extends `docs/design-web.md` (web access, §9 server mode) and `docs/design-remote-desktop.md` (remote
windows); read those first.

**Problem.** With web access, in server mode and in a remote window, cockpit runs on the server. Claude makes an
artifact there (a report, a build, a folder of images) and the person has no way to get it onto the device in front of
them: Reveal and Open with default app act on the server's screen (refused from a browser, design-web.md §6.1), and the
remote window cancels every download (`electron-remote-window.ts:175`).

Decisions taken with the owner:
- **What:** a file downloads as itself; a folder as a `.zip` built on the server, streamed, capped at 2 GiB of file bytes
  and 20,000 entries; `.git` and `node_modules` left out unless the person includes them.
- **Where:** the Files panel's right-click menu (cockpit.files): the click is the gesture, the download starts at once in
  the clicking view, no confirm. And `ccc download <path>`, with which Claude offers a file: an armed confirm on the
  person's screen naming the full path, never a silent download.
- **Paths:** the Files panel stays inside the project; `ccc download` may name a path outside it, under the editor's
  outside-file rule made one shared rule (§1.2).
- **Remote window** (the Mac's and the Linux desktop's): saves straight to the desktop's Downloads folder, no save
  dialog, a clash gets " (1)", a native notice with Show in Finder / Show in folder, never opened. The gates that replace
  the dialog are the desktop's own (§3.3).

Decided here: one-use per-view tokens on a gateway route `/d/<token>`, minted only for a view that asked (§3); Claude's
dialog accepts over the view's socket and then takes the Files path (§2.2); the include choice is a second menu item and
a checkbox in Claude's dialog (§1.4); the local desktop has no Download (§3.4); our own zip writer on `node:zlib`.

## 1. API and main's rules

### 1.1 Members

- **`ctx.files.download(path, options?: { includeGitAndNodeModules?: boolean }): Promise<void>`** (public API,
  `src/sdk/types.ts`, guide text in the same change). `path` project-relative, `''` the project folder; a folder becomes a
  zip. Resolves once the download was handed to the view, rejects with a message the plugin shows in its panel. Needs a
  live remote origin view (§2.1). HostApi `files.download`: the host's own plugin, the host's scope as caller
  (`systemFilesRequest`), 10 per 60 s per plugin (`RateWindow`), spent before the path is resolved.
- **`ccc download <path>`** (core command, in `CORE_CLI_COMMANDS`; a plugin CLI named `download` is demoted by the existing
  reconciliation). From a Claude tab token or a window token (a shell tab); refused tokenless ("run it in a tab of the
  project"): a tokenless caller names no window anybody looks at. The CLI sends the path made absolute against its cwd.
  Answers at once (§2.2) and never waits for the click; it waits for main's reply up to `DOWNLOAD_REPLY_TIMEOUT_MS` (30 s, a folder count may walk for 10 s), still under the 40 s client deadline. No include flag: that
  choice is the person's, in the dialog.

Both land in `main/files/downloads.ts` (no Electron; gateway and views through hooks), beside `system-files.ts`.

### 1.2 Which paths

**Inside the project** (both members): `resolveProjectEntry` (`system-files.ts`): lexical check, then the whole path and
its parent realpath'd inside. A symlink downloads its target's bytes under the link's name when the target is inside.
Dot files are allowed (`.env`): a download reaches only the owner's signed-in devices (§6), and the person chose it.

**Outside the project** (`ccc download` only; the plugin API refuses it): allowed unless the outside rule refuses the
named path or its real path (both, as the editor's `readOutside`: a `/tmp` link to `~/.ssh/id_ed25519` is refused by its
target). The rule is the editor host's `outsideRefused` (`plugins/editor/dist/lib/files.js:288-353`): `/proc`, `/sys`,
`/dev`, `/run`; under the home `Library/Keychains`, `Library/Application Support`, `Library/Cookies`, compared
case-insensitively on macOS (APFS is, so `library/keychains` names the same folder; a fix the editor gets too); every
dot folder and dot file of the home except the `ALLOWED_HIDDEN_HOME` toolchains and what follows a non-hidden
`node_modules`. Downloads add, inside the project or out: the app's data dir wherever `CC_COCKPIT_DATA_DIR` or
`userData` puts it (`secret.key`, the device records), and `/` and the home itself as a zip root (name a folder in it).

**One rule, not two lists.** The rule moves to `src/shared/outside-paths.ts` (pure; home and platform passed in for tests),
which main imports. The editor host is plain JS with no build and ships its own files, so it cannot import `src/shared`
at run time: `scripts/build-editor.mjs` also emits `plugins/editor/dist/lib/outside-paths.js` from that source (esbuild,
`cjs`, `platform: node`, unminified, committed), `files.js` requires it, and the existing byte-compare test covers it.
Core to plugin, never the other way: a plugin edit must not widen what main hands out.

The rule is structural, not a list of secrets. It does not stop Claude from `cp ~/.ssh/id_ed25519 /tmp/x` and offering
`/tmp/x`; what stands there is the dialog's full path and the person's click (§2.3, §6).

### 1.3 Single files

Regular files only (a FIFO, socket or device refused at the start and again at the GET), read through one verified
descriptor (`verified-read.ts`'s rules: `O_NOFOLLOW | O_NONBLOCK`, `fstat` regular, the name still leads to that inode),
streamed; a new `openVerified` returns the handle instead of a buffer. `Content-Length` is the `fstat` size and exactly
that many bytes go out, so a growing log ends at its size at the open. No server-side cap: the stream costs main no memory
(the remote window caps what it receives, §3.3).

### 1.4 Folders as zip

**Walk.** `lstat` per entry, never following a link, depth ≤ 64. Skipped, counted by reason for Claude's dialog: every
symlink (following them means cycles and duplicates); anything but files and folders; `.git` and `node_modules` folders
*below* the chosen folder unless included (`node_modules/foo` as the root always works; `.gitignore` is not read, a
`dist/` is usually what is wanted); for an outside root, every entry the outside rule refuses (naming the parent must not
skip the rule); the app's data dir; unreadable entries; names a receiving system would misread (containing `\`, a
separator on Windows where `a\..\..\x` leaves the folder; control or bidi characters; invalid UTF-8). Names are
`<root name>/<relative path>` with `/`, so extracting makes one folder; a root name that fails the filter becomes
`download`. Empty folders get their entry.

**Including `.git` and `node_modules`**, off by default:
- *Files click:* two items on a folder row and the project folder, "Download as .zip" and "Download as .zip with .git and
  node_modules". The click has no dialog to hold a checkbox, a dialog only for folders would bring back the confirm the
  owner removed, the menu is a flat list (`panels/tree.js`, no submenus), and a setting would hide a per-download choice.
  Both always show (the page-side `heavy` rule of the first build was dropped): the page cannot tell whether they differ (the listing never shows `.git`, holds direct children
  only, can be filtered or capped, while the walk drops both names at any depth).
- *`ccc download`:* a checkbox in the dialog, unchecked whatever Claude asked; the offer's walk counts both totals, so the
  dialog shows both sizes. The state travels in the accept (§2.2).

**Caps** (`DOWNLOAD_ZIP_MAX_BYTES` 2 GiB, `DOWNLOAD_ZIP_MAX_ENTRIES` 20,000, `src/shared/downloads.ts`): checked by a walk
before a view gets anything (bounded by the caps and 10 s: "too large" or "too many files to count"), again while
streaming (past a cap the stream is cut, §5). They keep the archive inside zip32 (4 GiB offsets, 65,535 entries).

**Writer** (`main/files/zip-writer.ts`, about 200 lines). A file entry: flag bit 3 (sizes in a data descriptor after the
data, nothing buffered) and bit 11 (UTF-8 name), method 8 (deflate, `zlib.createDeflateRaw` level 6 on the thread pool),
CRC by `zlib.crc32` per chunk (Electron is pinned at 45.1.0, whose Node has it; Task 1 asserts it). Never method 0 with a
data descriptor: Archive Utility and some unzippers cannot find the end of such an entry. A folder entry: method 0, size
0, no bit 3. Version made by Unix; external attributes carry only `0644`, `0755` for a file with an exec bit and folders,
never setuid, setgid or sticky. DOS time from the mtime in the server's local time, plus the `0x5455` extended timestamp
(UTC). Each entry opened with `openVerified`; one that shrank is written with what it had, one that grew is cut at its
`fstat` size. Why our own: no zip library is in `dependencies`, the subset is small and fixed, and a runtime dependency
is one more thing to vet; never `zip` or `tar` as a process (a server may lack them, and a process per download is more
to kill). Chunked: a deflated size is unknown until the end.

## 2. Which view gets it

### 2.1 The Files menu: the clicking view, at once

A menu click runs the host's listener inside `dispatchInView` (`host/ctx/origin-view.ts`), so `ctx.files.download`
carries the clicking view, which HostApi's `originOf` keeps only when it is a live view of this host's window:
- a **remote view** (a plain browser or a remote window): main checks path and caps, mints a token for that view and
  sends `downloads.start {requestId, url, name}` to it alone (`ViewRegistry.toView`);
- **no origin** (a timer, a plugin command, the 10 s lapse): refused, "a download needs a click in a browser view";
- the **desktop page**: refused, "the file is already on this computer" (§3.4).

The web client clicks a same-origin `<a href="/d/<token>" download="<name>">` itself. The person's click was in the
plugin's frame; User Activation v2 activates its ancestors, so the shell usually still holds transient activation (about
5 s in Chromium) when `downloads.start` arrives. When `navigator.userActivation.isActive` is false (a slow zip walk, a
browser that does not propagate it) the shell shows the notice "report.pdf is ready — Download", a real link to click.
Task 1 checks Chrome, Firefox and iOS Safari.

The origin view is a hint, not identity (CLAUDE.md): a plugin's code shares the host process and can name any live view
of its window, and activation is no proof of a click (typing in a terminal grants it, design-web.md §6.1). So in a plain
browser a plugin can start a download of a project file without the person's click, at its budget and under the
browser's own multiple-download policy; accepted with the owner's decision (unopened, the owner's devices only, from
inside the project, by code that already runs with the person's rights on the server). The remote window adds its own
gates (§3.3).

### 2.2 `ccc download`: every browser view, first accept wins

Claude's tab names the project window (main's own tables), not the device the person is at. "The view that typed last"
was weighed and dropped: stale when the person moves to the phone, absent for a tab nobody typed in. So the offer goes to
**every browser view of the window** (`toBrowserViews(window)`: never the desktop page or server mode's hidden page),
through `SharedAsks` (`asks/shared-asks.ts`) like the trash confirm: one payload per window, a view joining finds it in
`ready.downloadOffers`, first answer wins, `downloads.settled` takes the other dialogs down.

**Accept over the socket.** The dialog's Download posts `downloads.accept {requestId, all}` on the view's own socket; main
takes the view from the connection (never the payload), settles the offer, re-walks with `all`, and answers that view with
the Files path's `downloads.start`. Cancel posts `downloads.answer {requestId}` and settles it for every view (one "no" is
the person's answer; Claude may ask again). This replaces revision 2's per-view tokens inside the offer, `?all=1` and
settle-on-GET: `SharedAsks` and the views carry one payload per window, `ViewRegistry` has no per-view send within one
ask, and a token minted only for the view that asked is the same as the Files path's. The click on Download is a fresh
activation in the shell itself, so the programmatic click of §2.1 follows it within its window.

If the GET then fails (§5), the accepted offer stays for its remaining life, bound to the accepting device: the failure
notice's Try again posts `downloads.accept` again, accepted from that device only.

- **Holding.** In server mode, no browser view right now is held, not refused (a phone's socket drops while it sleeps):
  a `SharedAsks` option `hold: true` under which `send` returning false does not settle; `DOWNLOAD_OFFER_MS` 10 min. On a
  desktop (not server mode) with no browser view: exit 1, "this project is on this computer: <path>".
- **The CLI says**, exit 0: `offered report.pdf (2.3 MB) to the browser views of this project; the person decides`, or
  `... no browser shows this project now; the offer waits 10 min`. Exit 1 for a refused path, too large, the desktop case,
  or the limits: 3 waiting offers and 10 offers per 10 min per window (a window token has no tab id to key on). Claude is
  not told the answer.

### 2.3 The dialog (`ccc download` only)

`DownloadDialog` (`src/renderer/notices/`, in `ShellNotices`), an `ApprovalDialog` (design-web.md §9.6: no default button,
Enter and Space blocked, never takes focus from a terminal, armed after about a second visible and on top, backdrop click
answers nothing): Claude can be made to time an offer against a click. It shows "Claude in this project offers a
download", the kind, the **full absolute path** and, when the named path is a link, the real path it leads to
(display-safe, wrapped, monospace, never truncated: the directory is part of what is approved), "outside the project" in
the warning colour, the size (for a folder "312 files, 48 MB before compression", the skipped counts and the checkbox with
both sizes), and "this file can run programs when opened" when `runnableByName` (`src/shared/runnable-files.ts`) matches
the name that will be sent (§3.1). No tab title: Claude can set it.

## 3. Transport

### 3.1 The route

`GET /d/<token>` on the gateway, after the Host check and before the cookie-and-key check (a navigation carries no
`DEVICE_KEY_HEADER`, design-web.md §4.1), like `/p/` and `/o/`. Every check runs before anything is consumed:
1. `GET` only (`HEAD` and the rest 405). A `Range` header is ignored: always the whole file, 200.
2. `Sec-Fetch-Site`, when sent, must be `same-origin`.
3. The token: 32 random bytes base64url, in main's memory only, 60 s, bound to device, view, window, the resolved path
   (project-relative, or absolute for an outside offer), the kind and the include choice.
4. The device cookie must be the token's device's: a new cookie-only lookup on `WebAuth` (`authorize` needs the key,
   `auth.ts:459`) that binds the token to that browser's jar. In None mode no cookie, the token alone.
5. The path re-resolved and re-checked (§1.2-1.4): what is served is what the path holds now (no inode compare: nothing is
   destroyed and the rule still holds).
6. Limits: 2 streams per device, 3 zips at once app-wide.

A refusal answers **204 with no body** (a text body could replace the shell page in a browser that ignores `download`)
and sends the reason through `downloads.failed` to the token's view; the token stays live for a retry within its 60 s.
The token is consumed only when the 200 headers go out. Whether some browser makes a second request for one download
(iOS Safari's download manager, Chrome's resume) is not known: Task 1 counts requests per browser, and a browser that does
gets a grace of one more GET from the same device within 10 s, decided then.

Headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<fallback>";
filename*=UTF-8''<percent-encoded>`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy:
no-referrer`, `Content-Security-Policy: sandbox; default-src 'none'`, no redirects. The name: display-safe, no `/` or
`\`; past 200 bytes cut on a code point with the last extension kept (`a.exe<pad>.txt` must not end `.exe`); the
fallback is printable ASCII only, other characters `_`, `"` and `\` escaped (Node's `writeHead` throws past latin1). A
line per download in `web-access.log` (device, display-safe name, bytes, completed or cut).

**Live streams.** `downloads.ts` keeps device → live responses and destroys them on revoke and expiry, `disconnectDevice`,
leaving None mode and gateway stop (the gateway's `onRevoked` only terminates WebSockets, `gateway.ts:378-382`, and
`trusted` only clears the sign-in timer, `gateway.ts:660`). A stream outlives its view: a reconnect mints a new view id
(`connection.ts:211`), and the bytes are already the device's. The listener's 60 s socket timeout (`gateway.ts:551`) ends
a download the browser has paused that long; there is no resume (Range is ignored).

### 3.2 A plain browser

The browser's own UI shows progress (a percentage for a file, bytes for a zip), cancels, and puts the file where it puts
downloads (Downloads, the Files app on iOS). `downloads.failed {requestId, reason}` to that view only becomes an in-page
notice, since the browser's list says only "Failed".

### 3.3 The desktop's remote window

The window runs the server's web client, so §2 is unchanged; the change is the partition's `will-download`
(`electron-remote-window.ts`, today `preventDefault` for everything). The page is an untrusted site (a compromised server
runs its own client and can skip all of §2), so every gate is the desktop's, decided in `remote-windows.ts` (testable):
- **Origin.** The item's URL is the window's current server origin with a `/d/` path, `getURLChain()` one entry, the
  `webContents` a remote window of that server; anything else (`blob:`, `data:`, a streamed page's own) cancelled as now.
- **A person's click.** A pointer click in that window within `DOWNLOAD_CLICK_MS` (5 s, Chromium's activation span, so
  the shell's own check of §2.1 and this one agree), recorded by the existing `hooks.input('click')` in its own field
  (keys never set it) and consumed per download. Past it the item is cancelled and a native notice says "not saved: click
  Download again"; the shell's "ready — Download" notice is that fresh click after a slow walk.
- **One at a time and a budget.** One active download per server; at most 3 per 10 s per server (a `Budget` like
  `MAX_PAGE_ACTIONS`); a further one cancelled.
- **A byte cap.** `DESKTOP_DOWNLOAD_MAX_BYTES` 4 GiB from `item.getTotalBytes()` (cancel at once when declared over) and
  `getReceivedBytes()` on each `updated` (a zip is chunked, a file has no server cap): cancel and delete the partial.
- **The name**, sanitised on the desktop from `item.getFilename()`, never trusted from the page: basename, leading dots
  dropped (no `.zshrc`), control and bidi characters dropped, `/ \ :` replaced, cut as in §3.1 with the extension kept,
  empty becomes `download`.
- **Saving.** `setSavePath` must be called inside `will-download` or Electron shows its own dialog, so no clash probe can
  run first: the item saves to a unique hidden temp name in the desktop's Downloads folder (`.cc-download-<16 random
  hex>`); on `completed` main links it exclusively to the final name (`fs.link`, `EEXIST` never overwritten and never
  followed, then `name (1).ext`, up to `(99)`), unlinks the temp, and on any failure, cancel or interrupt deletes it.
- **Never opened.** A native notice with main's own text and path ("Saved report.pdf to Downloads"), whose action is Show
  in Finder / Show in folder (`showItemInFolder` through `electron-shell.ts`); failures and cancels get one too. Progress
  on the dock and taskbar (`setProgressBar`); closing the window cancels its items.
- **Quarantine.** Task 1 checks that a packaged macOS build sets `com.apple.quarantine` on what the item saves; if not,
  names `runnableByName` matches are refused on the Mac. Linux saves with no exec bit.
No `dialog` call anywhere (the `no-direct-dialog` rule holds); desktop-only code (no remote windows in server mode).

### 3.4 The local desktop

A local project's desktop page has no Download: the menu items need `ccPanel.view.remote` (as Reveal needs its absence),
and main refuses a desktop origin. "Save a copy…" was weighed and dropped: a file copy Finder already does. With web
access on, a desktop project's browser views get downloads like a server's (a remote view already has a terminal there).

## 4. Server mode

No native dialog on the server; the only screens are browsers. The hidden page never gets an offer, a start or a token;
a `ccc download` with no browser attached is held (§2.2). The zip runs in main: async `lstat`/`readdir`, deflate on the
thread pool, CRC per 64 KiB chunk, back-pressure through `pipeline`; `scripts/web-terminal-bench.mjs` gets a phase with a
1 GiB zip streaming beside the tabs.

## 5. Errors, progress, cancellation

- **Before a view gets anything** (the plugin's rejection, the CLI's exit 1, the same texts): not found, outside the
  project (plugin) or refused by the outside rule (`ccc`), not a file or folder, unreadable, over a cap (with the counts),
  the desktop case, limits.
- **At the GET**: 204 and `downloads.failed` (§3.1), the token and an accepted offer kept for a retry.
- **While streaming**: a read error cuts a file short of `Content-Length` (failed in the browser); a zip entry that cannot
  be opened now is skipped (the zip stays valid); a zip past a cap or a write error destroys the socket before the last
  chunk (never a truncated zip that looks whole). Each sends `downloads.failed`.
- **Progress**: the browser's own, the dock bar in a remote window. No in-page progress in v1.
- **Cancel**: the browser's closes the socket; `pipeline` destroys the read stream, an `AbortSignal` stops the walk and
  closes every descriptor. Revoke, disconnect, None exit and gateway stop do the same from main (§3.1).

## 6. Security

| Who | Can | Cannot |
|---|---|---|
| Another signed-in device | download what it clicks or accepts; it could `cat` the same file in a terminal (in server mode every device is the owner, §9.6) | use another device's token (cookie-bound), see a Files download started in another view |
| An unsigned network peer | reach `/d/` past the Host check | guess a token (256 bits), learn anything from a refusal (one 204) |
| A foreign page in the person's browser | nothing | read the shell's DOM where a token lives; a leaked token fails `Sec-Fetch-Site` and the cookie |
| A plugin | in a plain browser, start a download of a project file into a view of its window at its budget (forging the origin hint, §2.1) | name a path outside the project, reach another window, start one with no origin view; in a remote window, save without the person's click there, past one at a time and 3 per 10 s, or past 4 GiB |
| A plugin page (sandboxed frame) | ask its host, as above | see a token or the shell's link |
| Claude (prompt-injected, a hostile repo) | offer a project file (`.env` included) or an outside file the rule allows, including a secret it first copied to `/tmp`, to the person's browser views, 10 per 10 min per window | get bytes to anyone but the owner's devices, download without the armed click, offer the home's dot folders, `/proc` or the app's data dir by name, pre-check the include box, hide the full and real path or the warning lines, learn the answer |
| A local process on the server | what the OS user can do anyway | `ccc download` without a tab token |
| A compromised server (remote window) | save files to the desktop's Downloads after the person clicks in its window, one at a time, 3 per 10 s, ≤ 4 GiB each | save without a click, overwrite or follow a link, pick a dot name or a path, open or run what it saved, download from anywhere but its own `/d/` |

The worst cases left: a person who clicks Download on a hostile file a prompt-injected Claude offered (or a secret it
copied out), and a hostile plugin dropping a project file into a browser's downloads; each arrives unopened, under the
name shown. Browsers' own dangerous-type checks and macOS quarantine still apply.

`REMOTE_CLASS`: `downloads.start`, `downloads.offer`, `downloads.settled`, `downloads.failed` are events to browser views
only. `downloads.answer` (Cancel) is `yes`: a view can only decline its own window's offers. `downloads.accept` is
`adapted`: taken only from a remote view of the offer's window (main's `view.remote` and binding, never the payload), and
for a retry only from the accepting device.

## 7. Changes by place

- `src/shared/downloads.ts` (caps, limits, payload shapes, the name rule shared by gateway and remote window),
  `outside-paths.ts` (§1.2); `ipc.ts` (six channels with their `REMOTE_CLASS`); `manifest.ts` (`download` in
  `CORE_CLI_COMMANDS`); `protocol.ts` (`download` in `WINDOW_TOKEN_COMMANDS`; Claude tab tokens reach every command;
  never `TOKENLESS_COMMANDS`).
- `main/files/downloads.ts` (starts, offers, tokens, live streams), `zip-writer.ts`, `folder-walk.ts`;
  `main/verified-read.ts` (`openVerified`); `main/asks/shared-asks.ts` (`hold`); `main/web/auth.ts` (cookie-only device
  lookup); `main/web/gateway.ts` (`/d/`, the revoke and stop hooks); `main/plugins/host-api.ts` (`files.download`);
  `main/socket/handlers.ts` (`download`); `main/remote/remote-windows.ts` and `electron-remote-window.ts` (§3.3).
- `src/sdk/types.ts` (copied to `examples/plugin/sdk/types.ts` and the public example repo), `src/host/ctx/files.ts`;
  guide `cli.md`, `api.md` and the skill rule ("offer an artifact the person asked for once with `ccc download`; it fails
  on a local desktop, where the file is already theirs").
- `scripts/build-editor.mjs` emits `plugins/editor/dist/lib/outside-paths.js`; `files.js` requires it.
- cockpit.files 0.4.0: "Download" on a file, "Download as .zip" and the include item on folders and the project folder, in
  a browser view only (`lib/menu.js`: `remote && env.download`, `env.download` = `typeof ctx.files.download === 'function'`).
- `docs/features.md` (Files panel, Server mode, Remote servers), `docs/design-web.md` §6.1 (a Download row).

## 8. Testing

- **Unit (vitest).** Paths: inside, `..`, links in and out, dangling, a FIFO, the project folder (zip only), a parent
  swapped for a link between start and GET; outside (`ccc` only): `/tmp` allowed; `/proc`, `~/.ssh`, `~/.config/x`,
  `~/Library/Keychains` and `~/library/keychains` on darwin, the data dir (also inside a project) refused;
  `~/.nvm/versions/...` and `~/x/node_modules/.bin` allowed; a `/tmp` link to `~/.ssh` refused; `/` and the home refused
  as zip roots; the plugin API refusing every outside path. `outside-paths`: the editor's cases moved over, the emitted
  file byte-compared. Walk: each skip reason, the include option, `.git` as the root, refused entries of an outside root,
  caps at the start and mid-stream (a file appended while streaming). Zip: a test reader (central directory,
  `inflateRawSync`, CRCs), UTF-8 names, empty file and folder, folder entries stored, mode bits (a setuid file gets
  `0755`), fixed bytes for a fixed tree with fixed mtimes and `TZ=UTC`; `unzip -t` when on PATH. Gateway: a second GET, a
  `Range` GET (whole 200), revoke and disconnect mid-stream, a stalled client past 60 s, a refused GET (204, token and
  offer still live, retry works), another device's cookie, `HEAD`, cross-site `Sec-Fetch-Site`, hostile names (`"`, `\`,
  non-latin1, 300-byte names keeping the extension, `a.exe<pad>.txt`). Offers: `hold` only in server mode, the desktop
  exit 1, `ready` replay, first accept settles all, accept from another window's view or a desktop page refused, retry
  only from the accepting device, the per-window limits. Remote window (`remote-windows.ts`): origin, path, redirect
  chain, foreign window, no click or a stale or reused click cancels, a key does not count, one at a time, the budget,
  the byte cap (declared and received) deleting the partial, `../x`, `.zshrc` and bidi names, a clash to " (1)", a link
  at the final name never followed.
- **Plugins (`npm run test:plugins`).** `menu.test.js`: the Download items only for `remote && download`, the include
  item's rule. `lsp-features.test.js` still passes on the shared rule.
- **E2e.** Web view (`openBrowser`): a Files Download saves the exact bytes with no dialog (Playwright's `download`
  event); "Download as .zip" extracts to the tree without `.git`, the include item with it. `ccc download` from a Claude
  tab (fake `claude`): the dialog in two browser views with the full path, inert for the first second, Cancel in one
  closes both and nothing downloads; a second offer downloads in the accepting view only; an outside `/tmp` file marked
  outside; `~/.ssh/x` exits 1. The desktop page has no Download item. Server mode (`launchServer`): a Files download, and
  a held offer shown when a browser connects. Remote window (data dir's Downloads redirected by a test hook): a click on
  Download saves to it with the notice and no native dialog ever; a page-driven `/d/` GET with no click saves nothing;
  a `blob:` download is cancelled. On macOS by hand: the zip through Archive Utility and `ditto -x -k`, quarantine set.

## 9. Not in this version

Upload from the device; outside paths from the Files panel or any plugin; several files at once; resumable or ranged
downloads; `tar.gz`; `.gitignore`-aware zips and other include choices; in-page progress; a plugin offering bytes it made
(`ctx.files.offerBytes`, later); downloads started by a streamed webview page or a URL overlay (still cancelled); sharing
a download link with another person (guest access is its own design); telling Claude the answer; `ccc download --project`
from a server shell; "Save a copy…" on the desktop; choosing the remote window's save folder.

No open questions are left: the owner answered the first draft's four and the remote window's save dialog (above).

## 10. As built (deviations from the text above)

- The remote window's save is in `main/remote/remote-downloads.ts` (temp name, 4 GiB cap, exclusive link, cleanup, a sweep
  of day-old `.cc-download-*` temps before the first save); the gates stay in `remote-windows.ts`. A test run saves to
  `<data>/Downloads`, never the real folder. Refusals past the origin gate show at most 3 native notices per 10 s per
  server, the rest are only logged; origin refusals are log-only. No copy fallback when `fs.link` fails: the download
  fails with a notice.
- A folder's walk skip reason `deep` (past depth 64) was added. Folder caps are enforced again while streaming, with no
  second walk at the GET.
- One GET per download was seen in Chromium (Task 1), so no second-GET grace exists; Electron has no Chrome download
  throttling. Firefox and iOS Safari are still to verify by hand.
- The token is consumed in the same synchronous step as the 200 head. In None mode the token alone authorizes, in a
  signed-in mode the cookie of the token's device too.
- `ccc download` is refused before connecting when it has no token (exit 2); a plugin declaring a CLI named `download`
  fails manifest validation (reserved) rather than being demoted.
