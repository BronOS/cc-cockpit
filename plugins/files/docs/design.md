# Files: a project tree (cockpit.files)

Status: agreed with the user on 2026-11-02; first version on branch `files-tree`. The right-click menu
(0.2.0) approved by the owner on 2026-11-06.

## What it is for

The person can see every file of the project and open any of them to read it and discuss it with
Claude, changed or not. The Sessions panel only lists what a session wrote; the tree is the way to
everything else. It ships with the app, like the browser, reviewer and editor, and uses only the
public plugin API (plus `ctx.files.open`, added to core in the same change, below).

## The panel

- One panel, `Files`, in the left zone by default. The tree starts at the project folder.
- Everything is shown by default, including dotfiles (`.env`, `.github`, `.claude`) and what
  `.gitignore` lists (`node_modules`, `dist`). Two app-wide settings hide them:
  - **Hide hidden files**: names starting with `.`.
  - **Hide ignored files**: what git ignores (`git check-ignore`). Shown ignored entries are dimmed.
- `.git` itself is never shown: it is git's own data, nothing in it is worth discussing, and it
  adds thousands of entries.
- Folders first, then files, by name (case-insensitive, numbers in order). A folder is read when
  it is expanded, so a big project costs nothing until opened; at most 2,000 entries per folder
  are listed, then one "N more not shown" row.
- A symlink is shown with a mark. A linked folder whose real path leaves the project cannot be
  expanded (no loops, no escape); a linked file is opened like any other, and core refuses it
  when its real path is outside the project.
- Change marks from `git status`: M (modified), A (added), ? (untracked), R, U, and a dot on a
  folder holding a change. Outside a git repo there are none.
- A filter box on top: typing shows a flat list of matching paths (every space-separated word
  must appear in the path, case-insensitive; at most 200). In a git repo the list comes from
  `git ls-files -co --exclude-standard`, so ignored files are not searched (they are still in the
  tree); outside git it is a bounded walk (20,000 files).
- Expanded folders are remembered per project (`ctx.storage`).

## Opening a file

- A click on a file (or Enter) opens it through the project's "Plugin used to open files" pick,
  the same as a click in the Sessions panel: the reviewer by default, which shows the diff for a
  changed file and the file itself otherwise, with notes, a comment, Discuss and New session. A
  replaced reviewer, or the built-in viewer when the pick is "Built-in viewer", is honoured.
- Each row also has **Edit** (the `editor` service: micro by default), on hover and on the
  keyboard (`e`).
- No drag in the tree: Claude and the editor change files; the menu below covers the rest.

## Right-click menu (0.2.0)

A menu in the panel page (the SDK's `.cc-menu`), opened by a right click, the context-menu key or
Shift+F10 (under the selected row); arrows, Home/End, Enter, Escape (focus back to the tree).

- **File:** Open (the `@open-file` pick, as a click), Open with default app, Reveal in Finder (the
  label per OS: "Show in Explorer", "Open in file manager"), Ask Claude about this file, Copy path,
  Copy relative path, Rename…, Move to Trash.
- **Folder:** Reveal, Open terminal here, New file…, New folder…, Copy path, Copy relative path,
  Rename…, Move to Trash.
- **Empty area (the project folder):** New file…, New folder…, Reveal, Copy path.

Who does what:

- Reveal, Open with default app and Move to Trash are core calls (`ctx.files.reveal`,
  `openWithSystem`, `trash`, added for this): main resolves the path inside the project by its real
  path, refuses to open runnable files (a script, a program, an app bundle, the exec bit) and asks
  the person before the Trash; a no is an `AbortError`, which the tree ignores.
- New file, New folder and Rename run in the host with Node fs (`lib/ops.js`): the folder is
  realpath'd and must be inside the project, the name is one segment (no `/`, not `.` or `..`, no
  NUL, at most 255 bytes), and an existing name is refused, never replaced. The name is typed in a
  bar under the header (not a `<form>`: the sandboxed frame has no `allow-forms`). The tree is
  re-read at once and the new entry selected; a renamed open folder stays open.
- Ask Claude opens a focused Claude tab whose prompt names the relative path only (never the file's
  content).
- Open terminal here opens a focused shell tab in the folder (`ctx.sessions.openShell`, added for
  this; it had been left out while the public API opened only Claude tabs): the person's own shell,
  with no command from the plugin; main checks the folder inside the project by its real path. An
  older app without the call gets no such item.
- Copy path / Copy relative path are the page's: `document.execCommand('copy')` inside the click,
  which the sandboxed frame may do (navigator.clipboard is refused to its opaque origin). The host
  sends the project folder's absolute path and separator in its `reset` message, so the copy needs
  no round trip.
- Errors show in the panel's notice line.

## Refresh

Plugin hosts have full Node, so the host watches each expanded folder with `fs.watch` (not
recursive, at most 200 watchers) and re-reads it after a short debounce; git marks are re-read
after any change (debounced 1 s). A refresh button re-reads everything, and the page asks for a
fresh tree when it loads.

## Core change: `ctx.files.open(path, { tabId? })`

Before this, only a Sessions panel click went through the open-file pick; a plugin wanting to
open a file had to call a service of a plugin it chose itself, ignoring the person's pick and
never reaching the built-in viewer. Now:

- `ctx.files.open(path, options?)` -> `Promise<{ via: 'plugin' | 'builtin' }>`. `path` is relative
  to the project folder (`/` separators). Main resolves it, and refuses (rejects) a path outside
  the project by its real path, a missing path, or one that is not a regular file.
- `options.tabId`: a Claude tab of this project to pass on (checked by main; an unknown one is
  dropped, not an error).
- Main picks the plugin exactly as for a click (`selectOpenFile`). That plugin's `onOpen` listener
  gets `{ path, tabId? }`: `tabId` is now absent when the open did not come from a tab. When no
  plugin takes it within the bound, or the pick is the built-in viewer, the built-in viewer opens
  (a diff when git has one, else the pager).
- No manifest declaration is needed to call it. Calls are rate limited per plugin per window.

## Settings

App-wide (`contributes.settings.app`): `hideHidden` (boolean, default false) and `hideIgnored`
(boolean, default false).
