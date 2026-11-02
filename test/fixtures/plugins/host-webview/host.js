// Fixture plugin for webview panels (plan B Tasks 7-8): one `"kind": "webview"` panel driven
// through `ccc wv …` (`wv show [panel]` is ctx.panels.show), and one html panel next to it.
// Relative file paths resolve against the caller's cwd here, as ctx.webview.navigate takes
// absolute paths only.
const path = require('node:path')

exports.activate = (ctx) => {
  ctx.webview.onNavigate('view', (page) => ctx.log.info(`navigated ${page.url} ${page.title}`))
  ctx.cli.register('wv', async (argv, call) => {
    const [sub, target] = argv
    if (sub === 'open') {
      const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(target ?? '')
      await ctx.webview.navigate('view', isUrl ? target : path.resolve(call.cwd, target ?? ''))
      return { stdout: 'ok\n' }
    }
    if (sub === 'show') {
      ctx.panels.show(target ?? 'view')
      return { stdout: 'ok\n' }
    }
    if (sub === 'current') return { stdout: `${JSON.stringify(await ctx.webview.current('view'))}\n` }
    if (sub === 'back' || sub === 'forward' || sub === 'reload') {
      await ctx.webview[sub]('view')
      return { stdout: 'ok\n' }
    }
    return { stderr: `unknown: ${sub}\n`, code: 2 }
  })
}
