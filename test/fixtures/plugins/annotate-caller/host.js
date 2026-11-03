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
  save()
}
