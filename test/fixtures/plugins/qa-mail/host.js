// QA (run 003 Verify): a Gmail-like opener. Its window announces kind `mail` with the ref QA-1, as Gmail does for a
// mail that names an issue, so Jira's listener may attach its part (design-parts.md §1-§2).
exports.activate = (ctx) => {
  ctx.commands.register('open', () => {
    const h = ctx.overlay.start({ kind: 'html', file: 'mail.html', title: 'QA mail about QA-1' })
    h.onConnect((from) => h.post({ text: 'Mail body: please look at QA-1.' }, { copy: from.copy }))
    h.onDiscuss(() => ({ text: 'Mail body: please look at QA-1.' }))
    if (typeof h.announce === 'function') h.announce({ kind: 'mail', refs: ['QA-1'] })
  })
}
