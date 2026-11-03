// The notification sound the person picked (app setting "Sound", Settings › Appearance and keys ›
// Notifications; design §5 "Notifications"): the sound of every ctx.notify with `sound: true`. A
// plugin may also pass an id the person picked in its own settings form (`"format": "sound"`, design
// §6); it never names a file, and main checks that id with these same rules at every use.
//
// The stored value is an id, never a path:
//   builtin:<name>                  a tone the renderer makes with WebAudio (renderer/notify/tones.ts)
//   system:<root index>:<rel path>  an audio file under one of main's fixed OS sound folders
//                                   (main/notifications/system-sounds.ts), `/`-separated
// app.json is user-writable, so main reads a system id as a claim: it lists the folders again and
// serves bytes only for an id that is in that fresh listing. This file checks only the spelling.
//
// Kept free of Node and DOM imports: main, the renderer and the tests import it.

/** The built-in tones, in the order the dropdown lists them. The first is the default. */
export const BUILTIN_SOUNDS = [
  { name: 'chime', title: 'Chime' },
  { name: 'bell', title: 'Bell' },
  { name: 'ping', title: 'Ping' },
  { name: 'pop', title: 'Soft pop' },
  { name: 'two-tone', title: 'Two-tone' },
  { name: 'marimba', title: 'Marimba' }
] as const

export type BuiltinSoundName = (typeof BUILTIN_SOUNDS)[number]['name']

/** The Chime, which every notification with `sound` rang before the picker existed. */
export const DEFAULT_NOTIFY_SOUND = 'builtin:chime'

/** The audio file types main lists (lower case, with the dot). Chromium decodes all but AIFF, which the renderer reads itself. */
export const SYSTEM_SOUND_EXTENSIONS = ['.oga', '.ogg', '.wav', '.aiff', '.aif', '.mp3', '.flac'] as const
/** A larger file is not listed: a notification sound is a second long, and the bytes travel over IPC. */
export const MAX_SYSTEM_SOUND_BYTES = 2 * 1024 * 1024
/** At most this many system sounds over all folders, so a huge sound theme cannot flood the dropdown or the walk. */
export const MAX_SYSTEM_SOUNDS = 300
/** A longer id is refused before it is parsed (a hand-edited app.json, a renderer's or a plugin's request). */
export const MAX_SOUND_ID_LENGTH = 1024

/**
 * The value of a plugin settings field with `"format": "sound"` that means "the app's sound" (the
 * form's first entry, "App default"). Also what such a field's `default` may be, besides a built-in id.
 */
export const APP_DEFAULT_SOUND = ''

export type SoundId = { kind: 'builtin'; name: BuiltinSoundName } | { kind: 'system'; root: number; rel: string }

function isBuiltinName(name: string): name is BuiltinSoundName {
  return BUILTIN_SOUNDS.some((s) => s.name === name)
}

/**
 * The parts of a sound id, or null when it is not one this app could offer: an unknown built-in,
 * a root index that is not a small decimal, or a relative path that is empty, absolute, holds a
 * backslash, a `.`/`..` segment, an empty segment or a control character. Whether a system id's
 * file exists is main's question (system-sounds.ts), asked again at every use.
 */
export function parseSoundId(value: unknown): SoundId | null {
  if (typeof value !== 'string' || value.length > MAX_SOUND_ID_LENGTH) return null
  if (value.startsWith('builtin:')) {
    const name = value.slice('builtin:'.length)
    return isBuiltinName(name) ? { kind: 'builtin', name } : null
  }
  const m = /^system:(\d{1,2}):(.+)$/s.exec(value)
  if (!m) return null
  const rel = m[2] as string
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(rel) || rel.startsWith('/')) return null
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  return { kind: 'system', root: Number(m[1]), rel }
}

/**
 * The stored `notificationSound`, default applied: a well-spelled id stays (a system file that
 * went away is main's finding at the next use, and the person sees it as missing in Settings);
 * anything else (absent, damaged, an unknown built-in) reads as the Chime.
 */
export function notificationSoundOf(stored: unknown): string {
  return parseSoundId(stored) ? (stored as string) : DEFAULT_NOTIFY_SOUND
}

/**
 * Whether `value` may be the `default` of a `"format": "sound"` settings field: "" (App default) or
 * a built-in id. Never a system id: which OS sound files exist differs per machine.
 */
export function isSoundFieldDefault(value: unknown): boolean {
  return value === APP_DEFAULT_SOUND || parseSoundId(value)?.kind === 'builtin'
}

/** The id of a system sound: root index and a `/`-separated path under that root. */
export function systemSoundId(root: number, rel: string): string {
  return `system:${root}:${rel}`
}

/** The media type of a listed file, from its extension (lower case); `application/octet-stream` for anything else. */
export function soundMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  switch (ext) {
    case '.oga':
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.aiff':
    case '.aif':
      return 'audio/aiff'
    case '.mp3':
      return 'audio/mpeg'
    case '.flac':
      return 'audio/flac'
    default:
      return 'application/octet-stream'
  }
}
