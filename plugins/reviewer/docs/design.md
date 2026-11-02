# Reviewer: design

Status (2026-11-02): milestones 1-3 built and tried in the app; now bundled with the app as `cockpit.reviewer` (with
`cockpit.editor`, micro), using only the public plugin API. Differences from this note: Edit is hidden when
`ctx.services.available('editor')` is false; the diff layout (side by side or unified) is remembered app-wide; an
unchanged file shows as one plain pane; in unified, a click on a removed block picks it for a note on the old side;
a second click on a file already under review brings its overlay to the front. Every FRICTION.md entry has its outcome.

## Goal

When Claude changes a file, the person reviews it in a diff view. They select text and attach notes to it,
write one comment for the whole file, then hand the review to Claude with a button. The reviewer
replaces the read-only pager that core opens today when you click a modified file in the sessions
panel.

## Scope and the split into plugins

Two plugins, joined only through plugin services:

| Plugin | Provides | Uses | Job |
|---|---|---|---|
| reviewer | `reviewer` v1 | `editor` v1 | diff view against the last commit, annotations, global comment, Discuss / New session / Edit |
| editor | `editor` v1 | | the real editor: micro in a terminal overlay (below) |
| file tree (later) | | `reviewer` v1, `editor` v1 | opens a file for review or editing |

Which editor the reviewer uses is not a reviewer setting. When several enabled plugins provide
`editor`, core's Settings > Plugins already offers "Plugin used for editor", per project.

When no plugin provides `editor`, Edit is hidden. The reviewer recognises the
`no enabled plugin in this project provides service "editor"` error and hides the button.

## The first editor: micro in a terminal overlay

