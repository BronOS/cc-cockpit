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
annotate({ title, text, url?, key?, tabId? })  // the same overlay on a plain text (below)
annotate({ title, html, assets?, url?, key?, tabId? })  // ... or on sanitized HTML (below)
// editor v1 (implemented by the editor plugin)
open(path, { line? })
```

`path` is resolved inside the project folder. The reviewer refuses a path outside it and a path through a
symlink that leaves the folder. A file over a size cap (about 2 MiB) and a binary file get a notice
instead of a diff.

### annotate (added to v1, 2026-11-02)

```js
annotate({ title, text, url?, key?, tabId? })  // -> { opened: true } once the overlay is up
```

The review overlay on a text another plugin hands over (a Jira issue, a mail), not a file: one
read-only pane with `text` (markdown colouring, wrapped lines), the same notes on selections, the
same comment, the same Discuss / New session / Close and tab picker. No diff, no layout toggle, no
git, no Edit (the `e` key does nothing). No header row either (2026-11-03): the overlay's title bar already shows
`title`, and a Jira issue's HTML names it a third time. For a `url` a small "Open in browser" icon button (the URL in
its tooltip) sits in the document: at the end of the HTML's first `h1`, placed by the page after sanitizing (its own
element, never the caller's markup), else floated to the top right of the HTML document or in the top right corner
of the text pane. A click posts `{ type: 'open-url' }`, nothing more: the host opens the URL the
caller gave it with `ctx.openExternal` (never a URL from the page, a sandboxed frame that shows the caller's content),
and the page shows the reason in its status line when the app refuses (no `user:pass@`, 3 opens per 10 s). Without
`ctx.openExternal` (an older app) the button is not shown.

Inputs come from any plugin of the project, so the host checks them (`dist/lib/review.js`,
`annotateInput`) and rejects with `reviewer: <field> ...` before anything is shown:

| Field | Rule |
|---|---|
| `title` | a string; whitespace and control runs become one space; 1-200 characters after that |
| `text` | a string of at most 400 KiB of UTF-8 (a file side's cap), no NUL; empty is allowed |
| `url` | absent/null, or an `http:`/`https:` URL of at most 2048 characters with no whitespace or controls |
| `key` | absent/null (then `title:` + 32 hex chars of the title's SHA-256), or 1-200 characters of `A-Z a-z 0-9 . _ : @ # + = ~ / -` |
| `tabId` | absent/null or a string |
| `aside` | absent/null/empty, or a string of HTML of at most 100,000 characters, no NUL (with `text` or `html`) |

`aside` (2026-11-03) is a details column at the right (about 240 px, scrolling on its own, under the
document below 700 px of width), shown only when given: the key fields of an item, so the body keeps the
prose. It is sanitized and rendered like `html` (the same allow-list and `assets`); a `dl.facts` there is
a vertical list, each label above its value, where the body lays one out as a grid. It is not in the init:
with a 400 KiB text and a draft that could pass the page message limit, so the init says `sides.aside`, the
page asks with `{ type: 'content' }` as in HTML mode, and `{ type: 'aside', html }` is the first answer
(100,000 chars escaped stay well inside one message). Notes go on the body only.

One overlay per key: a second call with the same key brings it to the front (the new text is not
shown; close it first). The draft is kept in `ctx.storage` under `annotate:<key>` (hashed past the
200-character key limit), a namespace apart from the files' `draft:<path>`, and behaves as a file's:
it survives Esc and Close, and goes once Claude has the whole review. An init message over the page
limit (a large text plus escaping plus its draft) is refused like a file's.

Claude receives, through the same caps and quote shortening as a file review:

```
About PROJ-1 Fix the login redirect (https://example.atlassian.net/browse/PROJ-1)

<global comment, if any>

1. Lines 3-4:
   > the selected text,
   > quoted line by line
   the note
```

There are no old/new sides. It opens with `About`, so it never starts with `/`, `!`, `#` or `&`.

### annotate with HTML (added to v1, 2026-11-02)

```js
annotate({ title, html, aside?, assets?, url?, key?, tabId? })  // exactly one of text and html
```

For a source whose content is rich (a Jira issue: panels, mentions, tables, comments, screenshots), plain text loses
too much. The page renders the HTML as a document instead of the text pane; everything else (title, url, key, tabId,
draft, buttons, picker) is as with `text`. The allowed elements, attributes and classes are listed in the README
("HTML mode").

- **Sanitizing.** In the page, before anything touches the DOM: `DOMParser` (an inert document) and an allow-list walk
  (`src/page/sanitize.mjs`) into plain data, from which fresh elements are built with `createElement` /
  `setAttribute` / text nodes. No `innerHTML`, and nothing is serialized and re-parsed, so mutation XSS has no
  parser round trip to use. A vetted library (DOMPurify) was the alternative; it returns markup or a fragment built
  from the browser's own clone of the input, and adding it meant a new dependency in the bundle for less than this
  walk needs to do (class allow-list, asset references). The page CSP blocks script anyway; the sanitizer does not
  count on it. Tests: `test/html.test.js` (the walk over fake nodes, links, images, anchors) and the app's
  `test/e2e/reviewer-annotate.spec.ts` (the real parser, with script, onerror, style, javascript: and an asset).
