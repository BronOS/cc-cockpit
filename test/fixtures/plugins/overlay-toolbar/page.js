/* global ccPanel */
// With `ready: 'manual'` the loader stays until this page calls ccPanel.ready(); the host sends
// { go: true } when the e2e says so (the page has loaded long before).
ccPanel.onMessage((message) => {
  if (message && message.go === true) ccPanel.ready()
})
