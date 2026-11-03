# Reviewer

A cc-cockpit plugin (`cockpit.reviewer`), scaffolded by `ccc plugin new`.

- `plugin.json`: the manifest (`ccc guide plugins`).
- `dist/host.js`: the plugin host code, plain JavaScript run as is (`ccc guide api`).
- `ccc review`: a command this plugin adds, handled in `dist/host.js`.
- The `reviewer` service (v1), for other plugins (`"uses": { "reviewer": 1 }`):
  - `open(path, { tabId? })`: the review overlay for a project file (diff against the last commit).
  - `annotate({ title, text, url?, key?, tabId? })`: the same overlay on a text of the caller's (a ticket, a mail):
    one read-only pane, notes on selections, one comment, Discuss / New session / Close; no diff, no file, no Edit.
  - `annotate({ title, html, assets?, url?, key?, tabId? })`: the same with HTML in place of `text` (exactly one of
    the two), rendered as a document; see "HTML mode" below.
  - `aside` (either form, optional): HTML of at most 100,000 characters for a details column at the right of the
    text, sanitized like `html` (see "HTML mode"); `dl.facts` is a vertical list there.
  - `start` (HTML form only, optional, app 0.9.4+): `'top'` (default) or `'end'`, where the document opens; `'end'`
    for a thread whose newest messages are last. It stays at the end while pictures load, until the person scrolls.
  - `companion` (HTML form only, optional, app 0.9.3+): `{ title, html, assets?, url?, facts?, label?, urlLabel? }`,
    a second document beside the first, with `label` / `urlLabel` for the main column's header; see "Companion" below.
  - `features()`: the optional annotate features this reviewer has (`['companion']`); an older reviewer has no such
    method (the call rejects with `has no method "features"`: read it as none).

  Both resolve `{ opened: true }` once the overlay is up and reject with `reviewer: <why>` otherwise; a second call
  for the same file or `key` brings the open overlay to the front. The tab picker starts on `tabId` when it is a live
  Claude tab of the window, else on the tab the window shows (`SessionInfo.active`), else on the only tab, or asks.
  See `docs/design.md` "annotate" for the limits and what Claude receives. From a Jira plugin:

  ```js
  // plugin.json: "services": { "uses": { "reviewer": 1 } }
  const reviewer = ctx.services.use('reviewer')
  await reviewer.annotate({
    title: `${issue.key} ${issue.summary}`,
    text: issue.descriptionText, // plain or markdown-ish text, at most 400 KiB
    url: `https://example.atlassian.net/browse/${issue.key}`,
    key: `jira:${issue.key}`, // one overlay and one kept draft per issue
  })
  ```

## Companion

`annotate({ title, html, aside?, assets?, url?, key?, tabId?, label?, urlLabel?, companion: { title, html, assets?, url?, facts?, label?, urlLabel? } })`
shows a second document beside the first: a mail with the Jira issue it is about, an issue with the pull request that
fixes it. The page then has one grid: a header row, and under it two columns, the main document left and the
companion right, each scrolling on its own, with a divider spanning both rows (drag it, arrow keys or Home / End on it
when focused, double-click for half and half; the position is the person's, kept app-wide in `ctx.appStorage` like
the diff layout). The header row's two cells are the same height (the taller one's, at most 40% of the overlay, a
longer facts list scrolls inside its cell) and stay put while the documents scroll. Each cell is a bar with the
column's `label` (default: the title, cut to 60) and, when it has a `url`, a button `Open in <urlLabel> ↗` (`Open in
browser ↗` without one), then its details block: the caller's `aside` in the main column, the companion's `facts` in
its column, `dl.facts` as a grid. The details column at the right and the icon after the `h1` are not shown then.
Narrower than 700 px the columns stack, each header above its own document, and the divider is hidden. Without
`companion` the page is exactly as before (labels are checked but not shown).

- Checked like the main document (`checkCompanion` in `dist/lib/review.js`): `title` 1-200 characters made one line,
  `html` at most 2 MiB of UTF-8 with no NUL (required), `facts` at most 100,000 characters, `url` http(s) of at most
  2048 characters. Both are sanitized by the same allow-list.
- `assets`: one budget and one id namespace with the main document's (30 and 8 MiB in all, ids unique across both),
  so an `asset:<id>` names the same picture in either. A caller with pictures in both splits the budget itself.
- `label` 1-60 and `urlLabel` 1-30 characters of plain text (made one line), on annotate and on the companion.
- Each column's button opens its own `url` (the page says which column, the host picks the URL); the companion's links
  (in `html` and `facts`) open like the main document's (the host's allow-set holds both).
- Notes go on either document. A note on the companion is stored with `doc: 'companion'`, anchored and highlighted in
  the companion's own text, and listed after the main document's with the companion's label as a tag. Claude gets
  `About <title> (<url>), with <companion title> (<url>) beside it`, then the main document's notes as `On «quote»:`
  and the companion's as `In <companion title>, on «quote»: note`.
- Detection: `await reviewer.features().catch(() => [])` includes `'companion'` from app 0.9.3 on. An older reviewer
  would ignore `companion` and show the main document alone, so ask first and fall back when it is missing.

```js
const features = await reviewer.features().catch(() => [])
if (features.includes('companion')) {
  await reviewer.annotate({
    title: mail.subject,
    html: mail.html,
    aside: mail.facts,
    key: `mail:${mail.id}`,
    label: 'Mail',
    urlLabel: 'Gmail',
    companion: { title: `${issue.key}: ${issue.summary}`, label: `Jira · ${issue.key}`, urlLabel: 'Jira', html: issue.html, facts: issue.facts, url: issue.url, assets: issue.assets },
  })
}
```

## HTML mode

`annotate({ title, html, aside?, assets?, url?, key?, tabId? })`. The HTML (at most 2 MiB of UTF-8) never reaches the page as
markup: the page parses it with `DOMParser` (inert: nothing runs or loads) and rebuilds it element by element from an
allow-list (`src/page/sanitize.mjs`); no `innerHTML`. What survives:

- Elements: `h1`-`h6`, `p`, `br`, `hr`, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `table`, `thead`, `tbody`, `tr`,
  `th`, `td`, `a`, `img`, `strong`, `em`, `s`, `u`, `sub`, `sup`, `span`, `div`, `details`, `summary`, `figure`,
  `figcaption`, `dl`, `dt`, `dd`. Other elements are unwrapped (their text stays); `script`, `style`, `iframe`, `object`, `svg`, `math`,
  forms and their controls, media and head elements are dropped with their content. Nesting past 100 levels is unwrapped.
- Attributes: `class` (only the names below), `title`, `colspan`/`rowspan` on cells (1-1000), `alt` and `data-asset`
  on images, `href` on links (`http:`, `https:` or `mailto:` only). Every other attribute (`on*`, `style`, `id`,
  `target`, ...) is dropped.
- Classes, styled by `overlay/review.css` with the app's theme variables: `jira-panel` with `jira-panel-info`,
  `-note`, `-warning`, `-error`, `-success` (tinted panels); `card`, `card-header`, `meta` (a comment or a linked
  item: header row, muted meta text); `mention` (a chip); `status`, `lozenge`, `lozenge-info`, `-success`,
  `-warning`, `-error` (a pill, the tone tinting its background and text); on a `span` only, `lozenge-neutral` and
  `lozenge-danger` (`lozenge-error` is its older name) and `person` (a person's name as a faint chip); at most one
  tone per element (the first named; the rest are dropped); on a `dl` only, `facts` (the key fields of an item: a
  compact grid of `dt` label / `dd` value pairs, muted small-caps labels, as many pairs per row as fit); `new` (highlighted: new since last time) and `old` (struck out); `attachment-list` (a row of
  boxes); `fields` (a key/value table with narrow keys); `muted`.
- Links in the document and the details column open in the system browser on a plain click, Enter on a focused link,
  or a middle click (a drag-select that ends on a link makes a selection for a note and opens nothing). The page
  posts the href; the host opens it with `ctx.openExternal` only when it is http(s) and a link of the caller's own
  `html` or `aside` (read from those strings, entities decoded, both sides normalized with `new URL()`). Otherwise
  the status line says why: `Not opened: not a link of this document`, or `mailto links are not opened: <address>`
  (`ctx.openExternal` takes http(s) only); the app's own refusals (3 links per 10 s) show there too. A link without
  a `title` shows its URL as a tooltip.
- Images: only `<img src="asset:<id>">` (or `data-asset="<id>"`) naming one of `assets`; any other `src` is dropped
  and the image shows as `[image: <alt>]`. A click shows an image larger; a click or a key closes it (Esc closes the
  whole overlay, the draft kept: the app takes Esc before the page).

`assets: [{ id, name?, mime, dataUrl }]`: `id` 1-100 of `A-Z a-z 0-9 . _ -`, unique; `mime` one of `image/png`,
`image/jpeg`, `image/gif`, `image/webp` (no SVG); `dataUrl` a base64 `data:<mime>;base64,` URL of at most 1,000,000
characters; 8 MiB and 30 assets in all. Each asset reaches the page in its own message after the HTML, so an image
shows a placeholder until it comes and its alt text (or `name`) if it never does.

Notes anchor on the selected text (`src/page/anchor.mjs`): the quote (first 500 characters), 32 characters of context
on each side, which match of the quote it was and the selection's length. Reopened on a changed document, the note is
highlighted where its context still matches best; when its quote is gone it is listed as "not found in this version"
and not highlighted. Claude receives `About <title> (<url>)`, the comment, then `1. On «quote»: note` per note in text
order (quotes made one line and shortened as in file reviews; no line numbers).

```js
await reviewer.annotate({
  title: `${issue.key} ${issue.summary}`,
  html: `
    <h1>${esc(issue.key)} ${esc(issue.summary)}</h1>
    <dl class="facts"><dt>Status</dt><dd><span class="lozenge lozenge-info">In progress</span></dd>
      <dt>Priority</dt><dd><span class="lozenge lozenge-danger">High</span></dd>
      <dt>Assignee</dt><dd><span class="person">Ann Lee</span></dd></dl>
    <div class="card"><div class="card-header">Description <span class="meta">updated ${esc(updated)}</span></div>
      <div class="jira-panel jira-panel-warning"><p>Only for logged-in users.</p></div>
      <p>Ask <span class="mention">@Ann Lee</span>.</p></div>
    <div class="card new"><div class="card-header">Bob <span class="meta">2 h ago</span></div><p>Still broken.</p></div>
    <ul class="attachment-list"><li><img src="asset:a1" alt="screenshot.png"></li></ul>`,
  // The key fields in the details column at the right: a vertical list there.
  aside: `<dl class="facts"><dt>Reporter</dt><dd><span class="person">${esc(issue.reporter)}</span></dd>
    <dt>Labels</dt><dd>${issue.labels.map(esc).join(', ')}</dd></dl>`,
  assets: [{ id: 'a1', name: 'screenshot.png', mime: 'image/png', dataUrl: `data:image/png;base64,${b64}` }],
  url: `https://example.atlassian.net/browse/${issue.key}`,
  key: `jira:${issue.key}`,
})
```

The caller escapes its own text (`esc`): the sanitizer keeps what is safe, not what was meant.

Development happens in the app repo: `cockpit.reviewer` is a bundled plugin, and `cockpit.` ids are
reserved, so `ccc plugin link` (and any folder, git or marketplace install) refuses it. Edit
`plugins/reviewer` in place; a dev build (`npm run dev`, or `npm run build` and launch) loads this
folder as the bundled copy, with no linking. The host (`dist/`) is plain JavaScript run as is; after
editing the overlay page (`src/page/`), run `npm run build:reviewer` and commit the rebuilt
`overlay/review.bundle.js`. A host change takes effect when the project's plugin host restarts
(turn the plugin off and on in the project, or restart the app). `npm run test:plugins` runs the
tests in `test/`; `ccc plugin logs cockpit.reviewer --follow` shows what it logs.
