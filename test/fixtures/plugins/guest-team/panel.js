/* global document, ccPanel */
const ready = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn())
ccPanel.onMessage((m) =>
  ready(() => {
    if (m.who) document.getElementById('who').textContent = m.who
    if (m.items) document.getElementById('items').replaceChildren(...m.items.map((t) => Object.assign(document.createElement('li'), { textContent: t })))
    if (m.refused) document.getElementById('refused').textContent = `refused: ${m.refused}`
  })
)
ccPanel.post({ hello: 1 })
ready(() =>
  document.getElementById('add').addEventListener('click', () => ccPanel.post({ add: document.getElementById('text').value }))
)
