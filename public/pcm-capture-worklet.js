// Native WASAPI PCM -> Web Audio bridge. WASAPI and AudioContext use separate
// hardware clocks, so playback speed is adjusted slightly to keep the jitter
// buffer centred instead of eventually underrunning or overflowing.

const CHANNELS = 2
const INPUT_SAMPLE_RATE = 48000
const RING_FRAMES = INPUT_SAMPLE_RATE
const TARGET_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.1)
const START_FRAMES = TARGET_FRAMES
const MIN_RATE = 0.995
const MAX_RATE = 1.005
const PROPORTIONAL_GAIN = 0.004
const INTEGRAL_GAIN = 0.000002
const FADE_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.005)
const METRICS_INTERVAL_FRAMES = INPUT_SAMPLE_RATE * 5

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ring = [new Float32Array(RING_FRAMES), new Float32Array(RING_FRAMES)]
    this.writeIdx = 0
    this.readPosition = 0
    this.available = 0
    this.buffering = true
    this.gain = 0
    this.integral = 0
    this.readRate = 1
    this.underruns = 0
    this.overflows = 0
    this.reportedUnderruns = 0
    this.reportedOverflows = 0
    this.framesSinceMetrics = 0
    this.lastSample = [0, 0]
    this.stopped = false

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === "stop") {
        this.stopped = true
      } else if (data.samples) {
        this._enqueue(data.samples)
      }
    }
  }

  _enqueue(samples) {
    const frames = Math.floor(samples.length / CHANNELS)
    for (let i = 0; i < frames; i++) {
      this.ring[0][this.writeIdx] = samples[i * CHANNELS]
      this.ring[1][this.writeIdx] = samples[i * CHANNELS + 1]
      this.writeIdx = (this.writeIdx + 1) % RING_FRAMES

      if (this.available < RING_FRAMES - 1) {
        this.available++
      } else {
        // Drop the oldest frame but preserve the fractional cursor. Staying near
        // real-time is preferable to replaying stale system audio.
        this.readPosition = (this.readPosition + 1) % RING_FRAMES
        this.overflows++
      }
    }
  }

  _updateRate() {
    const normalizedError = (this.available - TARGET_FRAMES) / TARGET_FRAMES
    this.integral = Math.max(-1, Math.min(1, this.integral + normalizedError))
    const correction = normalizedError * PROPORTIONAL_GAIN + this.integral * INTEGRAL_GAIN
    this.readRate = Math.max(MIN_RATE, Math.min(MAX_RATE, 1 + correction))
  }

  _reportMetrics(frames) {
    this.framesSinceMetrics += frames
    if (this.framesSinceMetrics < METRICS_INTERVAL_FRAMES) return
    this.framesSinceMetrics = 0
    const hasNewFault = this.underruns !== this.reportedUnderruns || this.overflows !== this.reportedOverflows
    if (hasNewFault) {
      this.port.postMessage({
        type: "metrics",
        fillFrames: Math.round(this.available),
        readRate: this.readRate,
        underruns: this.underruns,
        overflows: this.overflows,
      })
      this.reportedUnderruns = this.underruns
      this.reportedOverflows = this.overflows
    }
  }

  process(_inputs, outputs) {
    if (this.stopped) return false
    const output = outputs[0]
    if (!output?.[0] || !output?.[1]) return true
    const frames = output[0].length

    if (this.buffering && this.available >= START_FRAMES) {
      this.buffering = false
      this.integral = 0
    }
    if (!this.buffering) this._updateRate()

    for (let i = 0; i < frames; i++) {
      if (!this.buffering && this.available >= 2) {
        const base = Math.floor(this.readPosition)
        const fraction = this.readPosition - base
        const next = (base + 1) % RING_FRAMES
        this.gain = Math.min(1, this.gain + 1 / FADE_FRAMES)
        for (let channel = 0; channel < CHANNELS; channel++) {
          const a = this.ring[channel][base]
          const sample = a + (this.ring[channel][next] - a) * fraction
          this.lastSample[channel] = sample
          output[channel][i] = sample * this.gain
        }

        this.readPosition += this.readRate
        if (this.readPosition >= RING_FRAMES) this.readPosition -= RING_FRAMES
        this.available -= this.readRate
      } else {
        if (!this.buffering) {
          this.buffering = true
          this.integral = 0
          this.underruns++
        }
        // Fade the final continuous sample to zero instead of making a waveform
        // discontinuity, which is perceived as a click/crackle.
        this.gain = Math.max(0, this.gain - 1 / FADE_FRAMES)
        output[0][i] = this.lastSample[0] * this.gain
        output[1][i] = this.lastSample[1] * this.gain
      }
    }

    this._reportMetrics(frames)
    return true
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor)
