// Fixture for test/e2e/reviewer-annotate.spec.ts: calls the bundled reviewer's annotate() in HTML
// mode with markup a sanitizer must strip (script, an onerror handler, a style block and attribute,
// a javascript: link, an iframe, a form, a remote image) next to what it must keep (a Jira panel, a
// mention, http links (one with an entity-encoded query), a table, an image from an asset). The command "html" records the outcome
// in $HOME/annotate-caller.json, which the test reads; the file is rewritten at activate, so the
// test can tell the host is up.
const fs = require('node:fs')
const path = require('node:path')

// A 2x2 red PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII='

// The details column: key fields as a facts list (vertical there), plus what the sanitizer must drop.
const ASIDE = `
<dl class="facts" style="display:grid" onclick="window.__pwned='aside'">
  <dt>Priority</dt><dd><span class="lozenge lozenge-danger">High</span></dd>
  <dt>Reporter</dt><dd><span class="person">Bob Stone</span></dd>
</dl>
<script>window.__pwned = 'aside script'</script>
<p>See <a href="https://example.atlassian.net/browse/PROJ-2">PROJ-2</a>.</p>
`

const HTML = `
<h1 id="global">Fix the login redirect</h1>
<script>window.__pwned = 'script'</script>
<style>body { display: none }</style>
<div class="jira-panel jira-panel-warning banner" style="position:fixed;inset:0" onclick="window.__pwned='click'">
  <p>Users land on <code>/home</code> after login.</p>
</div>
<p>Ask <span class="mention">@Ann Lee</span> about it, see <a href="javascript:window.__pwned='link'">this</a>
  and <a href="https://example.atlassian.net/browse/PROJ-1" target="_top">the issue</a>.</p>
<p>Attached: <a href="https://example.atlassian.net/secure/attachment/1/redirect-log.txt?a=1&amp;b=2">the redirect log of the second step</a></p>
<img src="x" onerror="window.__pwned='onerror'" alt="broken">
<iframe src="https://example.com"></iframe>
<form><input name="q" value="typed"></form>
<table><tr><th>Status</th><td colspan="2" onmouseover="x()">In progress</td></tr></table>
<dl class="facts"><dt>Status</dt><dd><span class="lozenge lozenge-info">In progress</span></dd><dt>Assignee</dt><dd><span class="person">Ann Lee</span></dd></dl>
<p>The redirect target is wrong in the second step.</p>
<figure><img src="asset:shot-1" alt="Screenshot of the bug"><figcaption>The bug</figcaption></figure>
<p><img src="asset:never-sent" alt="Missing picture"></p>
`

// The companion command: a mail with the issue it is about beside it (annotate's `companion`), each
// with its own facts; the issue is long, so its column scrolls while the mail's does not.
const MAIL = `
<div class="card"><h1>Re: the login redirect</h1></div>
<div class="card"><p>Is the redirect fixed in the second step yet?</p></div>
`
const MAIL_FACTS = '<dl class="facts"><dt>From</dt><dd><span class="person">Ann Lee</span></dd></dl>'
const ISSUE =
  '<div class="card"><h1>PROJ-1: Fix the login redirect</h1></div>' +
  '<p>Users land on the wrong page after the second step.</p>' +
  '<p>See <a href="https://example.atlassian.net/browse/PROJ-3">PROJ-3</a> too.</p>' +
  Array.from({ length: 80 }, (_, i) => `<p>Comment ${i + 1} on the issue.</p>`).join('') +
  '<p><img src="asset:issue-shot" alt="Issue screenshot"></p>'
// Four rows of facts beside the mail's one: the header cells must still be the same height.
const ISSUE_FACTS =
  '<dl class="facts"><dt>Status</dt><dd><span class="lozenge lozenge-info">In progress</span></dd>' +
  '<dt>Priority</dt><dd>High</dd><dt>Assignee</dt><dd><span class="person">Ann Lee</span></dd>' +
  '<dt>Reporter</dt><dd><span class="person">Bob Stone</span></dd><dt>Sprint</dt><dd>Sprint 7</dd>' +
  '<dt>Labels</dt><dd>login, redirect</dd><dt>Components</dt><dd>Auth</dd><dt>Fix version</dt><dd>2.0</dd></dl>'

