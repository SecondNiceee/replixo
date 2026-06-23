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
import { useRoomSettingsStore } from "@/stores/room-settings-store"

/** Returns the current sound volume as a 0..1 multiplier. */
function getSoundGainMultiplier(): number {
  // Read directly from the store state (no hook needed — pure function call).
  const { soundVolume } = useRoomSettingsStore.getState()
  return soundVolume / 100
}

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
function playNote(ctx: AudioContext, note: Note, startTime: number, volumeMultiplier: number) {
  const { freq, at, duration, gain = 0.18, wave = "sine" } = note
  const effectiveGain = gain * volumeMultiplier
  if (effectiveGain <= 0) return

  const osc = ctx.createOscillator()
  const env = ctx.createGain()

  osc.type = wave
  osc.frequency.setValueAtTime(freq, startTime + at)

  // Quick attack, smooth exponential decay — bell-like and soft.
  const t0 = startTime + at
  env.gain.setValueAtTime(0.0001, t0)
  env.gain.exponentialRampToValueAtTime(effectiveGain, t0 + 0.015)
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
  const volumeMultiplier = getSoundGainMultiplier()
  if (volumeMultiplier <= 0) return
  // Resume in case the context is suspended (no-op if already running).
  if (ctx.state === "suspended") ctx.resume().catch(() => {})
  const start = ctx.currentTime
  for (const note of notes) playNote(ctx, note, start, volumeMultiplier)
}

// Bouncy three-note "pop" — playful and welcoming. (~0.3s)
export function playJoinSound() {
  playSequence([
    { freq: 523.25, at: 0, duration: 0.09, wave: "triangle", gain: 0.16 }, // C5
    { freq: 659.25, at: 0.07, duration: 0.09, wave: "triangle", gain: 0.18 }, // E5
    { freq: 987.77, at: 0.14, duration: 0.22, wave: "triangle", gain: 0.22 }, // B5
  ])
}

// Quick descending three-note "blip" — a cheeky little "bye". (~0.3s)
export function playLeaveSound() {
  playSequence([
    { freq: 880.0, at: 0, duration: 0.09, wave: "triangle", gain: 0.18 }, // A5
    { freq: 659.25, at: 0.07, duration: 0.09, wave: "triangle", gain: 0.16 }, // E5
    { freq: 440.0, at: 0.14, duration: 0.24, wave: "sine", gain: 0.16 }, // A4
  ])
}

// Snappy ascending arpeggio — signals demonstration has STARTED. (~0.35s)
export function playScreenShareSound() {
  playSequence([
    { freq: 659.25, at: 0, duration: 0.08, wave: "triangle", gain: 0.18 }, // E5
    { freq: 880.0, at: 0.06, duration: 0.08, wave: "triangle", gain: 0.2 }, // A5
    { freq: 1318.51, at: 0.12, duration: 0.24, wave: "triangle", gain: 0.22 }, // E6
  ])
}

// Soft two-note chime — a gentle "ping" for an incoming chat message. (~0.25s)
// Deliberately quiet and short so it never startles during a call.
export function playMessageSound() {
  playSequence([
    { freq: 784.0, at: 0, duration: 0.08, wave: "sine", gain: 0.14 }, // G5
    { freq: 1046.5, at: 0.07, duration: 0.2, wave: "sine", gain: 0.16 }, // C6
  ])
}

// Snappy descending arpeggio — signals demonstration has STOPPED. (~0.35s)
export function playScreenShareStopSound() {
  playSequence([
    { freq: 1046.5, at: 0, duration: 0.08, wave: "triangle", gain: 0.2 }, // C6
    { freq: 783.99, at: 0.06, duration: 0.08, wave: "triangle", gain: 0.18 }, // G5
    { freq: 523.25, at: 0.12, duration: 0.24, wave: "sine", gain: 0.16 }, // C5
  ])
}