Agreed on 2026-11-02. The first plugin to provide `editor` v1 is a small wrapper around
[micro](https://micro-editor.github.io/), a terminal editor. It needs no core change, because a
terminal overlay already exists.

- `open(path, { line? })` calls `ctx.overlay.open({ kind: 'terminal', ... })` with
  `micro -autosave <s> [+<line>] <path>`. Every micro option can be passed as a flag like this, so
  the plugin sets autosave without touching the person's micro config.
- Settings: autosave interval in seconds (default 5, 0 turns it off), colour scheme (a micro
  colorscheme name, to match the app theme as closely as possible), and the path to the micro binary
  (default: `micro` on the login-shell PATH).
- At `open`, it checks for the binary with `ctx.exec(['micro', '-version'])`. When micro is missing,
  `open` rejects with a clear message ("micro is not installed: https://micro-editor.github.io").
- Clipboard on Wayland needs `wl-clipboard`. The plugin's README says so.
- Limits:
  - It is modal: an overlay covers the window, so you can't edit next to the Claude tab.
  - It doesn't follow the app theme beyond the chosen colour scheme.
  - It can't show the reviewer's notes; Edit only jumps to the line of the selected note.
- Autosave and a working Claude session can write the same file. micro notices when the file
  changes on disk and asks whether to reload. The reviewer also warns on Edit when the session
  is busy.
- An in-app editor (CodeMirror in a panel) can replace micro later behind the same service, with no
  change to the reviewer. Revisit only if the overlay feels limiting in daily use.

## Bundling

Agreed on 2026-11-02: the reviewer, the file tree and the micro editor ship bundled with the app, like
`cockpit.browser`. They are updated with app releases, which keeps changes simple to manage early on.
Their ids are `cockpit.reviewer`, `cockpit.editor` and `cockpit.files`. They are still built only against the
public plugin API, so anything the bundled ones do, a third-party plugin can do too. Overriding goes
through the service provider pick (`reviewer`, `editor`), the "open file" handler pick (core's pager
stays the fallback), or disabling the bundled plugin. Open: whether a bundled plugin can be disabled for
the whole app, not only per project.

## Services

```js
// reviewer v1
open(path, { tabId? })  // show the review overlay for a file; tabId: the Claude tab the review goes to
// editor v1 (implemented by the editor plugin)
open(path, { line? })
```

`path` is resolved inside the project folder. The reviewer refuses a path outside it and a path through a
symlink that leaves the folder. A file over a size cap (about 2 MiB) and a binary file get a notice
instead of a diff.

## Diff base: the last commit

The host runs `git diff HEAD -- <path>`, argument list only, never through a shell. It reads both versions
with `git show HEAD:<path>` and the working-tree file, and the view computes the diff itself.

| Case | Shown |
|---|---|
| changed file | the changes since HEAD, including the person's own uncommitted edits |
| untracked file | the whole file as added |
| deleted file | the HEAD content as removed; Edit is disabled |
| no git repo, or no commits yet | the plain file with a note that there is no diff |

## The review overlay

- **Top:** a textarea for the comment on the whole file.
- **Body:** a side-by-side or unified diff (a toggle, remembered). It is read-only in the reviewer; changing
  the file is the editor's job.
- **Annotations:** select text in either side, then "Add note" (a button and a key). Each note
  stores the side (old or new), the line range, the selected text (up to about 500 characters) and the
  note. A note shows as a highlight with a margin marker and can be edited or deleted. Any number of
  notes.
- **Buttons:**
  - **Discuss** sends the review to `tabId`, the Claude tab whose file was clicked, through
    `ctx.sessions.send`. If the tab is busy, the text is queued and the button says "Queued, sends when
    Claude is waiting". Without a `tabId`, for example when opened from the file tree, Discuss asks
    which tab to use, or is hidden when the window has no Claude tab.
  - **New session** opens a new Claude tab in the project folder, with the review as its first
    prompt, through `ctx.sessions.open({ cwd, prompt })`.
  - **Edit** closes the review and calls `editor.open(path, { line })`, using the line of the selected
    note when there is one.
  - **Close** sends nothing.
- **Drafts:** Close keeps the draft for that file in `ctx.storage` under `draft:<path>`. Reopening the
  file brings back the global comment and the notes. Discuss and New session clear the draft. A
  draft whose notes no longer match the file (the selected text is gone) keeps the notes but marks
  them "may be outdated".

## What Claude receives

Plain text. It never starts with `/`, `!`, `#` or `&`, which the send gate refuses.

```
Review of src/x.ts (changes since the last commit)

<global comment, if any>

1. Lines 12-14 (new):
   > the selected text,
   > quoted line by line
   the note

2. Line 40 (old, removed):
   > ...
   ...
```

Line numbers refer to the version named in parentheses. The quote travels with each note because
Claude may already have changed the file by the time it reads the review. The whole message is
capped (about 20,000 characters); past that, quotes are shortened first, and a review still too long
goes out cut, with its full draft kept. Note inputs take 4,000 characters, the comment 20,000 (shown
near the limit), and a review 200 notes ("Add note" turns off there, with a hint), the same caps the
host applies to a draft; a draft over 400,000 characters as JSON is not saved, and the page says so.
A draft the store refuses is shown in the review as "Draft not saved" (the last saved one stays),
Edit then keeps the review open, and closing it with the failure unresolved ends in a notice. A
review queued in a busy tab keeps its draft until the tab's next prompt is that review; when the
tab ends first, a notice says it may not have reached Claude.

## Technology

- Plain JavaScript host, no build step for the host. The overlay page bundles CodeMirror 6 and
  `@codemirror/merge` into one local file. A plugin page has no network, so nothing is loaded from a
  CDN. esbuild runs at development time and the bundle is committed.
- Syntax highlighting comes from the CodeMirror language packages, chosen by file extension. The theme
  comes from `ccPanel.theme` (the app's CSS variables).
- Keys: `a` add a note on the selection, `j`/`k` next/previous change, `e` Edit, `Esc` Close.
- Overlay limits from `ccc guide api`: at most 3 open and 10 per minute. A second `open` of the same file
  focuses the existing overlay rather than opening a new one.

## Core API it builds on (cc-cockpit v0.3.0)

The three core needs from the first draft shipped in v0.3.0 (`ccc guide api`, `panels`, `plugins`):

1. **Opening files: `ctx.files.onOpen(listener)`**, with `"contributes": { "openFile": { "title": "Review" } }`.
   `listener({ path, tabId })` gets a project-relative path and the clicked Claude tab, both set
   by the app. The project picks the handler in Settings > Plugins ("Plugin used to open files"),
   with "Built-in viewer" as a choice. Consequences for the reviewer:
   - The listener must not throw or reject within 1 s, or the built-in viewer opens as well.
     Awaiting the overlay is fine, because a listener still running after 1 s counts as handled.
   - Only that click goes through the hook. The file tree opens files through the `reviewer`
     service, as planned.
2. **Two-way overlay: `ctx.overlay.start(spec)`** returns `{ result, post, onMessage, close }`.
   - The host `post`s the file, the HEAD version and the draft; messages are queued until the page
     has loaded.
   - The page posts messages without a `result` key to stay open (draft updates, Edit), and
     `ccPanel.post({ result })` for Discuss and New session.
   - Esc, ✕ and Cmd+Shift+W resolve `{ kind: 'dismissed' }` without asking the page. So the page posts
     the draft on every change (debounced), and the host saves it to `ctx.storage`. That matches
     "Close keeps the draft" above with no extra work.
   - Messages are at most about 1 MiB of JSON. A file near the 2 MiB cap plus its HEAD version
     won't fit in one message, so the size cap drops to about 400 KiB per side, or the content is
     sent in chunks.
3. **Size: `size: 'large'`** (about 90 % of the window) or `'full'`. The reviewer uses `'large'`.

Still useful, not blocking:

- `ctx.sessions.list()` documenting each tab's cwd and whether it is busy, so Discuss can say
  whether the text will be queued.
- The list of changed files core already shows, exposed per tab. The reviewer could then offer
  "next changed file".

## Open questions

- Unified or side-by-side as the default?
- Should Discuss also hand Claude the commit the diff is based on, so it can run the same diff itself?
- Several files in one review (all of a session's changes) is a natural second step. It fits the
  message format, but it is not in version 1.
