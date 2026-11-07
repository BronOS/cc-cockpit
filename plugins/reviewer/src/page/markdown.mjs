// A markdown file's Rendered view: markdown-it turns the text into HTML, and the page then treats
// that HTML exactly like annotate's HTML mode (review.js renderHtml): parsed inert with DOMParser,
// walked by sanitize.mjs's allow-list into plain data, rebuilt with createElement. So the file's
// author (any repo, any branch Claude checked out) gets no more than a mail does.
//
// `html: false`: raw HTML in the markdown (`<script>`, `<img onerror>`, `<iframe>`) is escaped by
// markdown-it and shows as text, so even the sanitizer never sees it as markup. Images keep their
// alt text only: sanitize.mjs gives an <img> no src unless it names a host-sent asset, and the page
// CSP would block a project file or a remote URL anyway. Links stay links; a click on one goes
// through the host, which opens only an http(s) URL that is in the file's text (review.textLinks).
//
// Pure (a string in, a string out), so test/markdown.test.js runs it under node.
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })

// Each block markdown-it renders carries its source lines as `data-md-lines="first-last"` (1-based,
// inclusive; markdown-it's `map` is 0-based with an exclusive end). The sanitizer keeps exactly that
// attribute (sanitize.mjs), and a note on the rendered text then names the lines its selection
// spans (review.js mdLinesOf), as a note in the Source view does.
// A list's map runs to the blank line after it: blank lines at the end are not part of the block.
md.core.ruler.push('md_lines', (state) => {
  const lines = state.src.split('\n')
  for (const t of state.tokens) {
    if (!t.map || t.nesting === -1) continue
    let end = t.map[1]
    while (end > t.map[0] + 1 && !(lines[end - 1] || '').trim()) end--
    t.attrSet('data-md-lines', `${t.map[0] + 1}-${Math.max(t.map[0] + 1, end)}`)
  }
})

/** The HTML of a markdown text (to be sanitized by the caller, never inserted as is). */
export function markdownHtml(text) {
  return md.render(typeof text === 'string' ? text : '')
}

/**
 * The view a markdown file opens in: 'source' when it has a real diff to look at (both sides there
 * and different), else 'rendered' (no git, unchanged, a new file, a deleted one).
 */
export function initialMarkdownView(sides) {
  const changed = sides.mode === 'diff' && !sides.oldMissing && !sides.newMissing && sides.old !== sides.new
  return changed ? 'source' : 'rendered'
}

/** The text the Rendered view shows: the working tree's, or the last commit's for a deleted file. */
export const markdownText = (sides) => (sides.newMissing ? sides.old : sides.new)
