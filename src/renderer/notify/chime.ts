// The notification sound (a plugin's ctx.notify with `sound`; main/notifications/notifier.ts says
// why the app plays its own instead of relying on the OS sound). Main decides whether it rings (the
// "Notification sounds" setting, one per window per 5 s) and which (the "Sound" setting), and sends
// `notify.chime` with the id; this page only plays it (sound-player.ts: built-in tones, or a system
// file's bytes from main). Electron's default autoplay policy needs no user gesture, so a window in
// the background plays it too. One AudioContext per page, made on the first sound.
import { createSoundPlayer, type PlayContext } from './sound-player'

let context: AudioContext | undefined

const player = createSoundPlayer({
  context: () => (context ??= new AudioContext()) as unknown as PlayContext,
  fetchSystem: (id) => window.cockpit.invoke('notify.soundData', { id }),
  log: (message, err) => console.warn(message, err)
})

/** Play the sound with this id once (the chime, the Play button in Settings). Never rejects. */
export function playNotificationSound(id: string): Promise<void> {
  return player.play(id)
}

/** Play the sound whenever main asks (`notify.chime`). Once per page, from main.tsx. */
export function startChime(): void {
  window.cockpit.on('notify.chime', ({ sound }) => void playNotificationSound(sound))
}
