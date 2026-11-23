# Uploads from the person's device — design

Status: designed (2026-11-22, with the owner, section by section; revision 2 after a review pass, its eleven fixes applied); implemented (2026-11-23, plan `docs/plans/completed/20261122-upload.md`; §13 lists where the build differs). The reverse of
`docs/design-download.md`, which it reuses where the same rule fits and departs from where it does not (§3, §10). Extends
`docs/design-web.md` (web access, §9 server mode), `docs/design-remote-desktop.md` (remote windows) and
`docs/design-guests.md`; read `design-download.md` first.

**Problem.** With web access, in server mode and in a remote window, the project's files are on the server. The person
has a file on the device in front of them (a screenshot, a PDF, a data file, a `.env`) and no way to put it there:
`design-download.md` §9 and `docs/features.md` list "no upload" in three places. Claude Code's image paste reads the
clipboard of the machine `claude` runs on, so a screenshot cannot reach a remote session at all.

Decisions taken with the owner:
- **Entry points: both.** The Files panel (a menu item on a folder, a drop from Finder onto a folder) and a terminal tab
  (a drop or a paste of files), the latter ending with the uploaded path pasted into the prompt.
- **Name clash: ask.** Replace, Keep both (`name (1).ext`) or Cancel; nothing is written before the answer.
- **Terminal target: "Into the folder I pick".** A terminal drop opens a folder chooser for the project's folders; no
  scratch folder.
- **Local desktop: remote only**, as Download. The local desktop page gets no drop handling at all.
- **Contents: several files, no folders.** 2 GiB per file, the server's free disk checked first.
- **Approach A: one core flow.** The Files panel page and the terminal both hand `File` objects to the shell, which asks
  main over its own socket; main checks view, role and folder and mints per-file tokens; chunked `fetch` PUTs (adaptive size) to
  `/u/<token>`; core's own dialogs and progress. Rejected: B, a host-started `ctx.files.upload(folder)` mirroring
  `ctx.files.download` (the picker would hang on activation surviving host → main → socket → shell, a drop needs two
  legs joined by a request id, and the terminal needs its own start anyway); C, the desktop's remote window reading and
  sending local files itself (a second transport for one feature).
- **Guests: the owner and write guests.** Read guests never (`design-guests.md` §6 already lists upload among what read
  guests lack; D-23 lets write guests download).

## 1. Scope and entry points

**Where:** remote views only: a plain browser (web access, server mode) and the desktop's remote window, which runs the
same web client. A desktop-hosted project's browser views get it too (as downloads, `design-download.md` §3.4). The
local desktop page and server mode's hidden page never do (neither is `view.remote`).

**Who:** the owner and write guests. A read guest's view gets no menu item and no drop target, and main refuses it by role
whatever the page sends.

**Entry points:**
1. **Files panel, "Upload here…"** on a folder row and the project folder: the page opens a hidden
   `<input type=file multiple>` inside the menu click (`ccPanel.upload.pick({ folder })`).
2. **Files panel, a drop** from Finder onto a folder row, or onto a file row (its folder), or the empty area below the rows
   (the project folder); rows highlight while a drag carrying files is over them (`ccPanel.upload.files(list, { folder })`).
3. **A terminal tab (Claude or shell), a drop or a paste of files** (a paste counts only when the clipboard holds files, a
   screenshot copied with Ctrl+Cmd+Shift+4; a text paste is unchanged). Core opens its folder chooser, preset to the folder
   this device last used for this project, else the project folder; after the upload the paths are pasted into that tab
   (§4).

All three then share `uploads.begin` with the names and sizes, core's clash dialog when a name exists, core's progress
notice with Cancel, and a result notice (§5).

## 2. Main's rules

`main/files/uploads.ts` (no Electron; gateway, views and tabs through hooks), beside `downloads.ts`.

### 2.1 The folder

Named by the page, project-relative (`''` the project folder). Resolved by `resolveProjectEntry` (`system-files.ts`:
lexical check, then the real path inside the project) and must be a folder. Refused: outside the project (no outside
rule: uploads never leave it); `.git` and every folder below it, at any depth (a file in `.git/hooks` or `.git/config`
runs code on the next git command, and a page can build a `File` that nobody picked, §6); the app's data dir when it lies
inside the project (as downloads). The `.git` check runs on the named path and on its real path (a `hooks-link` to
`.git/hooks` is refused by its target), and on darwin it compares case-insensitively (APFS is: `.GIT/hooks` names the same
folder), as the outside rule does for `Library/Keychains` (`design-download.md` §1.2). A file named `.git` (`.GIT` too
on darwin) is refused the same way (§2.2): in a folder with no `.git` it would be a gitfile, `gitdir: <path>`, sending
every git command there and below to a gitdir the uploader names. The rule goes by name only: a gitdir under another
name (`git init --separate-git-dir=gitdata`, a bare repo or fixture repo in the project) is an ordinary folder to it.

### 2.2 Names

From each `File`, checked by main, never trusted from the page:
- Files' `checkName` rules (`plugins/files/dist/lib/ops.js`): one segment, not empty, not `.` or `..`, no `/`, `\` or
  NUL, at most 255 bytes of UTF-8; plus no control, bidi or invisible format characters (`HIDDEN_TEXT`, so the tag
  characters cannot hide text Claude reads) and no lone surrogates (the name lands in a terminal paste and in notices). A
  numbered name (dedupe, Keep both) that would pass 255 bytes is never used: that file is refused with a reason. A
  refused name skips that file, with its reason in the result; main never renames it quietly.
- Dot names are allowed (`.env` is a fair upload; Files' New file allows them too), but not `.git` (§2.1).
- A null from the numbering says why: "too long to number" when ` (99)` would pass 255 bytes, else "no free name".
- A file from a **clipboard paste** (`pasted: true`) is named `pasted-YYYYMMDD-HHMMSS.<ext>` from the device's clock and
  the `File`'s type (`png`, `jpg`, `gif`, `webp`, `pdf`, else `bin`): browsers call every clipboard image `image.png`, so
  the original name would clash on every paste.
- Two files of one upload with the same name (compared case-insensitively) get " (1)" and up without asking.

### 2.3 Clashes

At begin main `lstat`s each target name (which also finds `Readme.md` for `README.md` on a case-insensitive macOS
server). Any clash brings core's dialog with every clashing name (§5.3, an `ApprovalDialog`: a panel page can start an
upload with a `File` it built and time it against a click, so Replace must not take a click aimed at something else):
**Replace** (offered only when every clashing entry
is a regular file; a folder or a link at the name allows Keep both only), **Keep both** (`name (1).ext` up to `(99)`, the
extension kept), **Cancel** (nothing written). One answer covers the whole upload.

