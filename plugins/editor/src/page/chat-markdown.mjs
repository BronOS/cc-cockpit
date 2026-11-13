// Quick chat's answers as Markdown, with no HTML at any point: markdown-it parses the text into tokens
// (`html: false`, so raw HTML in an answer is plain text), and this file turns the tokens into a
// small tree of allow-listed tags and text that chat-editor.js builds with createElement and
// createTextNode. Nothing is ever assigned as innerHTML, so an answer that quotes file text (which
// may hold anything) can only ever show as text. Links are not followed: a link shows its text, with
// the address in a tooltip. Pure, so node:test runs it (test/page-chat.test.mjs).
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: false, typographer: false })

/** The block and inline tags a node may have; anything else becomes a plain span of its children. */
const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 's', 'a'])

/**
 * The tree of `text`: `{ tag: 'root', children }`, where a child is a string (text), `{ tag, children }`
 * (an allowed tag, a link with `title` its address), `{ tag: 'code', text }` (inline code),
 * `{ tag: 'pre', text, info }` (a code block; `info` its fence's info string), `{ tag: 'hr' }` or
 * `{ tag: 'br' }`.
 */
export function markdownTree(text) {
  const root = { tag: 'root', children: [] }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  const walk = (tokens) => {
    for (const t of tokens) {
      if (t.type === 'inline') {
        walk(t.children || [])
        continue
      }
      // A tight list's paragraphs are hidden: their text goes straight into the list item.
      if (t.hidden && t.nesting !== 0) continue
      if (t.nesting === 1) {
        const tag = TAGS.has(t.tag) ? t.tag : 'span'
        const node = { tag, children: [] }
        if (tag === 'a') {
          const href = t.attrGet('href')
          if (typeof href === 'string') node.title = href
        }
        top().children.push(node)
        stack.push(node)
      } else if (t.nesting === -1) {
        if (stack.length > 1) stack.pop()
      } else if (t.type === 'text' || t.type === 'html_inline' || t.type === 'html_block') {
        if (t.content) top().children.push(t.content)
      } else if (t.type === 'code_inline') {
        top().children.push({ tag: 'code', text: t.content })
      } else if (t.type === 'fence' || t.type === 'code_block') {
        top().children.push({ tag: 'pre', text: t.content.endsWith('\n') ? t.content.slice(0, -1) : t.content, info: (t.info || '').trim() })
      } else if (t.type === 'softbreak') {
        top().children.push('\n')
      } else if (t.type === 'hardbreak') {
        top().children.push({ tag: 'br' })
      } else if (t.type === 'hr') {
        top().children.push({ tag: 'hr' })
      } else if (t.type === 'image') {
        // No images: the alt text only (the page's CSP would block a remote one anyway).
        if (t.content) top().children.push(t.content)
      }
    }
  }
  walk(md.parse(typeof text === 'string' ? text : '', {}))
  return root
}
