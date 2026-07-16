// Native WASAPI PCM -> Web Audio bridge. WASAPI, Electron IPC, and Web Audio
// run on separate clocks, so this worklet absorbs scheduling jitter and applies
// a very small adaptive read-rate correction.

const CHANNELS = 2
const INPUT_SAMPLE_RATE = 48000
const RING_FRAMES = INPUT_SAMPLE_RATE * 2
const TARGET_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.16)
const START_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.12)
const RECOVERY_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.14)
const MAX_FILL_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.5)
const MIN_RATE = 0.99
const MAX_RATE = 1.01
const PROPORTIONAL_GAIN = 0.006
const INTEGRAL_GAIN = 0.000004
const FADE_FRAMES = Math.round(INPUT_SAMPLE_RATE * 0.008)
const METRICS_INTERVAL_FRAMES = INPUT_SAMPLE_RATE * 5
const EMERGENCY_SAMPLE_LIMIT = 1.25

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ring = [new Float32Array(RING_FRAMES), new Float32Array(RING_FRAMES)]
    this.writeFrame = 0
    this.readPosition = 0
    this.buffering = true
    this.readySent = false
    this.gain = 0
    this.integral = 0
    this.readRate = 1
    this.underruns = 0
    this.overflows = 0
    this.invalidSamples = 0
    this.resets = 0
    this.reportedFaults = "0:0:0:0"
    this.framesSinceMetrics = 0
    this.lastSample = [0, 0]
    this.stopped = false

    this.port.onmessage = (event) => {
      const data = event.data
      if (!data) return
      if (data.type === "stop" || data.type === "end") {
        this.stopped = true
      } else if (data.type === "reset") {
        this._reset(true)
      } else if (data.samples) {
        this._enqueue(data.samples)
      }
    }
  }

  _fillFrames() {
    return Math.max(0, this.writeFrame - this.readPosition)
  }

  _reset(countFault) {
    this.readPosition = this.writeFrame
    this.buffering = true
    this.gain = 0
    this.integral = 0
    this.readRate = 1
    this.lastSample[0] = 0
    this.lastSample[1] = 0
    if (countFault) this.resets++
  }

  _recoverToLiveEdge() {
    this.readPosition = Math.max(0, this.writeFrame - RECOVERY_FRAMES)
    this.buffering = true
    this.gain = 0
    this.integral = 0
    this.readRate = 1
  }

  _sanitize(sample) {
    if (!Number.isFinite(sample)) {
      this.invalidSamples++
      return 0
    }
    if (sample > EMERGENCY_SAMPLE_LIMIT) {
      this.invalidSamples++
      return EMERGENCY_SAMPLE_LIMIT
    }
    if (sample < -EMERGENCY_SAMPLE_LIMIT) {
      this.invalidSamples++
      return -EMERGENCY_SAMPLE_LIMIT
    }
    return sample
  }

  _enqueue(samples) {
    const frames = Math.floor(samples.length / CHANNELS)
    for (let i = 0; i < frames; i++) {
      const index = this.writeFrame % RING_FRAMES
      this.ring[0][index] = this._sanitize(samples[i * CHANNELS])
      this.ring[1][index] = this._sanitize(samples[i * CHANNELS + 1])
      this.writeFrame++
    }

    const fill = this._fillFrames()
    if (fill > MAX_FILL_FRAMES || fill >= RING_FRAMES - 1) {
      this.overflows++
      this._recoverToLiveEdge()
    }
  }

  _updateRate() {
    const error = (this._fillFrames() - TARGET_FRAMES) / TARGET_FRAMES
    this.integral = Math.max(-1, Math.min(1, this.integral + error))
    const correction = error * PROPORTIONAL_GAIN + this.integral * INTEGRAL_GAIN
    this.readRate = Math.max(MIN_RATE, Math.min(MAX_RATE, 1 + correction))
  }

  _reportMetrics(frames) {
    this.framesSinceMetrics += frames
    if (this.framesSinceMetrics < METRICS_INTERVAL_FRAMES) return
    this.framesSinceMetrics = 0
    const faults = `${this.underruns}:${this.overflows}:${this.invalidSamples}:${this.resets}`
    if (faults === this.reportedFaults) return
    this.reportedFaults = faults
    this.port.postMessage({
      type: "metrics",
      fillFrames: Math.round(this._fillFrames()),
      readRate: this.readRate,
      underruns: this.underruns,
      overflows: this.overflows,
      invalidSamples: this.invalidSamples,
      resets: this.resets,
    })
  }

  process(_inputs, outputs) {
    if (this.stopped) return false
    const output = outputs[0]
    if (!output?.[0] || !output?.[1]) return true
    const frames = output[0].length

    if (this.buffering && this._fillFrames() >= START_FRAMES) {
      this.buffering = false
      this.integral = 0
      if (!this.readySent) {
        this.readySent = true
        this.port.postMessage({ type: "ready", fillFrames: Math.round(this._fillFrames()) })
      }
    }
    if (!this.buffering) this._updateRate()

    for (let i = 0; i < frames; i++) {
      if (!this.buffering && this._fillFrames() >= 2) {
        const baseFrame = Math.floor(this.readPosition)
        const fraction = this.readPosition - baseFrame
        const base = baseFrame % RING_FRAMES
        const next = (base + 1) % RING_FRAMES
        this.gain = Math.min(1, this.gain + 1 / FADE_FRAMES)

        for (let channel = 0; channel < CHANNELS; channel++) {
          const a = this.ring[channel][base]
          const sample = a + (this.ring[channel][next] - a) * fraction
          this.lastSample[channel] = sample
          output[channel][i] = sample * this.gain
        }
        this.readPosition += this.readRate
      } else {
        if (!this.buffering) {
          this.underruns++
          // Do not replay frames that were already consumed. Start a fresh
          // prebuffer at the current producer edge after starvation.
          this._reset(false)
        }
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
