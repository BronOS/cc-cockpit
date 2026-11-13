// Quick chat in the file tab (design-editor.md §4 "Quick chat"): Ctrl+K (Cmd+K on macOS) on a
// selection opens a chat docked under the editor; the host runs a read-only headless Claude for it
// (dist/lib/quick-chat.js) and streams the answer here, rendered as Markdown (chat-markdown.mjs).
// Follow-ups go to the same Claude; closing the chat (×, Esc) ends it.
//
// The chat is about its target: the selection when it opened (the cursor's line with none), marked in
// the editor and mapped through every later edit. A proposal (the answer's `replacement` block) is
// drawn as an inline diff: the lines it removes tinted in place, its new text in a block below with
// Accept and Reject. It is kept only while the target's text is exactly what Claude was asked about
// (chat.mjs proposalFits); any change to that text (the person typing, Claude's own write reloaded or
// merged) drops it, with a note. Accept is the person's edit (one undo step, autosave saves it);
// Claude never writes. The field is created per editor state, so a whole new buffer (load) has none:
// a proposal for a chat that lost its target is dropped.
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { chatTarget, contextAround, fitNewline, mapTarget, proposalFits, proposalLines } from './chat.mjs'
import { markdownTree } from './chat-markdown.mjs'

/** The chat's target `{ from, to }` (or null: no chat); a new target drops any proposal. */
export const setTarget = StateEffect.define()
/** A proposal `{ text, forText, info }` (info: chat.mjs proposalLines), or null to drop it. */
export const setProposal = StateEffect.define()
/** The proposal went into the buffer: the target is now its text `{ from, to }`. */
export const accepted = StateEffect.define()

const targetMark = Decoration.mark({ class: 'cc-chat-target' })
const targetLine = Decoration.line({ class: 'cc-chat-target-line' })
const oldLine = Decoration.line({ class: 'cc-chat-old' })

/** The proposal's new text, below the target, with Accept and Reject. */
class ProposalWidget extends WidgetType {
  constructor(proposal, handlers) {
    super()
    this.proposal = proposal
    this.handlers = handlers
  }

  eq(other) {
    return other.proposal.text === this.proposal.text && other.proposal.forText === this.proposal.forText
  }

  toDOM() {
    const box = document.createElement('div')
    box.className = 'cc-chat-proposal'
    const { lines, added } = this.proposal.info
    lines.forEach((line, i) => {
      const row = document.createElement('div')
      row.className = added.has(i) ? 'cc-chat-line cc-chat-added' : 'cc-chat-line'
      // An empty line keeps its height.
      row.textContent = line === '' ? '\u200b' : line
      box.append(row)
    })
    const actions = document.createElement('div')
    actions.className = 'cc-chat-actions'
    const make = (label, run, cls) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      if (cls) b.className = cls
      // mousedown would move the editor's selection first: the click is the button's alone.
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', run)
      return b
    }
    actions.append(make('Accept', () => this.handlers.accept(), 'cc-primary'), make('Reject', () => this.handlers.reject(), 'cc-ghost'))
    const label = document.createElement('span')
    label.className = 'cc-chat-label'
    label.textContent = "Claude's proposal"
    actions.append(label)
    box.append(actions)
    return box
  }

  ignoreEvent() {
    return true
  }
}

/** The decorations of the field's value: the target marked, or the proposal's inline diff. */
function decorate(state, target, proposal, handlers) {
  if (!target) return Decoration.none
  const doc = state.doc
  const ranges = []
  if (!proposal) {
    if (target.to > target.from) ranges.push(targetMark.range(target.from, target.to))
    else ranges.push(targetLine.range(doc.lineAt(target.from).from))
    return Decoration.set(ranges, true)
  }
  const first = doc.lineAt(target.from).number
  const last = doc.lineAt(target.to).number
  for (const i of proposal.info.removed) {
    const n = first + i
    if (n > last) continue
    ranges.push(oldLine.range(doc.line(n).from))
  }
  ranges.push(Decoration.widget({ widget: new ProposalWidget(proposal, handlers), block: true, side: 1 }).range(doc.line(last).to))
  return Decoration.set(ranges, true)
}

/**
 * The chat's state field: `{ target, proposal, dropped, deco }`. `dropped` is true on the one update
 * that dropped a proposal (its text no longer fits), so the chat can say so. `handlers` are the
 * proposal widget's Accept and Reject.
 */
