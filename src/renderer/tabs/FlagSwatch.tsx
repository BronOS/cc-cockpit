import type { FlagColor } from '../../shared/tab-flag'

/**
 * A flag's colour as a small round mark (the tab menu, All tabs, the Ctrl+Tab switcher). The colour
 * comes from `data-flag` in styles.css (`--cc-flag-<color>`), never from a style attribute, so only
 * the six theme tokens can ever be drawn.
 */
export function FlagSwatch(props: { color: FlagColor }): React.JSX.Element {
  return <span className="flag-swatch" data-flag={props.color} aria-hidden="true" />
}
