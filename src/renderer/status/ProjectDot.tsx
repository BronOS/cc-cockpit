import type { ProjectColor } from '../../shared/project-color'
import { projectColorCss, projectColorName } from '../../shared/project-color'

/**
 * A project's colour as a small dot (styles.css `.project-dot`): by the project's name in the title
 * bar, in other windows' strip entries and in the picker rows. Nothing at all for a project with
 * no colour, so a row without one keeps its old spacing.
 *
 * Decorative by default (aria-hidden): in a strip entry or a picker row the dot sits inside a
 * button whose accessible name is the project's name (specs and screen readers find it by that),
 * and an extra word would change it. `announce` makes it an image named "Colour: Blue" where it is
 * not inside such a control (the title bar's project chip).
 */
export function ProjectDot(props: { color: ProjectColor | undefined; announce?: boolean }): React.JSX.Element | null {
  if (props.color === undefined) return null
  // Inline, as a style property set by React (CSSOM, allowed by the page's CSP): a palette colour
  // is its theme token, so a theme switch re-colours the dot; a custom one is the stored hex, which
  // main checked to be exactly `#rrggbb` (nothing else can reach this style).
  const style = { background: projectColorCss(props.color) }
  return props.announce === true ? (
    <span className="project-dot" role="img" aria-label={`Colour: ${projectColorName(props.color)}`} style={style} />
  ) : (
    <span className="project-dot" aria-hidden="true" style={style} />
  )
}
