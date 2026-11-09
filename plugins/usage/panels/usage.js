'use strict'
// The Usage panel page. It only draws: the host sends `usage` (the three ranges already summed by
// ccUsageView.summarize, the rate-limit rows, which sessions have a tab in this window); the page
// sends `hello` and `focus` (a session id). The range switch is the page's own (a glance, not
// stored). Project, model and session names come from transcripts: textContent only.

const V = ccUsageView
const T = V.T
const $ = (id) => document.getElementById(id)

let data = null
let range = 'today'

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function tokenMeta(t) {
  return `${V.count(V.tokens(t))} tokens · ${V.count(t[T.output])} out`
}

function row(title, meta, cost, opts = {}) {
  const li = el('li', 'cc-row')
  const main = el('div', 'cc-row-main')
  const titleEl = el('span', 'cc-row-title', title)
  if (opts.tooltip) li.title = opts.tooltip
  main.appendChild(titleEl)
  main.appendChild(el('span', 'cc-row-meta', meta))
  li.appendChild(main)
  if (opts.tag) li.appendChild(el('span', 'cc-badge blue open-tag', opts.tag))
  li.appendChild(el('span', 'cost', cost))
  return li
}

function emptyRow(text) {
  const li = el('li', 'cc-row')
  li.appendChild(el('span', 'cc-muted', text))
  return li
}

function drawTabs() {
  const tabs = $('tabs')
  tabs.replaceChildren(
    ...V.RANGES.map((r) => {
      const b = el('button', '', r.label)
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.dataset.range = r.id
      b.setAttribute('aria-selected', String(r.id === range))
      b.tabIndex = r.id === range ? 0 : -1
      b.addEventListener('click', () => {
        range = r.id
        render()
        tabs.querySelector(`[data-range="${r.id}"]`).focus()
      })
      return b
    })
  )
}

$('tabs').addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
  const i = V.RANGES.findIndex((r) => r.id === range)
  const next = V.RANGES[(i + (ev.key === 'ArrowRight' ? 1 : V.RANGES.length - 1)) % V.RANGES.length]
  range = next.id
  render()
  $('tabs').querySelector(`[data-range="${next.id}"]`).focus()
  ev.preventDefault()
})

function drawTotals(s) {
  const t = s.totals
  $('cost').textContent = V.costText(t)
  const parts = [
    ['Input', t[T.input]],
    ['Output', t[T.output]],
    ['Cache read', t[T.cacheRead]],
    ['Cache write 5m', t[T.cache5m]],
    ['Cache write 1h', t[T.cache1h]],
    ['Messages', t[T.messages]]
  ]
  $('tokens').replaceChildren(
    ...parts.map(([label, n]) => {
      const d = el('div')
      d.appendChild(el('dt', '', label))
      const dd = el('dd', '', V.count(n))
      dd.title = n.toLocaleString('en-US')
      d.appendChild(dd)
      return d
    })
  )
  const unpriced = $('unpriced')
  unpriced.hidden = !(t[T.unpriced] > 0)
  unpriced.textContent = t[T.unpriced] > 0 ? `Not in the amount: ${V.count(t[T.unpricedTokens])} tokens of models with no known price (${t[T.unpriced]} messages).` : ''
}

function drawLimits() {
  const box = $('limits')
  if (!data.rateLimitsAvailable || !data.rateLimits) {
    box.replaceChildren(el('div', 'cc-muted note', data.rateLimitsAvailable ? 'Rate limits: none reported yet. They come from a Claude tab\'s status line (Settings > General, "Rate limits from the status line"), in tabs started with it on.' : 'Rate limits: not available in this version of the app.'))
    return
  }
  const rows = data.rateLimits.rows.map((r) => {
    const d = el('div', 'limit')
    if (r.warn) d.dataset.warn = ''
    d.appendChild(el('span', '', r.label))
    d.appendChild(el('span', 'pct', `${r.percent}%`))
    const bar = el('span', 'bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-label', `${r.label} used`)
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-valuenow', String(r.percent))
    const fill = el('span')
    fill.style.width = `${r.percent}%`
    bar.appendChild(fill)
    d.appendChild(bar)
    if (r.resets) d.appendChild(el('span', 'cc-muted note', r.resets))
    return d
  })
  if (data.rateLimits.updated) rows.push(el('div', 'cc-muted note', `Reported ${data.rateLimits.updated}`))
  box.replaceChildren(...rows)
}

function render() {
  const ready = !!(data && data.ready)
  $('empty').hidden = ready
  $('content').hidden = !ready
  if (!ready) return
  drawTabs()
  const s = data.ranges[range]
  if (!s) return
  drawTotals(s)
  drawLimits()

  $('projects').replaceChildren(...(s.projects.length ? s.projects.map((p) => row(p.name, tokenMeta(p.t), V.costText(p.t), { tooltip: p.cwd })) : [emptyRow('No Claude work in this period.')]))
  $('models').replaceChildren(...(s.models.length ? s.models.map((m) => row(m.label, tokenMeta(m.t), V.costText(m.t), { tooltip: m.model })) : [emptyRow('No Claude work in this period.')]))

  const open = new Set(Array.isArray(data.open) ? data.open : [])
  $('sessions').replaceChildren(
    ...(s.sessions.length
      ? s.sessions.map((x) => {
          const isOpen = open.has(x.id)
          const li = row(x.title, `${x.name} · ${tokenMeta(x.t)}`, V.costText(x.t), {
            tooltip: `${x.title}\n${x.cwd}\n${x.id}${isOpen ? '\nOpen in this window: click to go to its tab' : ''}`,
            tag: isOpen ? 'open' : undefined
          })
          if (isOpen) {
            // A session whose tab is in this window selects it; others are only listed.
            li.dataset.open = ''
            li.tabIndex = 0
            li.setAttribute('role', 'button')
            const go = () => ccPanel.post({ type: 'focus', sessionId: x.id })
            li.addEventListener('click', go)
            li.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault()
                go()
              }
            })
          }
          return li
        })
      : [emptyRow('No sessions in this period.')])
  )

  const scope = data.scope === 'project' ? `Only work in ${data.project} is counted (the Projects counted setting).` : 'All projects are counted.'
  $('foot').textContent = `${scope} Amounts are what Anthropic's API would bill for these tokens (list prices of ${data.priceDate}); a subscription is not billed per token.`
}

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object' || m.type !== 'usage') return
  data = m
  render()
})

render()
ccPanel.post({ type: 'hello' })
