"use client"

// ---------------------------------------------------------------------------
// Short, pleasant UI notification sounds, synthesised with the Web Audio API.
//
// We synthesise tones instead of shipping audio files so the sounds are tiny,
// crisp and require no network fetch. Each "note" is a sine/triangle oscillator
// shaped by a quick attack + exponential decay envelope, which gives a soft
// bell/marimba-like timbre that feels gentle rather than harsh.
//
// The shared AudioContext (already unlocked on the first user gesture by
// audio-unlock) is reused so these sounds are not blocked by autoplay policy.
// ---------------------------------------------------------------------------

import { getSharedAudioContext } from "./audio-unlock"

type Wave = "sine" | "triangle"

interface Note {
  /** Frequency in Hz. */
  freq: number
  /** Start time offset (seconds) relative to the sound start. */
  at: number
  /** Note length in seconds. */
  duration: number
  /** Peak gain (0..1). Kept modest so notifications never startle. */
  gain?: number
  wave?: Wave
}

// Play a single enveloped note on the shared context.
function playNote(ctx: AudioContext, note: Note, startTime: number) {
  const { freq, at, duration, gain = 0.18, wave = "sine" } = note

  const osc = ctx.createOscillator()
  const env = ctx.createGain()

  osc.type = wave
  osc.frequency.setValueAtTime(freq, startTime + at)

  // Quick attack, smooth exponential decay — bell-like and soft.
  const t0 = startTime + at
  env.gain.setValueAtTime(0.0001, t0)
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.015)
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

  osc.connect(env)
  env.connect(ctx.destination)

  osc.start(t0)
  osc.stop(t0 + duration + 0.02)
}

// Play a sequence of notes as one short sound.
function playSequence(notes: Note[]) {
  const ctx = getSharedAudioContext()
  if (!ctx) return
  // Resume in case the context is suspended (no-op if already running).
  if (ctx.state === "suspended") ctx.resume().catch(() => {})
  const start = ctx.currentTime
  for (const note of notes) playNote(ctx, note, start)
}

// Pleasant rising two-note chime — welcoming. (~0.35s)
export function playJoinSound() {
  playSequence([
    { freq: 587.33, at: 0, duration: 0.18, wave: "sine" }, // D5
    { freq: 880.0, at: 0.09, duration: 0.28, wave: "sine", gain: 0.2 }, // A5
  ])
}

// Gentle falling two-note chime — a soft "goodbye". (~0.35s)
export function playLeaveSound() {
  playSequence([
    { freq: 783.99, at: 0, duration: 0.18, wave: "sine" }, // G5
    { freq: 523.25, at: 0.09, duration: 0.3, wave: "sine", gain: 0.16 }, // C5
  ])
}

// Bright little ascending arpeggio — signals screen share has started. (~0.4s)
export function playScreenShareSound() {
  playSequence([
    { freq: 659.25, at: 0, duration: 0.14, wave: "triangle" }, // E5
    { freq: 830.61, at: 0.08, duration: 0.14, wave: "triangle" }, // G#5
    { freq: 1046.5, at: 0.16, duration: 0.26, wave: "triangle", gain: 0.2 }, // C6
  ])
}
