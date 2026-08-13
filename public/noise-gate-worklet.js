// ---------------------------------------------------------------------------
// Microphone Noise Gate (AudioWorklet)
//
// Problem: an open microphone transmits everything BETWEEN words — fan noise,
// hiss, a mechanical keyboard, the neighbour's dog, breathing right into the
// capsule. The browser's own `noiseSuppression` constraint only attenuates
// steady broadband noise; it never fully closes the channel, so a room with a
// noisy mic stays permanently "present" for everyone else.
//
// Fix: a classic noise gate. While the signal is below a threshold the output
// is muted outright (gain → 0); as soon as speech starts the gate opens and the
// voice passes through completely untouched. Speech is loud relative to a
// room's noise floor, so a gate is both cheap and far less damaging than any
// kind of spectral subtraction: nothing is ever filtered, only silenced.
//
//   mic ──▶ [this worklet] ──▶ MediaStreamDestination ──▶ published track
//
// WHY THE THRESHOLD IS ADAPTIVE
// -----------------------------
// A fixed threshold cannot work across setups: a condenser mic at high gain
// idles 25 dB louder than a headset. So we continuously track the noise FLOOR
// (a slow follower that falls fast and rises very slowly, i.e. it settles on
// the quietest recent level) and place the open threshold a fixed margin above
// it, never below an absolute minimum. On a quiet headset the gate stays at the
// absolute floor; on a noisy mic it lifts itself out of the noise automatically.
//
// SHAPE OF THE ENVELOPE (why hold + separate attack/release)
// ---------------------------------------------------------
//   • attack 4 ms   — fast enough that no syllable onset is clipped.
//   • hold 220 ms   — keeps the gate open through the short pauses inside a
//                     sentence, so it doesn't chatter between words.
//   • release 180 ms— fades out instead of chopping, which preserves the tail
//                     of a word and avoids an audible click.
//   • hysteresis    — closing needs 6 dB LESS than opening, so a signal sitting
//                     exactly at the threshold cannot flutter.
//
// Everything is per-sample ramped: gain is never assigned discontinuously,
// which is what makes a gate click.
//
// Graceful degradation: `enabled: false` (or any failure to load this module)
// leaves the signal passing through at unity gain, so the worst case is the
// previous behaviour — never silence.
// ---------------------------------------------------------------------------

const BLOCK = 128 // AudioWorklet render quantum

// --- user-adjustable strength ---------------------------------------------
// The UI exposes ONE slider ("Сила шумоподавления", 0..100) instead of the four
// numbers a gate really has, because those numbers are only meaningful
// together: a threshold without its floor margin says nothing about whether a
// whisper gets through. The slider therefore interpolates both.
//
//   0   — the gate barely ever closes (only true digital silence is cut).
//   50  — default: kills a keyboard and a fan, keeps normal speech.
//   100 — only clearly loud, close speech opens the channel.
//
// The absolute bound is interpolated GEOMETRICALLY (in dB), because loudness is
// perceived logarithmically — a linear sweep would spend 90% of the slider in a
// range the user cannot hear a difference in.
const MIN_ABSOLUTE_OPEN_RMS = 0.0006 // ≈ -64 dBFS
const MAX_ABSOLUTE_OPEN_RMS = 0.02 // ≈ -34 dBFS
const MIN_FLOOR_MARGIN = 1.6 // ≈ +4 dB above the measured noise floor
const MAX_FLOOR_MARGIN = 9 // ≈ +19 dB
const DEFAULT_SENSITIVITY = 50

function clampSensitivity(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_SENSITIVITY
  return Math.min(100, Math.max(0, value))
}

// Absolute lower bound for the open threshold, in linear RMS. Below this we're
// in the noise of the ADC itself; opening on it would defeat the whole point.
function absoluteOpenRms(sensitivity) {
  const t = clampSensitivity(sensitivity) / 100
  return MIN_ABSOLUTE_OPEN_RMS * Math.pow(MAX_ABSOLUTE_OPEN_RMS / MIN_ABSOLUTE_OPEN_RMS, t)
}

// How far above the measured noise floor the gate opens (linear multiplier).
function floorMargin(sensitivity) {
  const t = clampSensitivity(sensitivity) / 100
  return MIN_FLOOR_MARGIN + (MAX_FLOOR_MARGIN - MIN_FLOOR_MARGIN) * t
}

// How often the processor reports its level to the main thread while a meter is
// actually on screen. ~50 ms is smooth to the eye and ~20 messages/s at most.
const LEVEL_REPORT_MS = 50

// Closing needs the signal to drop this much below the open threshold (-6 dB).
const HYSTERESIS = 0.5

const ATTACK_MS = 4
const RELEASE_MS = 180
const HOLD_MS = 220

// Envelope follower time constants (on the per-block RMS).
const ENV_ATTACK_MS = 5
const ENV_RELEASE_MS = 60

// Noise-floor follower. Falls quickly towards a new quiet level, rises very
// slowly — so a long silence re-measures the floor within a second, while
// sustained speech barely lifts it.
const FLOOR_FALL = 0.3
const FLOOR_RISE_MS = 4000