// The original command (feature 'original'): a mail whose original HTML is a breakout attempt handed
// to the reviewer as is, with no sanitizer of a caller in front (the frame must hold on its own):
// script, event handlers, an SVG onload, CSS url() and @import to http, a meta refresh, a form, a
// javascript: link, a base href, a stylesheet link, an iframe. Next to it, what the Original view is
// for: a layout table with inline background colours, a struck-out old value, a picture from an
// asset, and a link (it must not navigate the frame). Every URL points at 127.0.0.1:9 (nothing
// listens there): the test records every request the app makes and expects none to it.
const EVIL = 'http://127.0.0.1:9'
const ORIGINAL = `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=${EVIL}/refresh">
<base href="${EVIL}/base/">
<link rel="stylesheet" href="${EVIL}/link.css">
<style>@import url(${EVIL}/import.css); .hero { background-image: url(${EVIL}/style-bg.png); } .old { color: #bf2600; text-decoration: line-through }</style>
<script>console.log('PWNED head script'); fetch('${EVIL}/script')</script>
</head><body style="background:#fff">
<script>console.log('PWNED body script')</script>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7"><tr><td class="hero" style="padding:12px;background:url(${EVIL}/inline-bg.png)">
<p id="designed">Status: <span class="old">To Do</span> <span style="background-color:#e3fcef;color:#006644">In Progress</span></p>
<p><a id="view" href="https://jira.example.com/browse/PROJ-7" style="display:inline-block;padding:20px">View issue</a></p>
<p><a id="js" href="javascript:console.log('PWNED link')">Run</a></p>
<img id="pic" data-asset="org-1" alt="Diagram" width="40" height="40">
<img src="${EVIL}/remote.png" onerror="console.log('PWNED onerror')" alt="remote">
<svg onload="console.log('PWNED svg')"><circle r="4"/></svg>
<form action="${EVIL}/form"><input name="q" value="typed"><button>Send</button></form>
<iframe src="${EVIL}/frame"></iframe>
</td></tr></table>
</body></html>`
const MAIL_HTML = `
<h1>[JIRA] PROJ-7 moved to In Progress</h1>
<div class="mail-msg"><div class="mail-head"><div class="mail-who">Jira</div></div>
<div class="mail-body" data-reader="m1"><p>Reader text: Status To Do, now In Progress.</p></div><div data-original="m1"></div></div>`

exports.activate = (ctx) => {
  const file = path.join(process.env.HOME, 'annotate-caller.json')
  const seen = { calls: [] }
  const save = () => fs.writeFileSync(file, JSON.stringify(seen))
  const reviewer = ctx.services.use('reviewer')
  ctx.commands.register('html', async () => {
    try {
      const r = await reviewer.annotate({
        title: 'PROJ-1 Fix the login redirect',
        html: HTML,
        aside: ASIDE,
        assets: [{ id: 'shot-1', name: 'shot.png', mime: 'image/png', dataUrl: PNG }],
        url: 'https://example.atlassian.net/browse/PROJ-1',
        key: 'jira:PROJ-1',
      })
      seen.calls.push({ ok: true, value: r })
    } catch (err) {
      seen.calls.push({ ok: false, error: String(err && err.message ? err.message : err) })
    }
    save()
  })
  ctx.commands.register('companion', async () => {
    try {
      const features = await reviewer.features()
      const r = await reviewer.annotate({
        title: 'Re: the login redirect',
        html: MAIL,
        aside: MAIL_FACTS,
        url: 'https://mail.example.com/thread/1',
        key: 'mail:1',
        label: 'Mail',
        urlLabel: 'Example Mail',
        companion: {
          title: 'PROJ-1: Fix the login redirect',
          label: 'Jira · PROJ-1',
          urlLabel: 'Jira',
          html: ISSUE,
          facts: ISSUE_FACTS,
          url: 'https://example.atlassian.net/browse/PROJ-1',
          assets: [{ id: 'issue-shot', name: 'issue.png', mime: 'image/png', dataUrl: PNG }],
        },
      })
      seen.calls.push({ ok: true, value: r, features })
    } catch (err) {
      seen.calls.push({ ok: false, error: String(err && err.message ? err.message : err) })
    }
    save()
  })
  ctx.commands.register('original', async () => {
    try {
      const r = await reviewer.annotate({
        title: '[JIRA] PROJ-7 moved to In Progress',
        kind: 'mail',
        html: MAIL_HTML,
        originals: [{ id: 'm1', html: ORIGINAL }],
        assets: [{ id: 'org-1', name: 'diagram.png', mime: 'image/png', dataUrl: PNG }],
        key: 'mail:original',
      })
      seen.calls.push({ ok: true, value: r })
    } catch (err) {
      seen.calls.push({ ok: false, error: String(err && err.message ? err.message : err) })
    }
    save()
  })
  // The Original | Reader switch of the page comes back as the service event `view`.
  seen.views = []
  if (typeof reviewer.on === 'function') reviewer.on('view', (d) => {
    seen.views.push(d)
    save()
  })
  // The well-known `file` type (design-next §3.3): the bundled editor adds "Edit" to the toolbar for
  // a text file of the project. `notes.txt` is made by the test.
  ctx.commands.register('filetype', async () => {
    try {
      const r = await reviewer.annotate({
        title: 'A file review',
        text: 'Some words to review.',
        key: 'file:notes',
        type: { name: 'file', data: { path: 'notes.txt' } },
      })
      seen.calls.push({ ok: true, value: r })
    } catch (err) {
      seen.calls.push({ ok: false, error: String(err && err.message ? err.message : err) })
    }
    save()
  })
  save()
}