### 2.4 Writing

- Each file streams into a temp **in its target folder**, `.cc-upload-<16 random hex>`, opened
  `O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY`, mode `0644` under the umask: the same folder because a link or a rename
  cannot cross filesystems, and a project may span mounts.
- **Commit** (after the last byte): the folder is resolved again and must be the real path resolved at begin; the temp's
  `lstat` must match the descriptor's `fstat` (dev, ino), so the file committed is the one written.
  - *A new name, or Keep both:* `fs.link(temp, final)`, exclusive (`EEXIST` is never overwritten and never followed: the
    next number, so a name that appeared since begin is numbered too), then unlink the temp. On a filesystem with no hard
    links (`EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`, `EXDEV`), `copyFile(temp, final, COPYFILE_EXCL)` instead, then
    unlink (the download save's fallback).
  - *Replace:* the target must still be a regular file (`lstat`; a folder or a link that appeared since fails that file,
    "it changed meanwhile"). The temp takes the replaced file's permission bits minus setuid, setgid and sticky (a
    replaced script keeps its exec bit), then `rename(temp, final)`: atomic, and it replaces the entry, never following a
    link.
  - A new file never gets an exec bit (a `File` carries no mode). The mtime is the write's own.
- **Temps record.** Main records each live temp's path, with its project folder, in `<data>/uploads/temps.json` before
  it creates it and drops it at commit or deletion. At start, main deletes every temp listed (none can be live after a
  restart): only a regular file named as a temp whose folder's real path is inside its recorded project folder. An entry
  it could not reach (the project folder missing, a volume not mounted yet, an lstat or unlink refused) stays for the next
  start; the rest of the record is emptied. The start waits for the sweep at most 5 s (a stale temp under an unreachable
  network share must not hold the gateway); a late finish keeps the entries live by then. Every abort (§3.4) deletes its temp at once. The Files tree hides
  `.cc-upload-*` (§5.1).

### 2.5 Caps and limits

`src/shared/uploads.ts`:
- `UPLOAD_MAX_FILE_BYTES` 2 GiB per file (the declared `size`; bytes past it are refused, §3.2), `UPLOAD_MAX_FILES` 100 per
  upload.
