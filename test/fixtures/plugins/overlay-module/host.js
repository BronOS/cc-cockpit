// Bundled reviewer/editor plan Task 6 fixture: does an html overlay page run module scripts? The
// page loads `main.js` as `<script type="module">`, which imports `./dep.js` statically and
// `./lazy.js` with a dynamic import(), then answers with what both gave. The result goes out
// through ctx.notify (the e2e reads the recorded notifications).
exports.activate = (ctx) => {
  ctx.commands.register('open', () => {
    ctx.overlay
      .open({ kind: 'html', file: 'page.html', title: 'Module' })
      .then((result) => ctx.notify(`module ${JSON.stringify(result)}`))
      .catch((err) => ctx.notify(`module failed: ${err.message}`))
  })
}
