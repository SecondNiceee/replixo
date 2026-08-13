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

// Absolute lower bound for the open threshold, in linear RMS (~ -52 dBFS).
// Below this we're in the noise of the ADC itself; opening on it would defeat
// the whole point.
const ABSOLUTE_OPEN_RMS = 0.0025

// How far above the measured noise floor the gate opens (linear multiplier).
// 4x ≈ 12 dB — comfortably above hiss/fan, well below speech.
const FLOOR_MARGIN = 4

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

    // Envelope + floor state (linear RMS).
    this.env = 0
    this.floor = ABSOLUTE_OPEN_RMS

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
      if (data.type === "config" && typeof data.enabled === "boolean") {
        this.enabled = data.enabled
        if (!this.enabled) {
          // Re-open immediately: a disabled gate must never hold the channel
          // shut while it fades back to unity.
          this.open = true
          this.holdLeft = HOLD_MS
        }
      } else if (data.type === "stop") {
        this.stopped = true
      }
    }
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

    const openThreshold = Math.max(ABSOLUTE_OPEN_RMS, this.floor * FLOOR_MARGIN)
    const closeThreshold = openThreshold * HYSTERESIS

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
