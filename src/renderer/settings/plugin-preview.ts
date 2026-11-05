// The pure part of a plugin card's preview (design-next §6.1): what the placeholder shows and which
// image a card asks for. Plain TypeScript, so vitest (plain Node) tests it without a DOM.

/** Where a card's preview comes from: a listing's checked bytes from main, or an installed plugin's own file. */
export type PreviewSource =
  | { kind: 'listing'; indexUrl: string; id: string }
  | { kind: 'own'; id: string }

/**
 * The placeholder's letter: the name's first character (a whole code point, so an emoji or a letter
 * outside the BMP is not cut in half), upper-cased; `?` for a blank name. The name is an index's text,
 * shown as React text only.
 */
export function previewInitial(name: string): string {
  const first = [...name.trim()][0]
  return first === undefined ? '?' : first.toLocaleUpperCase()
}

/**
 * An installed plugin's own `preview.png`, served by the plugin protocol from its folder. The id passed
 * main's manifest check (`PLUGIN_ID_PATTERN`: lowercase letters, digits, `.`, `-`), so it is a valid
 * host as it stands, built the way plugin-protocol.ts builds its own URLs.
 */
export function ownPreviewUrl(id: string): string {
  return `cc-plugin://${id}/preview.png`
}
