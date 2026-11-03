// The built-in notification sounds (shared/notify-sound.ts BUILTIN_SOUNDS), made with WebAudio:
// no audio file and nothing fetched. Each is a few sine or triangle partials, each with a fast
// attack and an exponential fade to silence, at most ~1 s in all and quiet enough not to startle
// (peaks of about 0.1 of full scale; the partials of one sound add up to well under 0.3).
//
// Kept free of DOM types (ToneContext is the slice of an AudioContext this needs), so the unit
// tests drive it with a recording fake under Node.
import type { BuiltinSoundName } from '../../shared/notify-sound'

/** One partial: a pitch from `at` (s after the sound starts) that fades out by `at + length`. */
export interface TonePartial {
  hz: number
  /** Glide to this pitch over `glide` seconds (the soft pop's drop). */
  toHz?: number
  glide?: number
  at: number
  length: number
  /** Peak gain, 0..1 of full scale. */
  gain: number
  /** Seconds to the peak; default 0.015 (shorter clicks, longer sounds blurry). */
  attack?: number
  type?: 'sine' | 'triangle'
}

export const TONES: Readonly<Record<BuiltinSoundName, readonly TonePartial[]>> = {
  // The chime every notification rang before the picker: E6 then A6, ~0.45 s.
  chime: [
    { hz: 1318.5, at: 0, length: 0.22, gain: 0.12 },
    { hz: 1760, at: 0.12, length: 0.33, gain: 0.12 }
  ],
  // A small bell: A5 with the inharmonic partials of a struck bell, long fade.
  bell: [
    { hz: 880, at: 0, length: 0.9, gain: 0.09, attack: 0.005 },
    { hz: 1760, at: 0, length: 0.6, gain: 0.035, attack: 0.005 },
    { hz: 2428.8, at: 0, length: 0.4, gain: 0.025, attack: 0.005 },
    { hz: 4752, at: 0, length: 0.18, gain: 0.01, attack: 0.005 }
  ],
  // One high, short B6 with a faint octave.
  ping: [
    { hz: 1975.5, at: 0, length: 0.35, gain: 0.1, attack: 0.005 },
    { hz: 3951, at: 0, length: 0.12, gain: 0.015, attack: 0.005 }
  ],
  // A low bubble: a quick downward glide, gone in 0.15 s.
  pop: [
    { hz: 520, toHz: 260, glide: 0.07, at: 0, length: 0.14, gain: 0.14, attack: 0.004 },
    { hz: 1040, toHz: 520, glide: 0.05, at: 0, length: 0.08, gain: 0.03, attack: 0.004 }
  ],
  // A door chime's ding-dong: E5 then C5, triangle for a rounder tone.
  'two-tone': [
    { hz: 659.25, at: 0, length: 0.4, gain: 0.1, type: 'triangle' },
    { hz: 523.25, at: 0.25, length: 0.55, gain: 0.1, type: 'triangle' }
  ],
  // Two mallet strikes, A5 then E6: a bright fourth overtone that dies at once over a short body.
  marimba: [
    { hz: 880, at: 0, length: 0.35, gain: 0.11, attack: 0.003 },
    { hz: 3520, at: 0, length: 0.06, gain: 0.03, attack: 0.002 },
    { hz: 1318.5, at: 0.11, length: 0.35, gain: 0.11, attack: 0.003 },
    { hz: 5274, at: 0.11, length: 0.06, gain: 0.03, attack: 0.002 }
  ]
}

/** How long a sound lasts (s): its last partial's end. */
export function toneDuration(partials: readonly TonePartial[]): number {
  return Math.max(0, ...partials.map((p) => p.at + p.length))
}

export interface ToneParam {
  value: number
  setValueAtTime(value: number, time: number): unknown
  exponentialRampToValueAtTime(value: number, time: number): unknown
}

export interface ToneOscillator {
  type: string
  frequency: ToneParam
  connect(node: unknown): unknown
  start(time: number): void
  stop(time: number): void
}

export interface ToneGain {
  gain: ToneParam
  connect(node: unknown): unknown
}

/** The part of an AudioContext a tone needs. */
export interface ToneContext {
  currentTime: number
  destination: unknown
  createOscillator(): ToneOscillator
  createGain(): ToneGain
}

/** An exponential ramp cannot reach 0; this is silence for it. */
const SILENT = 0.0001

/** Schedule `partials` to start at `start` (the context's clock). Each oscillator stops itself. */
export function scheduleTone(ctx: ToneContext, partials: readonly TonePartial[], start: number): void {
  for (const p of partials) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = p.type ?? 'sine'
    const t0 = start + p.at
    osc.frequency.setValueAtTime(p.hz, t0)
    if (p.toHz !== undefined) osc.frequency.exponentialRampToValueAtTime(p.toHz, t0 + (p.glide ?? p.length))
    gain.gain.setValueAtTime(SILENT, t0)
    gain.gain.exponentialRampToValueAtTime(p.gain, t0 + (p.attack ?? 0.015))
    gain.gain.exponentialRampToValueAtTime(SILENT, t0 + p.length)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + p.length + 0.02)
  }
}