- Free disk: at begin `fs.statfs(folder)` must leave the whole upload plus 1 GiB free, less the declared sizes of the
  running uploads' files not yet settled (counted as written, so 6 at once cannot each pass against the same free space),
  and again at `resolve` (an answer may come 10 min later); `ENOSPC` while writing fails that file (temp deleted, "the
  server's disk is full").
- 2 uploads at once per device, 6 app-wide; 20 begins per 10 min per device (a `RateWindow`; a begin refused because the
  device or the app is full gives its begin back).
- **None mode** has no signed-in device: as `downloads.ts` does, every None-mode view is the device `none`, so these limits,
  `uploadId` ownership (§3.1) and the token's device (§3.2) key on `none` there (every None-mode view is the owner), and
  leaving None mode ends the `none` device's uploads (§3.4).

## 3. Transport

### 3.1 Channels

On the view's own socket. Each is `adapted`: served only to a remote view (`view.remote`) that is the owner or a write
guest, decided by main from the connection it bound, never the payload.

- **`uploads.begin {source, folder, files: [{name, size, pasted?}]}`.** `source` is `{panel: key}` (a panel in that
  project's layout now: main resolves it through `LayoutService`'s zones, any panel kind, the plugin through
  `pluginOfPanelKey`; `webviewPanel` alone knows webview panels only and Files is an html panel; for a guest the plugin
  must be visible to it) or `{tab: id}` (a Claude or shell tab of the view's window, in a guest's scope). Answers
  `{uploadId, refused: [{index, reason}], clashes: [{index, name, replaceable}]}`, and the per-file tokens when nothing
  clashes; or a refusal of the whole upload (folder, role, caps, disk, limits).
- **`uploads.resolve {uploadId, choice}`** (`replace` | `keep-both` | `cancel`): the tokens, or nothing for `cancel`.
- **`uploads.cancel {uploadId}`**: aborts it and deletes its temps.
- **`uploads.paste {uploadId, manual?}`**: the terminal entry's paste (§4.3). Answers `{text}` or `{held: reason, text}`
  (the text also feeds the held notice's paths and its Copy).
- **`uploads.folders {tab, path}`**: the folder chooser's listing (§4.2). It names the terminal tab the drop or paste
  landed on, checked as `uploads.begin`'s `{tab}` (a Claude or shell tab of the view's window, in a guest's scope): a write
  guest whose scope holds no tab cannot list the project's folders through it.

An `uploadId` answers only to the device that began it (another device's, or an unknown one, gets the same answer).

### 3.2 The route

`PUT /u/<token>?offset=<n>` on the gateway, after the Host check. Every check runs before a byte is written:
1. `PUT` only (the rest 405). The gateway answers 405 to every method but GET, HEAD and POST before any route
   (`gateway.ts:853`), so PUT is admitted there for `/u/` alone. The Origin check (a state-changing request), and
   `Sec-Fetch-Site`, when sent, must be `same-origin`. The route sits after `deviceOf` and before the guest block that
   answers every other guest route 404 (`gateway.ts:906-913`): a write guest's PUT must reach it, and the route reads the
   role itself (3).
2. The full cookie-and-key check (`authorize`): unlike `/d/`, which is a navigation, the shell sends the request with
   `keyedFetch` (`src/renderer/web/device-key.ts`), so the device key comes as `DEVICE_KEY_HEADER`. In None mode the token
   alone.
3. The token: 32 random bytes base64url, in main's memory only, bound to the device, window, upload, file index, the
   folder's real path, the planned name and choice, and the declared size; the device must be the request's. A guest's
   access is read live (`GuestStore.access`) on every chunk: a role changed to read, a kick or a revoke ends the upload.
4. `Content-Length` required (no chunked bodies), 1 byte to `UPLOAD_CHUNK_MAX_BYTES` (8 MiB); `offset` must equal the bytes
   written so far (no gaps, no overlap) and `offset + length` must not pass the declared size. A file declared empty
   (`.gitkeep`, `__init__.py`) takes exactly one `Content-Length: 0` PUT at offset 0, which commits it.

The body is written to the temp as it arrives (`fs.write` at its position, back-pressure by pausing the request). A body
that ends short is truncated back to `offset` (`ftruncate`) and the token stays live for a retry from there. Each chunk
answers `200 {received}`; the last one commits (§2.4) and answers `{done: true, name, path}` (`path` project-relative).
Refusals answer a JSON `{error}`: 400 (shape, or a body that ended short), 409 with `expected` (offset), 413 (over a cap),
507 (disk full), 500 (the temp, the record or the commit failed). A guest with no right to the token gets the guest block's
404, the same status, headers and plain-text body as a route that does not exist (D-26): a read guest whatever it sends,
a method other than PUT, and a token unknown, another device's or ended. So such a guest cannot tell a live token from a
guess; like the guest block's, that 404 keeps the connection and Node reads
the body off under the request bound. A write guest holding its own live token gets the owner's answers above (400, 409
with `expected`, 413, 507, 500): without the 409 a Chromium resend (§3.3) would end its file. Its own token once ended
gets the plain-text 404 too, so the client goes by the status, never the body. Every answer after the writer's goes once
the rest of the body is read off (at most 8 MiB, under the request bound): a write failing mid-body (ENOSPC) stops
writing but leaves the body unread, never destroyed, since an answer sent while the client is still sending is lost to
the reset when the connection closes on unread bytes, and the client would see a network error, then a 404 on its retry,
with the reason gone (§3.3). The 204-only rule of `/d/` does not apply: a `fetch` is not a
navigation, so a body cannot replace the page. Headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
One line per file in `web-access.log`: device, display-safe name, bytes, completed or cut (the route sees chunks only, so
a file whose upload ends with no chunk in flight, by the idle clock, a cancel or a window closing between chunks, has no
line).

### 3.3 The client

The web shell's upload client (`src/renderer/web/upload-client.ts`): files one at a time, chunks one at a time, each a
`fetch` PUT through `keyedFetch` with the body `file.slice(o, o + chunk)` and an `AbortController` (Cancel aborts it and
posts `uploads.cancel`). A failed chunk (a network error, a proxy's 502-504, a 408 cut, the writer's 400 with `expected`
for a body that ended short) is retried 3 times, after 1, 5 and 20 s: an offline browser rejects a fetch at once, so those
26 s are the whole budget for a reconnect, kept well under the upload's 60 s idle clock (§3.4). A 409 resumes at
`expected` when it lies ahead of the acknowledged offset and short of the size; any other 409 ends the file. A file whose
network retries run out ends as "connection lost"; when its slice can no longer be read (a `File` changed or removed
since it was picked, which Chromium rejects like a link failure) it ends as unreadable at once, with no retries. The next
file gets one attempt with no retries, and when that too fails on the network the rest of the run fails untried (a dead
link would otherwise spend the backoff on up to 100 files). Each chunk has a 45 s client deadline past the gateway's cut
(counted as a cut); the last chunk's grows with the file's size (4 MiB/s), since its answer waits for the commit, a
whole copy on a mount with no hard links. Progress counts acknowledged bytes. A network error or a 408 on a chunk followed by a 404 on its retry may be a file the server failed
whose answer a link dropped (§3.2): the file ends as failed with a generic reason, never retried past the 404 and never
shown as completed; a 404 is told by its status, never its body.

**Chunk size adapts.** The gateway's listener bounds a whole request, body included, at 30 s
(`server.requestTimeout = REQUEST_TIMEOUT_MS`, `gateway.ts:125,665`, server-wide), so a fixed 8 MiB chunk would die and
restart forever below about 2.2 Mbit/s. The client starts at 1 MiB and aims at about 5 s a chunk: it doubles after a chunk
under 2.5 s and halves after one over 10 s or one cut by the bound, between `UPLOAD_CHUNK_MIN_BYTES` (256 KiB, about
70 kbit/s inside the bound) and `UPLOAD_CHUNK_MAX_BYTES` (8 MiB). The bound stays as it is for every other route.
Node checks the bound every `connectionsCheckingInterval` (default 30 s, so a cut fell at 30-60 s in the spike); the
gateway passes 5 s (`CONNECTIONS_CHECKING_MS`), so a cut falls at 30-35 s. A cut chunk is answered **408** (the
gateway's `clientError` listener, as Node answers it with none), never the writer's 400 for a body that ended short, and
Chromium may resend the request once before the client sees it; the offset check absorbs the duplicate.

Never `XMLHttpRequest`, and never the `File` itself as a body: in the spike (§11) an XHR PUT of a `File` posted from the
panel frame failed for some files (the same file every time within a run, another file in the next run), while an XHR of
its `slice()` and every `fetch` succeeded. `fetch` with slices is also what chunking needs; it has no upload progress,
which the chunks give.

### 3.4 What ends a token

The commit; a cancel; 60 s with no bytes received for the **upload** (one clock per upload, not per token, and reset by
each body chunk read off the socket, not by a finished PUT: the tokens of a 100-file upload are minted together and used
one after another, and a slow link may send a chunk for most of the 30 s request bound); the device's revoke or
disconnect; a guest's end (through `GuestStore`'s one path: a `dropUploads` dep beside its `dropDownloads`, also called on
a downgrade to read, and any other narrowing of the guest's access: a tab unshared, a narrower scope, or a plugin switched on or off
in the project, whose direction `pluginAccessChanged` does not know, so an unrelated plugin's switch also ends a running
upload, an accepted cost: the client begins again); leaving None mode; gateway stop; the window or the project closing. Each aborts the live request and deletes the
temp. A cancel of a running upload some of whose files have already settled (committed or failed) finishes the upload
instead of removing it: its live tokens end and their files settle as cancelled, and the record keeps every outcome, so
a partial result still pastes (§4.3, §5.3). The shell sends that cancel itself when its client gave up on files (a lost
link, a file no longer readable), and sends it before the paste, which needs a finished upload. A reconnect on its own does not end it (the token is bound to the device, not to the view id, which a reconnect replaces), so a
phone that slept for a few seconds resumes at `expected`.

### 3.5 The remote window

It runs the same client; the desktop adds no gate: the page can only ever hold what the person picked or dropped into its
window (a compromised server receives those files and nothing else), and Chromium opens a file chooser only under a
person's activation. The remote window's hardening does not cancel file choosers (only off-screen views do,
`webview-hardening.ts`), so the native dialog opens there. The e2e (Playwright's `filechooser` on the remote window) shows
the chooser is not cancelled; the native dialog itself, and the PUT through the built-in SSH tunnel and the window's
loopback-request block, are checked by hand after the build.

### 3.6 A drop nobody handles

In a plain browser a file dropped where no handler takes it opens in the tab, which replaces the shell and kills its running
uploads. So the shell cancels every `Files` drag by default (`dragover` and `drop` on its window, `preventDefault`; the
terminal and the Files rows then take theirs), and the panel SDK does the same in every panel frame, so a near miss on a
panel's padding does nothing. In the remote window an unhandled drop would navigate to `file://`, which its navigation rule
refuses anyway; Task 1 checks the default cancel in Electron's Chromium, the remote window is checked by hand.

## 4. The terminal entry

### 4.1 Catching it

In the web shell, on the terminal's container:
- **Drop:** a drag whose `dataTransfer.types` includes `Files` over a Claude or shell tab highlights the pane; the drop
  counts as a click on that pane (it selects it), and `preventDefault` keeps the browser from opening the file. Plugin
  command tabs, page tabs and a read guest's view take no drops.
- **Paste:** in the capture phase, before xterm: the paste becomes an upload (`pasted: true` for each file) only when
  `clipboardData.files` is not empty **and** the clipboard holds no `text/plain`. A copy from Excel, Word or a browser's
  Copy image carries text and an image together, and there the text is what the person meant, so any paste with text
  stays a text paste, unchanged. A screenshot copied with Ctrl+Cmd+Shift+4 has no text. Task 1 records what each of those
  clipboards holds in Chrome, Safari and Firefox.

### 4.2 The folder chooser

`UploadDialog` (core, `src/renderer/notices/`): "Upload 2 files (3.1 MB) to" above a tree of the project's folders, the
files listed with their sizes, Upload and Cancel. The tree comes from `uploads.folders {tab, path}` (§3.1): subfolders only, names only,
500 per folder, sorted, `.git` and the data dir left out (`GUEST_CLASS` `write`). The preset is the folder this device last
used for this project (`localStorage` per project id, inside `try`/`catch`), else the project folder. An ordinary dialog,
not an `ApprovalDialog`: only the person's own drop or paste opens it and nothing it does is risky; Enter uploads, Esc
cancels. Then `uploads.begin`, the clash dialog when needed, the progress notice.

### 4.3 The paste

After the last file committed, the shell calls `uploads.paste {uploadId}`: only for an upload whose `source` was that tab,
begun by this device, finished. Main types nothing itself: it answers `{text}` or `{held: reason, text}`, and on `{text}`
the shell pastes it with xterm's own `paste` in that view, so the program's bracketed-paste mode holds, the text goes
through the person's own input path (`TabManager.viewInput`: the tab becomes `typed`; it was the person's drop), and no
Enter is ever sent.

**Pasted at once** (the automatic call, at most once per upload) only when all hold:
- *checked by main:* the tab is alive; it is the view's selected tab (`ViewSelections.selectionOf`); for a Claude tab, its
  status is `waiting` (the send gate's "at the prompt": `idle` is not established relative to the prompt,
  `status-reducer.ts`; `working` lags a dialog). A shell tab needs only the first two.
- *checked by the shell, before it calls:* the view is not keys-off for that pane. Keys-off lives only in the renderer
  (`state/tabs-store.ts`); this check is the person's own view guarding its own terminal, not a boundary (a view that lied
  would type into a terminal it can type into anyway), so no channel reports it to main.

**Otherwise held:** the result notice keeps the paths as text with **Paste path** and **Copy** (Copy uses `text`, which the
held answer carries). Paste path is the person's click at that moment, as typing would be: `uploads.paste {uploadId,
manual: true}`, any number of times while the notice lives, in any status but `needs-permission` and `ended`; main checks
again, the shell checks keys-off again.

**The text:** absolute paths for the owner; for a guest (D-33: guest-visible text never carries a host path) the path
relative to the tab's starting folder (main's tab record), `./name` or `../other/name`, so it is right whatever folder of
the project the tab began in. Escaped with a backslash: ASCII space and the ASCII characters a shell gives meaning
to (`` \ ' " ` $ & * ( ) [ ] { } ; | < > ? ! # ~ ``), as Terminal.app and iTerm quote a dropped file; every other character,
non-ASCII letters and spaces included (a macOS screenshot name's U+202F), is kept as it is (a Cyrillic screenshot name
stays readable, and an escape inside it could defeat Claude Code's image detection). The file name was checked (§2.2),
but the project root and the folders were not: a path with a control, bidi or invisible format character or a lone
surrogate anywhere in it is never pasted (a tab is one; xterm's `paste` keeps an ESC, so an `ESC [201~` in a folder
name would end the bracketed paste early), it is held with that reason, and the shell offers no Copy for such text (the
person's own Cmd+V would deliver it through xterm's paste just the same): only Paste path, which main refuses again. Paths separated by a space, one trailing space.

Whether Claude Code attaches an image from both forms is checked by hand after the build (Post-Completion), not before it:
the escaping follows what Terminal.app and iTerm already paste for a drop, which Claude Code attaches in a local terminal,
and where it does not attach, the path is still text Claude can open with its Read tool, which reads images.

## 5. UI

### 5.1 The Files panel

cockpit.files, a minor version:
- `dist/lib/menu.js`: an `upload` item ("Upload here…") on `dir` and `root` when `remote && upload && access !== 'read'`;
  `upload` is `typeof ccPanel.upload?.pick === 'function'` (an older app shows no item). `menu.test.js` covers it.
- `panels/tree.js`: the item calls `ccPanel.upload.pick({ folder })` in the click; rows take a drag only when
  `dataTransfer.types` includes `Files` (a folder row highlights itself, a file row its folder, the empty area the project
  folder) and the drop calls `ccPanel.upload.files(event.dataTransfer, { folder })` inside the `drop` handler.
- `dist/lib/tree.js`: `.cc-upload-*` hidden. The watcher shows the new files once they commit.

### 5.2 The panel SDK

`src/sdk/panel.ts`, `panel-core.ts`, `src/sdk/types.ts` (copied to `examples/plugin/sdk/types.ts` and the public example
repo), and the guide's panel section in the same change:
- `ccPanel.upload` exists only in the web shell and only for views that are not read guests (a UI hint, as
  `ccPanel.view.remote`; main decides).
- `pick({ folder })`: call inside a click or key handler; makes a hidden input, clicks it, posts the chosen files.
- `files(source, { folder })`: `source` is a drop's `DataTransfer` (or a `FileList` / `File[]`). With a `DataTransfer`
  it must be called inside the `drop` event: `webkitGetAsEntry()` lives on `dataTransfer.items` only during the event, so
  the SDK tells folders from files there, in the frame, and posts the files plus the skipped folders' names (a `FileList`
  alone cannot tell a folder from a file).