export function createChatField(handlers) {
  return StateField.define({
    create: () => ({ target: null, proposal: null, dropped: false, deco: Decoration.none }),
    update(value, tr) {
      let { target, proposal } = value
      let changed = false
      if (target && tr.docChanged) {
        target = mapTarget(target, tr.changes)
        changed = true
      }
      for (const e of tr.effects) {
        if (e.is(setTarget)) {
          target = e.value
          proposal = null
          changed = true
        } else if (e.is(setProposal)) {
          proposal = e.value
          changed = true
        } else if (e.is(accepted)) {
          target = e.value
          proposal = null
          changed = true
        }
      }
      let dropped = false
      if (proposal && !proposalFits(tr.state.doc, target, proposal.forText)) {
        proposal = null
        dropped = true
        changed = true
      }
      if (!changed) return value.dropped ? { ...value, dropped: false } : value
      return { target, proposal, dropped, deco: decorate(tr.state, target, proposal, handlers) }
    },
    provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
  })
}

const STATUS = { starting: 'Starting Claude…', thinking: 'Thinking…', ready: '' }
const PROPOSAL_NOTE = {
  shown: 'Proposed change: shown in the editor.',
  dropped: 'Proposed change dropped: the selected text changed since it was asked about.',
  accepted: 'Proposed change accepted.',
  rejected: 'Proposed change rejected.',
  replaced: 'Replaced by a newer proposal.',
  same: 'The proposal is the text as it is: nothing to change.',
}

/**
 * The chat panel and its editor half. `post(m)` sends to the host, `getView()` is the editor (or
 * null), `message(text, error)` the language bar. Returns `{ extension, open, receive, connect }`:
 * `extension` goes into every editor state, `open` is Ctrl+K, `receive(m)` takes the host's `chat-*`
 * messages (true when it did), `connect` is a new line to the host (the old one's chat is gone).
 */
