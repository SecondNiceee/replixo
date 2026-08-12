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
    { freq: 523.25, at: 0, duration: 0.09, wave: "triangle", gain: 0.55 }, // C5
    { freq: 659.25, at: 0.07, duration: 0.09, wave: "triangle", gain: 0.65 }, // E5
    { freq: 987.77, at: 0.14, duration: 0.22, wave: "triangle", gain: 0.75 }, // B5
  ])
}

// Quick descending three-note "blip" — a cheeky little "bye". (~0.3s)
export function playLeaveSound() {
  playSequence([
    { freq: 880.0, at: 0, duration: 0.09, wave: "triangle", gain: 0.65 }, // A5
    { freq: 659.25, at: 0.07, duration: 0.09, wave: "triangle", gain: 0.55 }, // E5
    { freq: 440.0, at: 0.14, duration: 0.24, wave: "sine", gain: 0.55 }, // A4
  ])
}

// Snappy ascending arpeggio — signals demonstration has STARTED. (~0.35s)
export function playScreenShareSound() {
  playSequence([
    { freq: 659.25, at: 0, duration: 0.08, wave: "triangle", gain: 0.65 }, // E5
    { freq: 880.0, at: 0.06, duration: 0.08, wave: "triangle", gain: 0.7 }, // A5
    { freq: 1318.51, at: 0.12, duration: 0.24, wave: "triangle", gain: 0.75 }, // E6
  ])
}

// Soft two-note chime — a gentle "ping" for an incoming chat message. (~0.25s)
export function playMessageSound() {
  playSequence([
    { freq: 784.0, at: 0, duration: 0.08, wave: "sine", gain: 0.5 }, // G5
    { freq: 1046.5, at: 0.07, duration: 0.2, wave: "sine", gain: 0.6 }, // C6
  ])
}

// Two-note knock, a touch lower and softer than the room-chat ping so a direct
// message is distinguishable from a message in the current call. (~0.3s)
export function playIncomingMessage() {
  playSequence([
    { freq: 587.33, at: 0, duration: 0.09, wave: "sine", gain: 0.45 }, // D5
    { freq: 880.0, at: 0.08, duration: 0.22, wave: "sine", gain: 0.55 }, // A5
  ])
}

// Мягкий двухнотный аккорд для события дружбы (заявка / её принятие). Тише и
// «круглее» сообщения, чтобы социальные события не путались со новыми письмами.
export function playFriendEvent() {
  playSequence([
    { freq: 659.25, at: 0, duration: 0.1, wave: "sine", gain: 0.4 }, // E5
    { freq: 987.77, at: 0.09, duration: 0.24, wave: "sine", gain: 0.45 }, // B5
  ])
}

// Входящий звонок: короткая трель, повторяемая до ответа.
//
// В отличие от остальных звуков это НЕ одиночное событие: пользователь может
// смотреть в другое окно, и один «динь» он пропустит. Поэтому мотив играется по
// кругу, а вызывающий обязан остановить его возвращённой функцией — иначе
// интервал переживёт закрытие вызова и будет звенеть в пустоту.
const RINGTONE_PERIOD_MS = 2400

function playRingtoneMotif() {
  playSequence([
    { freq: 880.0, at: 0, duration: 0.16, wave: "triangle", gain: 0.5 }, // A5
    { freq: 1108.73, at: 0.18, duration: 0.16, wave: "triangle", gain: 0.5 }, // C#6
    { freq: 880.0, at: 0.42, duration: 0.16, wave: "triangle", gain: 0.45 }, // A5
    { freq: 1108.73, at: 0.6, duration: 0.28, wave: "triangle", gain: 0.45 }, // C#6
  ])
}

export function startRingtone(): () => void {
  playRingtoneMotif()
  const timer = setInterval(playRingtoneMotif, RINGTONE_PERIOD_MS)
  return () => clearInterval(timer)
}

// Исходящий звонок завершился без разговора: отклонили, не ответили, отменили.
// Нисходящая пара нот — «не сложилось», без драматизма. (~0.3s)
export function playCallEnded() {
  playSequence([
    { freq: 587.33, at: 0, duration: 0.1, wave: "sine", gain: 0.4 }, // D5
    { freq: 392.0, at: 0.1, duration: 0.26, wave: "sine", gain: 0.4 }, // G4
  ])
}

// Snappy descending arpeggio — signals demonstration has STOPPED. (~0.35s)
export function playScreenShareStopSound() {
  playSequence([
    { freq: 1046.5, at: 0, duration: 0.08, wave: "triangle", gain: 0.7 }, // C6
    { freq: 783.99, at: 0.06, duration: 0.08, wave: "triangle", gain: 0.65 }, // G5
    { freq: 523.25, at: 0.12, duration: 0.24, wave: "sine", gain: 0.55 }, // C5
  ])
}
