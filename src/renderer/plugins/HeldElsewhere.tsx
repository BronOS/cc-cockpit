/**
 * In place of a page that lives in one view at a time and is open in another one (design-web.md
 * §5.4: an html overlay's page, a plugin settings page): which device has it, and "Take over",
 * which moves it here (it loads here as on a reload, and the other view shows this in its place).
 * `device` is a browser's own text (its device name): plain text in React, never markup.
 */
export function HeldElsewhere(props: { device: string; onTakeOver: () => void; className?: string }): React.JSX.Element {
  return (
    <div className={`held-elsewhere${props.className ? ` ${props.className}` : ''}`} role="status" data-testid="held-elsewhere">
      <span className="held-elsewhere-text">Open on {props.device}</span>
      <button type="button" className="held-elsewhere-take" onClick={props.onTakeOver}>
        Take over
      </button>
    </div>
  )
}