export function createQuickChat({ post, getView, message }) {
  const $ = (id) => document.getElementById(id)
  const handlers = { accept: () => accept(), reject: () => reject() }
  const field = createChatField(handlers)
  let chat = null
  let nextId = 0
  let drawPending = false

  const fieldOf = (view) => (view ? view.state.field(field, false) : undefined)
  const liveEntry = () => (chat ? chat.entries.findLast((e) => e.who === 'claude' && e.live) : undefined)
  const shownEntry = () => (chat ? chat.entries.findLast((e) => e.proposal && e.proposal.state === 'shown') : undefined)

  const extension = [
    field,
    EditorView.updateListener.of((u) => {
      const f = u.state.field(field, false)
      if (!f || !f.dropped) return
      const e = shownEntry()
      if (e) {
        e.proposal.state = 'dropped'
        draw()
      }
    }),
  ]

  function show() {
    $('chat').hidden = false
  }

  function open() {
    const view = getView()
    if (!view) return
    const t = chatTarget(view.state)
    if (t.error) {
      message(t.error, true)
      return
    }
    if (chat && !chat.ended) {
      // Ctrl+K again with no new selection (or the same one): back to the question box.
      const f = fieldOf(view)
      const same = f && f.target && f.target.from === t.from && f.target.to === t.to
      if (same || view.state.selection.main.empty) {
        show()
        $('chat-input').focus()
        return
      }
    }
    if (chat) end()
    chat = { id: ++nextId, started: false, ended: false, busy: false, seen: t.text, askedFor: null, entries: [], state: '', model: '', tool: '' }
    view.dispatch({ effects: setTarget.of({ from: t.from, to: t.to }) })
    $('chat-input').value = ''
    show()
    draw()
    $('chat-input').focus()
  }

  /** Ends the chat on this side: the host kills its Claude. */
  function end() {
    if (!chat) return
    if (chat.started && !chat.ended) post({ t: 'chat-close', id: chat.id })
    chat = null
  }

  function close() {
    end()
    $('chat').hidden = true
    const view = getView()
    if (view) {
      view.dispatch({ effects: setTarget.of(null) })
      view.focus()
    }
  }

  function send() {
    if (!chat || chat.ended || chat.busy) return
    const question = $('chat-input').value.trim()
    if (!question) return
    const view = getView()
    const f = fieldOf(view)
    const target = f && f.target
    const selOf = () => {
      const doc = view.state.doc
      return { startLine: doc.lineAt(target.from).number, endLine: doc.lineAt(target.to).number, text: doc.sliceString(target.from, target.to) }
    }
    if (!chat.started) {
      if (!target) {
        chat.ended = true
        chat.entries.push({ who: 'note', text: 'The file was loaded again, so the selection is gone: select the text again and press Ctrl+K.', error: true })
        draw()
        return
      }
      const sel = selOf()
      const { before, after } = contextAround(view.state.doc, target.from, target.to)
      post({ t: 'chat-start', id: chat.id, question, sel, before, after })
      chat.started = true
      chat.seen = sel.text
      chat.askedFor = sel.text
    } else {
      let sel
      if (target) {
        sel = selOf()
        // Claude already knows this text (it asked about it, or wrote it and the person accepted it).
        if (sel.text === chat.seen) sel = undefined
        else chat.seen = sel.text
        chat.askedFor = view.state.sliceDoc(target.from, target.to)
      } else {
        chat.askedFor = null
      }
      post({ t: 'chat-say', id: chat.id, question, ...(sel ? { sel } : {}) })
    }
    chat.entries.push({ who: 'you', text: question })
    chat.entries.push({ who: 'claude', text: '', tools: [], live: true })
    chat.busy = true
    chat.state = 'thinking'
    $('chat-input').value = ''
    draw()
  }

  function proposalArrived(entry, text) {
    const prev = shownEntry()
    if (prev) prev.proposal.state = 'replaced'
    entry.proposal = { state: 'shown' }
    const view = getView()
    const forText = chat.askedFor
    if (!view || forText === null || !fieldOf(view) || !fieldOf(view).target) {
      entry.proposal.state = 'dropped'
      if (view) view.dispatch({ effects: setProposal.of(null) })
      return
    }
    const fitted = fitNewline(forText, text)
    if (fitted === forText) {
      entry.proposal.state = 'same'
      view.dispatch({ effects: setProposal.of(null) })
      return
    }
    view.dispatch({ effects: setProposal.of({ text: fitted, forText, info: proposalLines(forText, fitted) }) })
    const f = fieldOf(view)
    if (!f.proposal) {
      // The target's text changed while Claude was answering: dropped at once (the listener saw no shown entry yet).
      entry.proposal.state = 'dropped'
      return
    }
    view.dispatch({ effects: EditorView.scrollIntoView(f.target.to, { y: 'nearest' }) })
  }

  function accept() {
    const view = getView()
    const f = fieldOf(view)
    if (!f || !f.proposal || !f.target) return
    if (view.state.readOnly) {
      message('The file is read-only here: the proposal cannot be applied.', true)
      return
    }
    const { from, to } = f.target
    const insert = f.proposal.text
    view.dispatch({ changes: { from, to, insert }, effects: accepted.of({ from, to: from + insert.length }), userEvent: 'input.chat', scrollIntoView: true })
    const e = shownEntry()
    if (e) e.proposal.state = 'accepted'
    // Claude wrote this text: a follow-up does not need it sent again.
    if (chat) chat.seen = insert
    view.focus()
    draw()
  }

  function reject() {
    const view = getView()
    if (view) view.dispatch({ effects: setProposal.of(null) })
    const e = shownEntry()
    if (e) e.proposal.state = 'rejected'
    draw()
  }

  function receive(m) {
    if (!m || typeof m !== 'object' || typeof m.t !== 'string' || !m.t.startsWith('chat-')) return false
    if (!chat || m.id !== chat.id) return true
    if (m.t === 'chat-state') {
      chat.state = m.state
      if (typeof m.model === 'string') chat.model = m.model
      if (m.state !== 'thinking') chat.tool = ''
    } else if (m.t === 'chat-delta') {
      const e = liveEntry()
      if (e && typeof m.text === 'string') e.text += m.text
      chat.tool = ''
    } else if (m.t === 'chat-tool') {
      const e = liveEntry()
      const line = `${m.name}${m.detail ? ` ${m.detail}` : ''}`
      if (e) e.tools.push(line)
      chat.tool = line
    } else if (m.t === 'chat-answer') {
      const e = liveEntry()
      if (e) {
        e.live = false
        e.text = typeof m.text === 'string' ? m.text : e.text
        e.error = m.error === true
        if (typeof m.proposal === 'string') proposalArrived(e, m.proposal)
      }
      chat.busy = false
    } else if (m.t === 'chat-end') {
      const e = liveEntry()
      if (e) {
        e.live = false
        if (!e.text && !e.tools.length) chat.entries.splice(chat.entries.indexOf(e), 1)
      }
      chat.ended = true
      chat.busy = false
      chat.state = ''
      chat.entries.push({ who: 'note', text: `${m.message || 'The chat ended.'}${m.error ? '' : ' Press Ctrl+K for a new one.'}`, error: m.error === true })
    }
    scheduleDraw()
    return true
  }

  function connect() {
    if (!chat || !chat.started || chat.ended) return
    // The host's side of this chat went with the old line (a host restart, a reconnect): its Claude was killed.
    chat.ended = true
    chat.busy = false
    const e = liveEntry()
    if (e) e.live = false
    chat.entries.push({ who: 'note', text: 'The connection to the editor was renewed, which ended this chat. Press Ctrl+K for a new one.', error: true })
    draw()
  }

  // ---- drawing ----

  function scheduleDraw() {
    if (drawPending) return
    drawPending = true
    requestAnimationFrame(() => {
      drawPending = false
      draw()
    })
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  /** The Markdown tree (chat-markdown.mjs) as elements; `proposal` is the entry's, drawn at its block. */
  function build(node, parent, entry, lastReplacement) {
    for (const c of node.children) {
      if (typeof c === 'string') parent.append(document.createTextNode(c))
      else if (c.tag === 'code') parent.append(el('code', null, c.text))
      else if (c.tag === 'pre') {
        if (c === lastReplacement && entry.proposal) parent.append(proposalCard(entry))
        const pre = el('pre', c === lastReplacement ? 'chat-replacement' : null)
        pre.append(el('code', null, c.text))
        parent.append(pre)
      } else if (c.tag === 'hr' || c.tag === 'br') parent.append(el(c.tag))
      else {
        const e = el(c.tag === 'a' ? 'span' : c.tag, c.tag === 'a' ? 'chat-link' : null)
        if (c.title) e.title = c.title
        build(c, e, entry, lastReplacement)
        parent.append(e)
      }
    }
  }

  function lastReplacementOf(node) {
    let found = null
    const walk = (n) => {
      for (const c of n.children || []) {
        if (typeof c === 'string') continue
        if (c.tag === 'pre' && c.info.toLowerCase() === 'replacement') found = c
        else walk(c)
      }
    }
    walk(node)
    return found
  }

  function proposalCard(entry) {
    const card = el('div', `chat-proposal ${entry.proposal.state}`)
    card.append(el('span', null, PROPOSAL_NOTE[entry.proposal.state] || ''))
    if (entry.proposal.state === 'shown') {
      const ok = el('button', 'cc-primary', 'Accept')
      ok.type = 'button'
      ok.addEventListener('click', accept)
      const no = el('button', 'cc-ghost', 'Reject')
      no.type = 'button'
      no.addEventListener('click', reject)
      card.append(ok, no)
    }
    return card
  }

  function draw() {
    const panel = $('chat')
    if (!chat) {
      $('chat-log').replaceChildren()
      return
    }
    const view = getView()
    const f = fieldOf(view)
    const about = $('chat-about')
    if (f && f.target) {
      const a = view.state.doc.lineAt(f.target.from).number
      const b = view.state.doc.lineAt(f.target.to).number
      about.textContent = a === b ? `line ${a}` : `lines ${a}-${b}`
    } else {
      about.textContent = chat.started ? '(the selection is gone)' : ''
    }
    $('chat-model').textContent = chat.model
    $('chat-status').textContent = chat.ended ? 'Ended' : chat.tool && chat.busy ? chat.tool : STATUS[chat.state] || ''
    const input = $('chat-input')
    input.disabled = chat.ended || chat.busy
    $('chat-send').disabled = chat.ended || chat.busy
    input.placeholder = chat.ended ? 'This chat has ended.' : chat.started ? 'A follow-up… (Enter sends, Shift+Enter a new line)' : 'Ask about the selection… (Enter sends, Shift+Enter a new line)'

    const log = $('chat-log')
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24
    const out = []
    for (const e of chat.entries) {
      if (e.who === 'you') out.push(el('div', 'chat-q', e.text))
      else if (e.who === 'note') out.push(el('div', e.error ? 'chat-note error' : 'chat-note', e.text))
      else {
        const box = el('div', e.error ? 'chat-a error' : 'chat-a')
        if (e.tools.length) {
          const tools = el('div', 'chat-tools')
          for (const t of e.tools.slice(-8)) tools.append(el('div', null, t))
          box.append(tools)
        }
        if (e.text) {
          const tree = markdownTree(e.text)
          build(tree, box, e, e.live ? null : lastReplacementOf(tree))
        } else if (e.live) box.append(el('div', 'chat-wait', '…'))
        out.push(box)
      }
    }
    log.replaceChildren(...out)
    if (atEnd) log.scrollTop = log.scrollHeight
    panel.dataset.state = chat.ended ? 'ended' : chat.busy ? 'busy' : 'ready'
  }

  // ---- the panel's own keys and buttons ----

  $('chat-close').addEventListener('click', close)
  $('chat-send').addEventListener('click', send)
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  $('chat').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    close()
  })

  return { extension, open, receive, connect, isOpen: () => !$('chat').hidden }
}
