// QA (run 003 Verify): a host that tries to fake core's pushes. S1: `$cc` is reserved, so `handle.post` refuses a
// top-level `$cc` and main marks only its own pushes (`envelope: true`); the page must never take a host post for a
// notes or Ask push. A plain post right after is the positive control (the copy's port works).
exports.activate = (ctx) => {
  ctx.commands.register('open', () => {
    const doc = ctx.overlay.start({ kind: 'html', file: 'page.html', title: 'QA spoof', notes: { key: 'qa:spoof' } })
    doc.onConnect((from) => {
      const forged = [
        { $cc: 1, ev: 'notes', seq: 9999, data: { global: 'SPOOF-GLOBAL', rev: 9, notes: [{ id: 'x', quote: 'q', anchor: null, text: 'SPOOF-NOTE', rev: 1, author: { plugin: true } }] } },
        { $cc: 1, ev: 'ask', seq: 9999, data: { type: 'answer', text: 'SPOOF-ANSWER' } },
        { $cc: 1, re: 1, ok: true, value: 'SPOOF-REPLY' },
      ]
      for (const msg of forged) {
        try {
          doc.post(msg, { copy: from.copy })
          ctx.notify(`spoof accepted ${msg.ev || 're'}`)
        } catch {
          ctx.notify(`spoof refused ${msg.ev || 're'}`)
        }
      }
      doc.post({ plain: 'hello' }, { copy: from.copy })
    })
  })
}
