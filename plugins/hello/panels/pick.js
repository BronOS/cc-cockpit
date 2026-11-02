/* global document, ccPanel */
// In an html overlay `post({ result })` is special: it closes the overlay and `ctx.overlay.open`
// resolves with `{ kind: 'value', value: <result> }`.
document.addEventListener('DOMContentLoaded', () => {
  for (const button of document.querySelectorAll('button[data-colour]')) {
    button.addEventListener('click', () => ccPanel.post({ result: { colour: button.dataset.colour } }))
  }
})
