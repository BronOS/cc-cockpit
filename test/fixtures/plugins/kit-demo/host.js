// The overlay kit's demo (task 06): a perView, guests.aware plugin whose page uses every kit component, its host
// the kit's makePage. Its own vendored copy of the kit is in kit/ (test/unit/kit-build.test.ts keeps the bytes equal
// to cc-cockpit's kit/). Open: a document with notes; Open failing: the error state with Try again.
const { makePage } = require('./kit/host/shared-page.js')

const DOC_HTML =
  '<h1>DEMO-1: The quick brown fox</h1>' +
  '<p><span class="lozenge lozenge-success">Done</span> <span class="person">Ann</span></p>' +
  '<dl class="facts"><dt>Status</dt><dd>Done</dd><dt>Link</dt><dd><a href="https://example.com/demo-1">example.com/demo-1</a></dd></dl>' +
  '<p>The quick brown fox jumps over the lazy dog. Select a phrase to note it or ask about it.</p>'
const ORIGINAL_HTML = '<style>.card{border:1px solid #ccc;padding:8px}</style><div class="card"><b>DEMO-1</b> moved to <s>To Do</s> Done</div>'
const TEXT = 'DEMO-1: The quick brown fox. Done. The quick brown fox jumps over the lazy dog.'

exports.activate = (ctx) => {
  const open = (failing) => {
    const handle = ctx.overlay.start({ kind: 'html', file: 'demo.html', title: 'Kit demo', notes: { key: 'demo:DEMO-1' } })
    const page = makePage(handle, {
      ctx,
      // A guest never gets the original's raw HTML (an example of a projection).
      project: (state, from) => (from.access === 'owner' ? state : { ...state, original: null }),
      tabs: { ids: ['details', 'ask'], first: 'ask' },
    })
    handle.onDiscuss(() => ({ text: TEXT }))
    if (typeof handle.onAsk === 'function') handle.onAsk(() => ({ text: TEXT }))
    const fill = () => page.set({ html: DOC_HTML, original: ORIGINAL_HTML, about: 'About: DEMO-1' }, { document: DOC_HTML })
    if (failing) page.fail('The demo failed on purpose.', { retry: fill })
    else fill()
    page.onMessage((m, from) => ctx.notify(`heard ${JSON.stringify(m)} from ${from.access}`))
    handle.result.then(() => page.dispose(), () => page.dispose())
  }
  ctx.commands.register('open', () => open(false))
  ctx.commands.register('fail', () => open(true))
}
