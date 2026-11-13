// Line breaks of the file tab page (design-editor.md §2 "Line endings ... are kept").
//
// The host hands the page a CRLF file as LF (lib/files.js decodeBytes, put back at save), but only
// when EVERY line ends in CRLF: a mixed file, a lone `\r` break or a stray `\r` inside a line keeps
// its `\r` in the text. CodeMirror by default splits a document on `\r\n`, `\r` and `\n` and joins its
// lines with `\n`, so such a buffer never equalled the base: the tab was dirty right after loading,
// and the first autosave wrote every CRLF and lone CR back as LF with no edit from the person. With
// `\n` as the one separator a `\r` stays in its line (shown as a special character), the buffer is
// the file's text exactly, and session.mjs, merge.mjs and the save all see what the disk holds.
//
// Pasted or dropped text still breaks lines on `\r\n` and `\r` (a Windows clipboard): turned into
// `\n` first, as CodeMirror's default would, so a paste never brings a `\r` into an LF file.

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** Pasted or dropped text with every `\r\n` and lone `\r` made `\n`. */
export function pastedText(text) {
  return text.replace(/\r\n?/g, '\n')
}

/** The extensions: `\n` the only line separator, and the paste filter. */
export const keepLineBreaks = [EditorState.lineSeparator.of('\n'), EditorView.clipboardInputFilter.of(pastedText)]
