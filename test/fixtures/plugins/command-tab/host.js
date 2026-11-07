// ctx.sessions.openCommand fixture (test/e2e/plugin-command-tab.spec.ts). `open` starts a command tab
// whose argv carries a word with a space as one positional argument: the shell prints `hello-x y`
// only when the argv reached it as is (no shell in between to split it), then waits so the tab
// stays open. The outcome (the tab id or the error) is told through ctx.notify.
exports.activate = (ctx) => {
  ctx.commands.register('open', async () => {
    try {
      const { tabId } = await ctx.sessions.openCommand({
        argv: ['sh', '-c', 'echo "hello-$1"; sleep 30', 'sh', 'x y'],
        title: 'Hello',
        focus: true
      })
      ctx.notify(`opened ${tabId}`)
    } catch (err) {
      ctx.notify(`failed ${err && err.message}`)
    }
  })
}
