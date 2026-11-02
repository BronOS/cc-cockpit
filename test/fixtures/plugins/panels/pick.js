/* global document, ccPanel */
document.getElementById('pick').addEventListener('click', () => ccPanel.post({ result: { picked: 'b' } }))
