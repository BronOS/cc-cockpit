// Playing the picked notification sound (shared/notify-sound.ts ids) in the window: a built-in is
// scheduled as tones (tones.ts); a system sound's bytes come from main (`notify.soundData`, which
// answers only for an id in its own fresh listing) and are decoded here, AIFF by aiff.ts since
// Chromium does not read it. A system sound that is gone, refused or undecodable rings the Chime
// instead and is logged once per id, so a deleted file neither silences reminders nor fills the log.
//
// Kept free of DOM types (PlayContext is the slice of an AudioContext this needs) so the unit tests
// run it under Node with a fake; chime.ts binds it to the real AudioContext and window.cockpit.
import { parseSoundId } from '../../shared/notify-sound'
import { decodeAiff, isAiff } from './aiff'
import { scheduleTone, TONES, type ToneContext, type ToneGain } from './tones'

/** What playing a decoded buffer needs; an AudioBuffer has it. */
export interface PlayBuffer {
  copyToChannel(source: Float32Array, channel: number): void
}

export interface PlaySource {
  buffer: PlayBuffer | null
  connect(node: unknown): unknown
  start(time?: number): void
}

export interface PlayContext extends ToneContext {
  resume(): Promise<void>
  decodeAudioData(data: ArrayBuffer): Promise<PlayBuffer>
  createBuffer(channels: number, length: number, sampleRate: number): PlayBuffer
  createBufferSource(): PlaySource
  createGain(): ToneGain
}

export interface SoundPlayerDeps {
  /** The page's one AudioContext, made on first use (a context holds an audio device open). Throws without audio. */
  context(): PlayContext
  /** Main's `notify.soundData`: the bytes of a listed system sound, or null. */
  fetchSystem(id: string): Promise<{ data: Uint8Array; type: string } | null>
  log(message: string, err?: unknown): void
}

/** A file sound plays a little below its own level: OS event sounds are mastered loud. */
const FILE_GAIN = 0.7

async function decode(ctx: PlayContext, bytes: Uint8Array): Promise<PlayBuffer> {
  if (isAiff(bytes)) {
    const pcm = decodeAiff(bytes)
    const buffer = ctx.createBuffer(pcm.channels.length, pcm.frames, pcm.sampleRate)
    pcm.channels.forEach((samples, channel) => buffer.copyToChannel(samples, channel))
    return buffer
  }
  // decodeAudioData takes (and detaches) a whole ArrayBuffer: hand it a copy of just these bytes.
  return ctx.decodeAudioData(bytes.slice().buffer)
}

export interface SoundPlayer {
  /** Play the sound with this id once. Never rejects: without audio the page stays silent. */
  play(id: string): Promise<void>
}

export function createSoundPlayer(deps: SoundPlayerDeps): SoundPlayer {
  const logged = new Set<string>()
  const once = (key: string, message: string, err?: unknown): void => {
    if (logged.has(key)) return
    logged.add(key)
    deps.log(message, err)
  }
  return {
    async play(id) {
      let ctx: PlayContext
      try {
        ctx = deps.context()
        // A context made while the page was hidden can start suspended; resume is a no-op otherwise.
        void ctx.resume().catch(() => {})
      } catch (err) {
        once('audio', 'notification sound: no audio output', err)
        return
      }
      const parsed = parseSoundId(id)
      if (parsed?.kind === 'system') {
        try {
          const got = await deps.fetchSystem(id)
          if (!got) throw new Error('the app no longer lists this sound file')
          const buffer = await decode(ctx, got.data)
          const source = ctx.createBufferSource()
          const gain = ctx.createGain()
          gain.gain.value = FILE_GAIN
          source.buffer = buffer
          source.connect(gain)
          gain.connect(ctx.destination)
          source.start()
          return
        } catch (err) {
          once(id, `notification sound ${id} could not be played; the Chime plays instead`, err)
        }
      }
      try {
        scheduleTone(ctx, TONES[parsed?.kind === 'builtin' ? parsed.name : 'chime'], ctx.currentTime + 0.01)
      } catch (err) {
        once('tone', 'notification sound failed', err)
      }
    }
  }
}