- Every panel frame cancels a `Files` drag it does not handle (§3.6).
- Both return nothing: core shows the outcome.
- The message, to the parent only: `{ type: 'cc-plugin.upload', folder, files }`. The shell accepts it only from a
  **panel frame** it mounted (`PluginFrame` in a zone) and names that panel's key in `uploads.begin`; html overlays (which
  Claude can author), slots and page tabs are ignored, with a test.

### 5.3 Core dialogs and notices

`src/renderer/notices/`, in `ShellNotices`; only the uploading view gets them (the owner's other views see the files
appear through the Files watcher):
- **Folder chooser:** §4.2.
- **Clash dialog:** an `ApprovalDialog` (no default button, Enter and Space blocked, armed after about a second visible:
  a panel page can raise it with a `File` it built and time it against a click, §2.3). "2 files already exist in
  src/assets: logo.png, README.md" with Replace, Keep both and Cancel; Esc cancels; Replace off with the reason when a
  clash is a folder or a link ("icons is a folder").
- **Progress:** one notice per upload, "Uploading 2 of 3 to src/assets: 42 MB of 120 MB", a bar and Cancel.
- **Result:** "Uploaded 3 files to src/assets" (up to 3 names), hidden after 6 s; a partial result or a held paste stays
  until dismissed ("Uploaded 2 of 3; not uploaded: x.bin (the server's disk is full)"); a refusal at begin "Nothing
  uploaded: <reason>".
