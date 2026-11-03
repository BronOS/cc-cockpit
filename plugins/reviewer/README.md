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

## HTML mode

`annotate({ title, html, assets?, url?, key?, tabId? })`. The HTML (at most 2 MiB of UTF-8) never reaches the page as
markup: the page parses it with `DOMParser` (inert: nothing runs or loads) and rebuilds it element by element from an
allow-list (`src/page/sanitize.mjs`); no `innerHTML`. What survives:

- Elements: `h1`-`h6`, `p`, `br`, `hr`, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `table`, `thead`, `tbody`, `tr`,
  `th`, `td`, `a`, `img`, `strong`, `em`, `s`, `u`, `sub`, `sup`, `span`, `div`, `details`, `summary`, `figure`,
  `figcaption`. Other elements are unwrapped (their text stays); `script`, `style`, `iframe`, `object`, `svg`, `math`,
  forms and their controls, media and head elements are dropped with their content. Nesting past 100 levels is unwrapped.
- Attributes: `class` (only the names below), `title`, `colspan`/`rowspan` on cells (1-1000), `alt` and `data-asset`
  on images, `href` on links (`http:`, `https:` or `mailto:` only). Every other attribute (`on*`, `style`, `id`,
  `target`, ...) is dropped.
- Classes, styled by `overlay/review.css` with the app's theme variables: `jira-panel` with `jira-panel-info`,
  `-note`, `-warning`, `-error`, `-success` (tinted panels); `card`, `card-header`, `meta` (a comment or a linked
  item: header row, muted meta text); `mention` (a chip); `status`, `lozenge`, `lozenge-info`, `-success`,
  `-warning`, `-error`; `new` (highlighted: new since last time) and `old` (struck out); `attachment-list` (a row of
  boxes); `fields` (a key/value table with narrow keys); `muted`.
- Links show where they go in the status line when clicked; they are not opened (a plugin page cannot open a URL
  outside the app, and the overlay frame may not navigate).
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
    <div class="card"><div class="card-header">${esc(issue.key)} <span class="lozenge lozenge-info">In progress</span>
      <span class="meta">updated ${esc(updated)}</span></div>
      <div class="jira-panel jira-panel-warning"><p>Only for logged-in users.</p></div>
      <p>Ask <span class="mention">@Ann Lee</span>.</p></div>
    <div class="card new"><div class="card-header">Bob <span class="meta">2 h ago</span></div><p>Still broken.</p></div>
    <ul class="attachment-list"><li><img src="asset:a1" alt="screenshot.png"></li></ul>`,
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
