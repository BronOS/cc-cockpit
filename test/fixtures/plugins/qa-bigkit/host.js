// QA (run 003 Verify) copy of the kit demo: the same page and vendored kit, a host that sends a state of a chosen size
// (many chunks to a browser view: does the copy settle or reload in a loop?), links with target=_blank in the
// document and the Original frame, and a failure whose text names a host path (never shown to a guest). Every connect
// is counted in a notification, so a spec can see a reload loop.
const { makePage } = require('./kit/host/shared-page.js')

const LINKS =
  '<h1>BIG-1: links</h1>' +
  '<p><a id="plain" href="https://example.com/plain">plain link</a> and ' +
  '<a id="blank" href="https://example.com/blank" target="_blank">blank link</a></p>'
const ORIGINAL = '<div><a href="https://example.com/original" target="_blank">original blank link</a> and <a href="https://example.com/original-plain">original plain</a></div>'

exports.activate = (ctx) => {
  let connects = 0
  const open = (bytes, failPath) => {
    const handle = ctx.overlay.start({ kind: 'html', file: 'demo.html', title: 'QA big kit', notes: { key: 'qa:big-1' } })
    const page = makePage(handle, { ctx, tabs: { ids: ['details', 'ask'], first: 'details' } })
    handle.onDiscuss(() => ({ text: 'BIG-1' }))
    if (typeof handle.onAsk === 'function') handle.onAsk(() => ({ text: 'BIG-1' }))
    if (typeof handle.onConnect === 'function') handle.onConnect((from) => ctx.notify(`connect ${++connects} ${from.access}`))
    if (failPath) {
      page.fail(`ENOENT: no such file, open '${failPath}'`, { retry: () => {} })
      return
    }
    let html = LINKS
    if (bytes > 0) {
      const para = '<p>' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(16) + '</p>'
      html += para.repeat(Math.ceil(bytes / para.length))
    }
    page.set({ html, original: ORIGINAL, about: 'About: BIG-1' }, { document: 'BIG-1 links' })
    handle.result.then(() => page.dispose(), () => page.dispose())
  }
  ctx.commands.register('open', () => open(0))
  ctx.commands.register('open10', () => open(10 * 1024 * 1024))
  ctx.commands.register('open36', () => open(36 * 1024 * 1024))
  ctx.commands.register('failpath', () => open(0, '/home/owner/private/project/.env'))
}
