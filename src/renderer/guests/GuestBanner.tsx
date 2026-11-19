import type { GuestHint } from '../shell-kind'
import { PresenceAvatars } from './PresenceAvatars'
import { bannerText, otherPeople } from './presence-model'
import { usePresence } from './use-guests'

/**
 * A guest view's banner in the top bar (design-guests §10, spec-review 24): "Guest · read-only — Host's
 * cc-cockpit", then who else is here (presence, filtered for this guest by main). It stands where the
 * owner's "+" is; TopStrip draws no "+", gear, web access chip or Close project for a guest. The
 * role and the owner's name come from the shell's hint (WebSnapshot.guest): text only, a hint.
 */
export function GuestBanner(props: { guest: GuestHint }): React.JSX.Element {
  const presence = usePresence()
  const people = otherPeople(presence, props.guest.id)
  return (
    <div className="guest-banner" data-role={props.guest.role} data-testid="guest-banner">
      <span className="guest-banner-text">{bannerText(props.guest.role, props.guest.ownerName)}</span>
      {people.length > 0 && (
        <span className="guest-banner-people" aria-label="Also here">
          <PresenceAvatars avatars={people} labelled />
        </span>
      )}
    </div>
  )
}
