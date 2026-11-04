/* global document, ccPanel */
// The page of a slot: asks its provider's host (ping), shows the answer (who answered, the placement's
// params as the provider saw them) and what the page knows about being a slot (ccPanel.slot).
const show = (id, text) => {
  document.getElementById(id).textContent = text
}
ccPanel.onMessage((message) => {
  show('who', String(message.from))
  show('params', JSON.stringify(message.params === undefined ? null : message.params))
  show('slot', ccPanel.slot ? ccPanel.slot.type : 'not a slot')
})
// Posted before the port has arrived: the SDK queues it.
ccPanel.post({ ping: 1 })