- **Folders in a drop:** told by `webkitGetAsEntry().isDirectory` during the `drop` event (the shell for a terminal, the
  SDK in the frame for a panel), skipped and named in the result ("folders can't be uploaded: photos"); the drop's files
  still upload.

**Leaving the page** (close, reload) cancels its uploads, with no `beforeunload` prompt: in the remote window a prevented
unload would silently block closing the window. The 60 s expiry (§3.4) deletes the temps.

## 6. Security

| Who | Can | Cannot |
|---|---|---|
| The owner's signed-in device | upload into any project folder but `.git` and the data dir; replace after the ask | write outside the project or into `.git`, follow a link at the target, pass the caps |
| A write guest | the same, in the shared project; answers carry project-relative paths only | the above; see a host path |
| A read guest | nothing | get an item or a drop target, pass main's role check, get anything but 404 at `/u/` |
| An unsigned network peer | reach `/u/` past the Host check | pass the Origin, cookie and key checks; guess a token (256 bits) |
| A foreign page in the person's browser | nothing | a cross-site PUT (Origin, `Sec-Fetch-Site` and the cookie fail); read the device key |
| A plugin panel page | upload bytes it built itself into a folder its view may write, with core's ask on any clash: **a `File` is no proof of a pick**. No new power: its host already writes project files with `fs` (`ops.js`) | write outside the project or into `.git`, replace without the person's Replace (the clash dialog is armed, so a click timed against it does not count), start from an overlay, slot or page tab, act in a read guest's view |
| A Claude-made html overlay | nothing: the shell ignores its message | — |
| Claude (prompt-injected) | nothing new: there is no `ccc upload`; the paste goes only into the tab the person dropped on, as text, never Enter | type into a permission dialog (the automatic paste needs `waiting`) |
| A compromised server (remote window) | receive what the person picks or drops into its window | read any other local file, open a picker without the person's activation |

Disk fill is bounded by §2.5. The worst case left: a person who drops the wrong file, or Replaces a file they wanted; the
clash dialog names every file it would replace.

**Classes.** `REMOTE_CLASS` `adapted` for `uploads.begin`, `resolve`, `cancel`, `paste` and `folders` (main's
`view.remote` and binding). `GUEST_CLASS` `write`, with target extractors for the panel key and the tab id (they take
`unknown` and fail closed); an `uploadId` must belong to the caller's device. No new events: every answer is an invoke
reply, so no `GUEST_EVENT` rows. `/u/` reads a guest's role live per chunk (§3.2).

## 7. Server mode

No native UI on the server; the only screens are browsers. The hidden page never begins an upload (not `view.remote`).
Writes run in main: async descriptor writes, back-pressure on the request, no buffering past one chunk;
`scripts/web-terminal-bench.mjs` gets a phase with a 1 GiB upload beside the tabs.

## 8. Changes by place

- `src/shared/uploads.ts` (caps, limits, payload shapes, the name rule, the pasted-name rule, the paste escape);
  `ipc.ts` (five channels with their `REMOTE_CLASS`); `shared/guest-class.ts` (rows and extractors).