- **Links** open through the host: the frame may not navigate, so a plain click (Enter, a middle click) posts
  `{ type: 'open-link', href }` with the sanitized DOM's href, and the host calls `ctx.openExternal`. The page renders
  a caller's HTML, so its href is not taken on trust (a sanitizer or page bug must not open a URL the caller never
  gave): when annotate starts, the host reads the hrefs of the `<a>` tags in the caller's `html` and `aside` strings
  (a linear scan of each tag's attributes, entities decoded as the parser decodes attribute values), normalizes them
  with `new URL()` as `safeHref` does, and opens only an http(s) href in that set (`linkSet`, `linkVerdict` in
  `dist/lib/review.js`). A link it reads differently from the browser (an exotic named entity) is refused: it fails
  closed. `mailto:` is named in the status line, not opened (`ctx.openExternal` takes http(s) only). A click that ends
  a drag-select is not a link click (`src/page/links.mjs`, `isPlainClick`: no movement past 4 px, no new selection,
  no double click). Chromium starts no selection on a link (a press there drags the link), so a selection reaches
  a link from the text around it; the check covers any other way a click on a link comes with a new selection.
- **Images** are assets the caller hands over as base64 data: URLs (png, jpeg, gif, webp; never SVG, which is a
  document with script and links of its own); the page CSP allows `data:` images. `<img src="asset:<id>">` names
  one; any other src is dropped, so the page loads nothing from the network or the disk.
- **Limits** (`dist/lib/review.js`, `annotateInput`): html at most 2 MiB of UTF-8, no NUL; at most 30 assets, each
  dataUrl at most 1,000,000 chars, 8 MiB in all; ids 1-100 of `A-Z a-z 0-9 . _ -`, unique.
- **Transport.** A page message takes 1,040,384 chars of JSON, and until the page has loaded main queues at most 100
  messages or 8 MiB for it (dropping, with a log line, what does not fit). So the init carries no content, only
  `htmlParts` and the asset list (id, name, mime); once the page has the init it posts `{ type: 'content' }` and the
  host answers with the HTML in parts of at most 900,000 JSON chars (`splitParts`: a part is at most 150,000 chars,
  never cutting a surrogate pair), one `{ type: 'asset', id, dataUrl }` per asset, and `{ type: 'assets-done' }`.
  The page renders when the last part is in, shows a placeholder for an image until its asset comes, and its alt text
  after `assets-done` (CSS generated text, so no text node changes and anchors keep their offsets).
- **Notes** anchor on text, not lines: `{ id, quote, anchor: { prefix, suffix, occurrence, length, at }, text }`
  (`src/page/anchor.mjs`). Offsets are into the concatenated text nodes of the rendered document. `quote` is the
  selection's first 500 chars, `length` its full length, `prefix`/`suffix` 32 chars around it (the host keeps up to
  64), `occurrence` how many matches of the quote come before it, `at` its offset (orders the notes). Reopening
  scores every match of the quote (prefix match, suffix match, the same occurrence) and highlights the best with the
  CSS Custom Highlight API, which paints ranges without changing the DOM; a quote that is gone leaves the note listed,
  marked "not found in this version". The `a` key and the floating Add note button work as in a file review.
- **Message:** `About <title> (<url>)`, the comment, then `N. On «quote»: note` in text order; the quote made one line,
  shortened by the same ladder as file reviews but never below 40 chars (it is all that locates the note), with
  ` …` when shortened or when the selection was longer than its stored quote.
- **Esc.** The image lightbox closes on a click or a key, but Esc closes the overlay itself (draft kept): main takes
  Esc before the page sees it, and a page has no way to claim it.

### Which tab the picker starts on

For `open`, `annotate` and a click alike: `tabId` when it is one of the window's live Claude tabs
(a click names the clicked tab), else the tab the window shows (`SessionInfo.active`, core since
2026-11-02), else the only tab when there is one; otherwise the page asks.

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

- **Top:** a textarea for the comment on the whole file, and right under it the notes: a compact numbered
  list (at most about 120 px, then it scrolls; no room at all while there is none, the textarea's
  placeholder says how to add one). Each row: where (a click shows it), the quote in italics cut to 90
  characters, the note's text (beside the quote when both fit, else under it) and ✕ to delete. There is
  no sidebar (2026-11-03): the diff or document gets the width.
- **Body:** a side-by-side or unified diff (a toggle, remembered). It is read-only in the reviewer; changing
  the file is the editor's job.
- **Annotations:** select text in either side, then "Add note" (the `a` key, or a small button that floats just
  under the end of the selection while there is one, in every mode: re-placed on scroll, hidden once the selection
  is scrolled out of the pane, collapses, or focus moves into a note or the comment). Each note
  stores the side (old or new), the line range, the selected text (up to about 500 characters) and the
  note. A note shows as a highlight with a margin marker and can be edited or deleted in the list. Any number of
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
