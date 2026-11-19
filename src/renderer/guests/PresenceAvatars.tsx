import type { PresenceAvatar } from './presence-model'

/**
 * Small round avatars (initial letter, the person's presence colour, styles.css `.guest-avatar`), with a
 * typing marker; each carries its own tooltip. Hidden from assistive tech unless `labelled` (the guest
 * banner, which draws the names beside them): on a tab the label's aria-description says it in words.
 */
export function PresenceAvatars(props: { avatars: readonly PresenceAvatar[]; labelled?: boolean }): React.JSX.Element | null {
  if (props.avatars.length === 0) return null
  return (
    <span className="guest-avatars" aria-hidden={props.labelled ? undefined : 'true'}>
      {props.avatars.map((a) => (
        <span key={a.id} className="guest-person" title={a.title}>
          <span className="guest-avatar" aria-hidden="true" data-color={a.color} data-typing={a.typing || undefined} data-faded={a.faded || undefined}>
            {a.initial}
          </span>
          {props.labelled && <span className="guest-person-name">{a.typing ? `${a.name} (typing)` : a.name}</span>}
        </span>
      ))}
    </span>
  )
}