- `main/files/uploads.ts` (begin, resolve, tokens, writes, commit, the temps record, the paste rule, the folder listing);
  `main/web/gateway.ts` (`/u/`, the teardown hooks beside the download streams'); the router's handlers; `main/index.ts`
  (the temps sweep at start, the wiring).
- `src/renderer/web/upload-client.ts`; the terminal drop and paste (`tabs/terminal-session.ts` or a new
  `tabs/terminal-drop.ts`); `renderer/notices/UploadDialog.tsx`, the clash dialog, the progress and result notices;
  `plugins/PluginFrame.tsx` (the `cc-plugin.upload` message from panel frames only).
- `src/sdk/panel.ts`, `panel-core.ts`, `src/sdk/types.ts` (and the example copies); guide `api.md` (panel SDK).
- cockpit.files: `dist/lib/menu.js`, `panels/tree.js`, `dist/lib/tree.js`, the version.
- `docs/features.md` (Files panel, Web access, Server mode and Remote servers limitations), `docs/design-download.md` §9
  (a pointer here), `docs/design-guests.md` (write guests upload), `docs/design-web.md` §6.1 (an Upload row).

## 9. Testing

- **Unit (vitest).** Folders: inside, `..`, a link out, `.git` and below, a link to `.git/hooks`, `.GIT/hooks` on darwin,
  the data dir. An empty file commits on one zero-length PUT; a 100-file upload whose later files wait past 60 s still
  completes, and a slow chunk that keeps sending is not expired. Names: each refusal, dot names
  allowed, the pasted name, duplicates within one upload. Clashes: case-insensitive on darwin; Replace only over a regular
  file, keeping its mode minus setuid; a link at the final name never followed; a name that appeared since begin numbered;
  a folder swapped for a link between begin and commit. Writing: the no-hard-link fallback, the temps record and the sweep
  at start. Caps and limits (size, count, `statfs`, `ENOSPC` through a fake).
- **Gateway.** Method; Origin; `Sec-Fetch-Site`; the cookie and key; another device's token; a read guest's 404 and a role
  change mid-upload; `Content-Length` missing, over 8 MiB, past the size; an offset mismatch (409 with `expected`); a short
  body truncated and retried; the 60 s expiry and every teardown of §3.4 deleting the temp mid-chunk; a reconnect
  resuming.
- **Paste rule.** Each status, keys-off, another tab selected, an ended tab, a guest's relative text from a tab begun in a
  subfolder, the escape table (non-ASCII kept), a held paste checked again on its button.
- **Shell.** An overlay's (and a slot's) `cc-plugin.upload` uploads nothing; folders in a drop; a paste with text and an
  image stays a text paste; a `Files` drop outside every target does nothing (the page stays); `uploads.folders` refused
  for a tab outside a guest's scope.
- **Plugins (`npm run test:plugins`).** `menu.test.js`: the upload item's rule; the tree hides `.cc-upload-*`.
- **E2e.** A web view (`openBrowser`): Upload here (`setInputFiles`) saves the exact bytes; Replace and Keep both; a
  DevTools drop (`Input.dispatchDragEvent` with real paths) on a folder row; a drop on a fake-`claude` tab in `waiting`
  ends with the path typed (the fake records its input). A read guest has no item and gets 404. Server mode
  (`launchServer`): one upload. A remote window over Direct: one upload.

## 10. Where this departs from downloads

- **Auth:** `/u/` sits behind the full cookie-and-key check; `/d/` cannot (a navigation carries no header).
- **Token:** per file and multi-use (one per chunk, at the right offset), ended by §3.4; `/d/`'s is one-use, 60 s.
- **Progress and cancel:** in-page, required: a browser shows nothing for an upload. Downloads use the browser's own.
- **Errors:** JSON bodies with real statuses; `/d/` answers 204 only.
- **Bound to the device, not the view:** a reconnect resumes; a download stream outlives its view the same way.
- **No remote-window gates:** the desktop gates downloads (it receives untrusted bytes); an upload sends only what the
  person chose.

## 11. Spike (2026-11-22)

Electron 45.1.0 (the repo's), Playwright 1.64.1, a loopback server: a top page (the shell's stand-in) framing a page served
with `Content-Security-Policy: sandbox allow-scripts` and framed `sandbox="allow-scripts"`, as plugin pages are over HTTP
(`plugin-pages.ts`), in a `BrowserWindow` with `sandbox: true` and a persistent partition.
- The frame's origin is `null`, the top page cannot reach its document, and it runs in its own process (top pid 4, frame
  pid 5): the same setup in which the remote window's downloads first failed.
