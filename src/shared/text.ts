/** `text` cut to `max` characters, with an ellipsis after the cut (so at most `max + 1` long). */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