function onePoleCoef(ms, sampleRate) {
  const samples = (ms / 1000) * sampleRate
  if (samples <= 0) return 1
  return 1 - Math.exp(-BLOCK / samples)
}

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const initial = options?.processorOptions ?? {}

    this.enabled = initial.enabled !== false
    this.sensitivity = clampSensitivity(initial.sensitivity)
    this.absoluteOpen = absoluteOpenRms(this.sensitivity)
    this.margin = floorMargin(this.sensitivity)
    // Metering is opt-in: nobody pays for postMessage traffic unless a meter is
    // actually visible somewhere in the UI.
    this.metering = initial.metering === true
    this.meterElapsedMs = 0
    this.meterPeak = 0

    // Envelope + floor state (linear RMS).
    this.env = 0
    this.floor = this.absoluteOpen

    // Gate state.
    this.open = false
    this.gain = 1 // start open so the first syllable is never swallowed
    this.holdLeft = 0 // ms of hold remaining

    this.envAttack = onePoleCoef(ENV_ATTACK_MS, sampleRate)
    this.envRelease = onePoleCoef(ENV_RELEASE_MS, sampleRate)
    this.floorRise = onePoleCoef(FLOOR_RISE_MS, sampleRate)

    // Per-sample gain increments.
    this.attackStep = 1 / Math.max(1, (ATTACK_MS / 1000) * sampleRate)
    this.releaseStep = 1 / Math.max(1, (RELEASE_MS / 1000) * sampleRate)

    this.blockMs = (BLOCK / sampleRate) * 1000
    this.stopped = false

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === "config") {
        if (typeof data.enabled === "boolean") {
          this.enabled = data.enabled
          if (!this.enabled) {
            // Re-open immediately: a disabled gate must never hold the channel
            // shut while it fades back to unity.
            this.open = true
            this.holdLeft = HOLD_MS
          }
        }
        if (typeof data.sensitivity === "number") {
          this.sensitivity = clampSensitivity(data.sensitivity)
          this.absoluteOpen = absoluteOpenRms(this.sensitivity)
          this.margin = floorMargin(this.sensitivity)
          // Dragging the slider must not leave the gate stuck shut on a floor
          // measured under the old settings: re-seat it at the new bound and let
          // the follower settle again within a second.
          if (this.floor < this.absoluteOpen) this.floor = this.absoluteOpen
        }
        if (typeof data.metering === "boolean") {
          this.metering = data.metering
          this.meterElapsedMs = 0
          this.meterPeak = 0
        }
      } else if (data.type === "stop") {
        this.stopped = true
      }
    }
  }

  // Report the loudest RMS seen since the last report, together with the
  // threshold it is being compared against. The UI draws both on one bar, so a
  // user can see *why* the gate is closing instead of guessing at a number.
  report(rms, threshold) {
    if (!this.metering) return
    if (rms > this.meterPeak) this.meterPeak = rms
    this.meterElapsedMs += this.blockMs
    if (this.meterElapsedMs < LEVEL_REPORT_MS) return
    this.meterElapsedMs = 0
    const peak = this.meterPeak
    this.meterPeak = 0
    this.port.postMessage({
      type: "level",
      rms: peak,
      threshold,
      open: this.enabled ? this.open : true,
      gain: this.gain,
    })
  }

  process(inputs, outputs) {
    if (this.stopped) return false

    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const inChannel = input && input.length > 0 ? input[0] : null

    // No input connected yet (or the source is between tracks): emit silence
    // but keep the processor alive.
    if (!inChannel || inChannel.length === 0) {
      for (let c = 0; c < output.length; c++) output[c].fill(0)
      return true
    }

    const outChannel = output[0]
    const n = inChannel.length

    if (!this.enabled) {
      // Pure pass-through — cheapest possible path when the user turns the gate
      // off, and it keeps `this.gain` at unity for a clean re-enable.
      this.gain = 1
      outChannel.set(inChannel)
      for (let c = 1; c < output.length; c++) output[c].set(inChannel)
      // The meter must keep working with the gate off — that's how the user
      // compares "with" and "without" — so measure the level even here, but
      // only while someone is watching.
      if (this.metering) {
        let sum = 0
        for (let i = 0; i < n; i++) sum += inChannel[i] * inChannel[i]
        this.report(Math.sqrt(sum / n), this.absoluteOpen)
      }
      return true
    }

    // --- level measurement -------------------------------------------------
    let sumSquares = 0
    for (let i = 0; i < n; i++) sumSquares += inChannel[i] * inChannel[i]
    const rms = Math.sqrt(sumSquares / n)

    this.env =
      rms > this.env
        ? this.env + (rms - this.env) * this.envAttack
        : this.env + (rms - this.env) * this.envRelease

    // --- adaptive noise floor ---------------------------------------------
    // Only track the floor while the gate is CLOSED. Tracking during speech
    // would let a long monologue drag the floor (and therefore the threshold)
    // upward until the gate started cutting the speaker off.
    if (!this.open) {
      this.floor =
        this.env < this.floor
          ? this.floor + (this.env - this.floor) * FLOOR_FALL
          : this.floor + (this.env - this.floor) * this.floorRise
    }

    const openThreshold = Math.max(this.absoluteOpen, this.floor * this.margin)
    const closeThreshold = openThreshold * HYSTERESIS
    this.report(rms, openThreshold)

    // --- gate state machine ------------------------------------------------
    if (this.env >= openThreshold) {
      this.open = true
      this.holdLeft = HOLD_MS
    } else if (this.open && this.env < closeThreshold) {
      this.holdLeft -= this.blockMs
      if (this.holdLeft <= 0) this.open = false
    }

    // --- per-sample ramped gain -------------------------------------------
    const target = this.open ? 1 : 0
    const step = this.open ? this.attackStep : this.releaseStep
    let gain = this.gain

    for (let i = 0; i < n; i++) {
      if (gain < target) gain = Math.min(target, gain + step)
      else if (gain > target) gain = Math.max(target, gain - step)
      outChannel[i] = inChannel[i] * gain
    }
    this.gain = gain

    // Mirror to any extra output channels (we request mono, but be safe).
    for (let c = 1; c < output.length; c++) output[c].set(outChannel)

    return true
  }
}

registerProcessor("mic-noise-gate", NoiseGateProcessor)