- `<input type=file multiple>` in the frame opens the chooser from a click in the frame (Playwright's `filechooser`).
- A drop of real paths through `Input.dispatchDragEvent` over the frame delivers disk-backed `File`s to its `drop`.
- Posted to the parent, they arrive as `File`s (name, size, type, readable), with `event.source` the frame's window.
- Uploading them from the parent: `fetch` PUT with the `File` as the body succeeded every time (18 B, 8 MiB); `fetch` PUTs
  of 1 MiB slices succeeded every time; XHR PUT with the posted `File` failed for some files with no progress event (the
  same file every run's repeat, a different one across runs), XHR of `file.slice(0, size)` succeeded every time. A file
  picked in the top page itself uploaded by XHR as well. Hence §3.3.

**Task 1 (before the transport is built), where a driver reaches:** folder detection in a DevTools drop; an unhandled drop
and the default cancel; what Chromium's `paste` holds for an image alone and an image with text; Firefox and WebKit through
Playwright when installed; the XHR failure's cause, if cheap to find (the design avoids XHR either way). **By hand after the
build (the plan's Post-Completion):** Firefox and Safari (iOS included) if Task 1 could not run them; a real Finder drop in
Chrome and in the remote window; the native chooser in the remote window; a PUT over the built-in SSH tunnel; Claude Code
attaching an image from an absolute escaped path and a relative one (§4.3); a macOS screenshot, a copy from Excel or Word
and a browser's Copy image pasted onto a terminal tab.

## 12. Not in this version

Folders; `ccc upload` (Claude asking the person for a file); uploads on the local desktop (a terminal drop pasting a local
path, a Files drop copying in); the streamed Browser panel's own file inputs (still cancelled); resuming after the page
reloads; uploads from overlays, slots or page tabs; a plugin learning an upload's outcome; keeping the device's mtime;
outside paths.

## 13. As built

What the build decided or changed beyond the text above; each line is what the code does, with the reason where it is not
obvious. The sections above were edited where a deviation changed their rule; this list is the rest.

**Spike (Task 1).** An unhandled `Files` drop's navigation could not be reproduced through a DevTools drag (no `drop`
without a cancelled `dragover`, no `will-navigate`), so §3.6's cancel is kept and checked by hand. A chunk cut by the
request bound reached `fetch` as a 408 after Chromium's resend (about 119 s), not as a network error (§3.3). Firefox and
WebKit ran through Playwright's older installed revisions (`executablePath`), not the expected ones.

**Shared rules (`shared/uploads.ts`, `numbered-name.ts`).**
- A refusal of a whole upload is `UploadBeginReply = UploadBegun | {error}`; `UploadResolveReply` is `{tokens, refused} |
  {error}` (Keep both's numbering has to say why it failed; Replace on a clash that is not a regular file answers `{error}`).
- `dedupeNames` and `numberedUploadName` return `null` when ` (99)` is taken or the name would pass 255 bytes; names compare
  NFC-normalized and lowercase (APFS is case and normalization insensitive). `numberedName` and `MAX_NAME_NUMBER` moved to
  `shared/numbered-name.ts`, one source with the remote window's saves.
- `checkUploadName` and `pasteText` use `HIDDEN_TEXT`, not control characters alone: the text lands in Claude's prompt (tag
  characters can hide text), at the cost of refusing a name with a soft hyphen or a subdivision-flag emoji. A tab is a
  control character, so `pasteText` returns `null` (held) instead of dropping a path. A file over 2 GiB refuses the whole
  upload; `pasted: true` gets only `checkUploadName` in main (the device's clock names the file).
- Added as named constants: `UPLOAD_PATH_PREFIX`, `UPLOAD_TEMP_PREFIX`, `UPLOAD_CHUNK_FAST_MS` / `SLOW_MS`,
  `UPLOAD_BEGINS_MAX` / `WINDOW_MS`, `UPLOAD_NAME_MAX_BYTES`, `UPLOAD_PENDING_MS`, `UPLOAD_FINISHED_KEPT` (20).

**Core (`main/files/uploads.ts`).**
- A pending upload (clashes unanswered) holds no place and lasts `UPLOAD_PENDING_MS` (10 min; the 60 s idle clock is for
  bytes, a person reads 100 names slowly). `resolve` checks the 2 and 6 limits again; a refusal after `resolving` (disk)
  reverts to pending under the original deadline. Keep both lstats each candidate at `resolve`.
- The free-space check runs after the clash lstats, the last await before the token mint, so check and mint are one
  synchronous step; the reservation counts every running upload's unsettled sizes, on any device of the disk.
- `.git` is refused by name in `begin` (platform-aware, `insideGit`), not in the shared `checkUploadName`, which has no
  platform. `folders()` lists real directories only (links left out), sorted by code unit.
- Finished uploads are kept per device (20) for the paste. `RateWindow` moved to `main/rate-window.ts`, re-exported from
  `host-api.ts`, so `uploads.ts` does not pull in HostApi's imports. The API for the rest of main: `begin`, `resolve`,
  `cancel`, `grant(token)`, `touch`, `settle`, `outcome`, `dropWindow`.
- Main's cancel finishes (not removes) a running upload with at least one settled file; one with none settled is removed.

**Writer (`main/files/upload-writer.ts`).**
- The no-hard-link fallback is `copyExclusive` (`main/files/copy-exclusive.ts`: `O_EXCL` create, removes only its own
  file, abortable), moved from `remote-downloads.ts` and shared; `copyFile(COPYFILE_EXCL)` cannot say whether it made the
  destination, so its cleanup could delete another's file. A cancel during link or copy removes the placed name and answers
  404 for New and Keep both; Replace keeps "placed once renamed".
- `writeChunk(token, offset, body, length)` never rejects and answers `{status: 200, reply}` or `{status, error,
  expected?, failed?}`; `failed: true` means the file is settled and its temp deleted, so the client must not retry it (a
  retry meets 404 and loses the reason). Chunks of one token run on a promise chain, offset check inside it (a retry can
  arrive while the cut request is still being truncated). A refusal before the body's turn leaves the body unread.
- A numbered name on `EEXIST` starts from the planned name (Keep both's `a (1).txt` can become `a (1) (1).txt`). Replace
  whose target is gone fails the file ("changed meanwhile"), as a folder or a link does. A temps record that cannot be
  saved fails the file before any temp. A temp whose folder was swapped away is truncated to 0 through the descriptor and
  left, its record entry dropped.
- The record's entries are `{path, root}` with no schema bump (new on this branch); a string entry is dropped. The sweep
  keeps an entry whose root cannot be `realpath`ed (an unmounted volume says ENOENT, which "drop on ENOENT" would lose).
  `UploadWriterFs` has a `copy` seam for tests. `DataPaths.uploadTempsJson` is `<data>/uploads/temps.json`.
- The sweep is awaited in the `whenReady` chain before `runStartOrder`, not inside `applyWebAccess` (on the desktop
  `runStartOrder` does not await the gateway); its failure only logs.

**Gateway and router.**
- `connectionsCheckingInterval` is 5 s server-wide (`CONNECTIONS_CHECKING_MS`), see §3.3. The `clientError` listener
  answers `ERR_HTTP_REQUEST_TIMEOUT` with 408 (it had answered every client error 400).
- A `Sec-Fetch-Site` refusal is 403 JSON, an unsigned `/u/` request 401, both with `Connection: close`. A refusal after
  the token is live and `Content-Length` is at most 8 MiB keeps the connection and reads the body off, so a 409 reaches the
  client with its `expected`.
- Window and project close reach `Uploads.dropWindow` from `main/index.ts`'s wiring (the gateway knows no windows); a read
  guest's role change ends its upload through `GuestStore`'s `dropUploads`, not at the route. `GuestStore.end()` drops the
  guest's uploads before `revokeGuest`; `dropDownloadsOf` became `dropTransfersOf` and drops both. `guest-wiring.ts` needed
  no change.
- `uploads.begin` for a `{panel}` source needs the panel in a zone of the reconciled layout: a hidden panel has no frame, so
  it is refused. A source that does not resolve (panel not placed, tab not a Claude or shell tab of the project) answers
  `{error}` with a fixed text; a malformed source, a non-browser view, no device or a guest's out-of-reach target throws
  `refused`.
- `uploads.paste` throws one text for an unknown id, another device's or window's, a panel source, an unfinished upload
  and one with nothing uploaded (`UPLOAD_UNKNOWN_TEXT`): §3.1 wants them indistinguishable.

**Client and shell.**
- The chunk size grows only after a full-size chunk (a short last chunk is fast by being short) and carries across files.
  A 409 whose `expected` differs from the offset resumes without using a retry (50 per file at most); one pointing at the
  same offset ends the file. After a fetch rejection a one-byte slice probe tells an unreadable `File` (Chromium's
  `NotReadableError`) from a dead link; that probe was not run in a real browser, so the one attempt for the next file is
  the guarantee. An abort seen after an attempt cancels the file unless the answer was a whole commit (`done: true`). The
  client takes `sleep` as an option beside `fetch`, `signal`, `onProgress`, `now` (the backoff's test seam).
- `ccPanel.upload` is in any page of a remote non-read view (the SDK cannot tell a panel from an overlay); the shell takes
  a request only from a panel frame: `PluginFrame` hands `onPageMessage` `{source, frame}`, the filter re-checks
  `event.source`, and a source-scan test keeps overlays, slots, settings and page tabs out. A file list over 100 passes
  as it is (main's refusal is the visible one); a non-`File` entry drops the whole message. `onUploadRequest` is one
  module-level sink. The SDK sets `dropEffect: 'none'` on an unhandled `Files` dragover, not only `preventDefault`; a page's
  own drag listeners must set `dropEffect` synchronously, so the guide says to register before the SDK's. `types.ts` did
  not change (the `ccPanel` types live in `panel-core.ts`), so there is no example copy.
- The controller is made in `web/main.tsx`'s `startShell`: React remounts `<App>` on every reconnect and a reconnect must
  not end an upload. The notice, chooser and clash state live in `UploadUi` (`upload-model.ts`, module-level,
  `useSyncExternalStore`); `notice-state.ts` did not change. Keep both is `ApprovalBox`'s optional `alsoAllow` button,
  armed like Allow; Replace is the Allow and is hidden when a clash is not replaceable. A clash arriving over an open
  chooser unmounts the chooser (one dialog at a time; its selection is lost). The chooser's Upload is disabled until the
  preset's folder listing resolves.
- A `resolve` that errors cancels and shows "Nothing uploaded: <reason>" instead of asking again. After a run that left
  files not done the controller sends `uploads.cancel` once the paste is tried (a client-side failure leaves a token live
  on main for the idle minute). The folder preset is written only for a chooser (terminal) upload. The person's own Cancel
  in the chooser or the clash dialog shows no notice unless refused files or folders need naming.
- The shell cancels every `Files` drag nobody cancelled, whatever its target (`cancelUnhandledFileDrops`, installed in
  `startShell`; §3.6), not the SDK's `cancelsFilesDrag`, which spares inputs: a file dropped on a shell text field would
  open in the tab. `pagehide` leaves through `leaveThenClose` (its order is tested).

**Terminal entry and paste.**
- The entry is opt-in from `TerminalView` (it knows `tab.kind`; overlay terminals never get it) through
  `attach(container, entry)`; its seams (`onTerminalUpload`, `registerTerminalPane`) are module-level, as the panel's.
  `TerminalSession.paste` calls `io.act` before xterm's `paste`, so a write guest's held size goes first, as before a key.
- Keys-off is view-wide (`TabsState.keysOff`); with no tab pane mounted the shell counts it as keys-off, and it is read
  again at the xterm paste itself.
- Paste path (manual) needs the tab alive and selected in the calling view; only the status rule is relaxed. A held
  automatic call uses up the one automatic paste (a later one answers held "offered once already"). A Claude tab with no
  session-registry entry is held for both: no status is not "at the prompt". The paths come from the record's `folderReal`
  (owner absolute, guest relative to `TabInfo.cwd`), so a folder reached through a link pastes as its real target.
- A held text's Copy is shown only when the shell's `stripUnsafe` would not change it (`heldCopyable`); Paste path stays
  and main checks again.

**Files plugin (0.6.0).** The drop rules are in `dist/lib/drop.js` (global `ccFilesDrop`, its own script tag), not in
`menu.js`, which is the menu's items. A drag is taken only when `ccPanel.upload.files` is a function and `access` is not
`read`. `isUploadTemp` is an anchored regex mirroring the writer's `TEMP_NAME`; uppercase hex or a suffix stays listed. The
version is only in `plugin.json`.

**Bench and e2e.** `web-terminal-bench.mjs` phase 9 drives `writeChunk` through a plain loopback http server, not the
gateway (devices, cookies and hashed secrets are not cheap to stand up); its window ends with the upload; its temp dir is
`realpath`ed (in a worktree `node_modules` is a symlink and phase 7's zip failed with all files unreadable). The e2e specs
share `test/e2e/upload-fixtures.ts`; a guessed PUT is compared with a GET of a missing route, since the gateway answers a
PUT to any other route 405 for everyone; "drop outside every target" asserts a cancelled `dragover` with `dropEffect: 'none'`
(Chromium then delivers no `drop`). The browser half of the terminal entry ran against fakes first, and `index.ts`'s paste
wiring has no unit test: the e2e is their first real run. In a full `npm run test:e2e` six tests that depend on OS window
focus failed (none touches uploads; `files-menu:226` passes alone), not compared against the base commit.
