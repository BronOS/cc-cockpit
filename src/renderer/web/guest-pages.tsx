// The web client's guest pages (design-guests §10, D-32): an invite that did not work, an access
// that ended, a guest's close page; and the line a guest sees once its page is back after a role
// switch. Texts are guest-pages-model.ts's (DOM-free, unit-tested). None of these pages links to the
// project list or offers the owner's sign-in: a guest has neither (main answers 404 to both).

/** A whole page of plain text (the web-state look of the other sign-in pages), nothing to click. */
export function GuestStatePage({ text }: { text: string }): React.JSX.Element {
  return (
    <main className="web-state" role="alert">
      <div className="web-state-box">
        <p>{text}</p>
      </div>
    </main>
  )
}

/**
 * A dismissable line over the shell (the "host unreachable" bar's place and look): "<owner> made you
 * a write guest." after a role switch's reconnect. A status, not an alert: the shell is usable.
 */
export function GuestNotice({ text, onDismiss }: { text: string; onDismiss(): void }): React.JSX.Element {
  return (
    <div className="web-unreachable" role="status">
      <span>{text}</span>
      <button type="button" onClick={onDismiss}>
        OK
      </button>
    </div>
  )
}
