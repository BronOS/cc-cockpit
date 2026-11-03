// The notification sound dropdown's options and its Play button's behaviour, shared by the app
// setting "Sound" (AppearancePage NotificationSoundRow) and a plugin settings field with
// `"format": "sound"` (plugin-form-templates.tsx SoundWidget), so both offer the same list: the
// built-ins, then a group per OS sound folder as main lists them now (names only, never a path).
import { useRef } from 'react'
import type { NotificationSoundGroup } from '../../shared/ipc'
import { APP_DEFAULT_SOUND, BUILTIN_SOUNDS, parseSoundId } from '../../shared/notify-sound'
import { playNotificationSound } from '../notify/chime'

/** Module level, so useLoaded sees one function. */
export const loadSoundGroups = (): Promise<NotificationSoundGroup[]> => window.cockpit.invoke('settings.notificationSoundOptions')

/** Until main answers (or if it fails) the built-ins are known here; the system folders are not. */
const BUILTIN_GROUP: NotificationSoundGroup = {
  label: 'Built-in',
  sounds: BUILTIN_SOUNDS.map((s) => ({ id: `builtin:${s.name}`, name: s.title }))
}

/** A second click on Play within this long is the same click (a double click plays once). */
const PLAY_DEBOUNCE_MS = 400

/**
 * The <option>s of a sound <select>. `appDefault` puts "App default" (stored as "") first, for a
 * plugin's field. A value that is not listed keeps an option of its own, so the select does not
 * silently show another sound: a system file that went away, or an id this app does not know (a
 * hand-edited settings file); either rings the app's sound meanwhile.
 */
export function SoundOptions(props: {
  value: string
  groups: NotificationSoundGroup[] | null
  appDefault?: boolean
}): React.JSX.Element {
  const groups = props.groups ?? [BUILTIN_GROUP]
  const listed =
    (props.appDefault === true && props.value === APP_DEFAULT_SOUND) ||
    groups.some((g) => g.sounds.some((s) => s.id === props.value))
  const unlisted = !props.groups
    ? 'Loading…'
    : parseSoundId(props.value)?.kind === 'system'
      ? 'Missing sound file'
      : 'Unknown sound'
  return (
    <>
      {!listed && <option value={props.value}>{unlisted}</option>}
      {props.appDefault === true && <option value={APP_DEFAULT_SOUND}>App default</option>}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.sounds.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}

/**
 * Play a sound once for a Play button: at once, not throttled like a notification, but a double
 * click plays once. "" (App default) plays the app setting's sound, read from main at the click.
 */
export function usePlaySound(): (id: string) => void {
  const last = useRef(0)
  return (id) => {
    const now = Date.now()
    if (now - last.current < PLAY_DEBOUNCE_MS) return
    last.current = now
    if (id !== APP_DEFAULT_SOUND) {
      void playNotificationSound(id)
      return
    }
    window.cockpit.invoke('settings.appearance').then(
      (view) => playNotificationSound(view.notificationSound),
      (err: unknown) => console.warn('notification sound: the app setting could not be read', err)
    )
  }
}
