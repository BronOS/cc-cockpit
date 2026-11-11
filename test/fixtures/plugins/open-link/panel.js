/* global document, ccPanel */
// Open link: the person's click (user activation in this frame and its ancestors) asks at once.
// Open later: the same click, but the ask goes 6 s later, past Chrome's 5 s activation lifespan, so it
// arrives as a link nobody just clicked for. (Not a Playwright evaluate: that runs as a user gesture.)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('open').addEventListener('click', () => ccPanel.post({ open: 'a' }))
  document.getElementById('later').addEventListener('click', () => setTimeout(() => ccPanel.post({ open: 'b' }), 6000))
})
