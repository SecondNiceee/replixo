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
// WHY THE THRESHOLD IS MANUAL
// ---------------------------
// It used to adapt itself to the measured noise floor, which sounds clever but
// is impossible to explain in a UI: the user drags a slider and the gate quietly
// disagrees with it a second later. Now the threshold is exactly where the user
// put it — one absolute level on the same dBFS scale the settings meter draws —
// so the handle on the meter IS the cut-off line. Whatever sits left of the
// handle never leaves the machine.
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

// --- user-adjustable threshold --------------------------------------------
// `sensitivity` is 0..100 and means POSITION ON THE METER, not an abstract
// "strength": the settings UI maps -60..0 dBFS onto 0..100 and draws the mic
// level on that scale, so the same number is the gate's cut-off line.
//
//   0   — the gate never closes (everything passes).
//   ~20 — default: kills a keyboard, a fan and breathing.
//   50  — cuts anything quieter than -30 dBFS, i.e. half the bar.
//   100 — nothing gets through at all.
const METER_FLOOR_DB = -60
const DEFAULT_SENSITIVITY = 20

function clampSensitivity(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_SENSITIVITY
  return Math.min(100, Math.max(0, value))
}

/**
 * Open threshold in linear RMS for a meter position. Exactly the inverse of the
 * UI's dBFS → 0..100 mapping, which is what keeps the handle honest.
 * Position 0 returns 0: a gate that can never close.
 */
function openRmsFor(sensitivity) {
  const position = clampSensitivity(sensitivity)
  if (position <= 0) return 0
  const db = METER_FLOOR_DB - (METER_FLOOR_DB * position) / 100
  return Math.pow(10, db / 20)
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
    this.openThreshold = openRmsFor(this.sensitivity)
    // Metering is opt-in: nobody pays for postMessage traffic unless a meter is
    // actually visible somewhere in the UI.
    this.metering = initial.metering === true
    this.meterElapsedMs = 0
    this.meterPeak = 0

    // Envelope state (linear RMS).
    this.env = 0

    // Gate state.
    this.open = false
    this.gain = 1 // start open so the first syllable is never swallowed
    this.holdLeft = 0 // ms of hold remaining

    this.envAttack = onePoleCoef(ENV_ATTACK_MS, sampleRate)
    this.envRelease = onePoleCoef(ENV_RELEASE_MS, sampleRate)

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
          // Takes effect on the very next block: dragging the handle is meant to
          // be audible while the finger is still down.
          this.openThreshold = openRmsFor(this.sensitivity)
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
        this.report(Math.sqrt(sum / n), this.openThreshold)
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

    // --- threshold ---------------------------------------------------------
    // Exactly where the user dropped the handle. No adaptation, no surprises.
    const openThreshold = this.openThreshold
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
