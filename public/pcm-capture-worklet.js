// ---------------------------------------------------------------------------
// PCM capture worklet (Variant A — about/echo-fix/plan.md)
//
// Receives interleaved float32 stereo PCM (48 kHz) pushed from the main thread
// (native WASAPI process-loopback helper via Electron IPC) and plays it out of
// its two output channels through a jitter-absorbing ring buffer.
//
// The audio is already "system mix minus our process tree", so it contains the
// shared screen's sound WITHOUT the call participants' voices — no echo, no DSP.
// ---------------------------------------------------------------------------

const CHANNELS = 2
// ~1 second ring per channel at 48 kHz — plenty to absorb IPC jitter.
const RING_FRAMES = 48000

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ring = [new Float32Array(RING_FRAMES), new Float32Array(RING_FRAMES)]
    this.writeIdx = 0
    this.readIdx = 0
    this.available = 0 // frames available to read

    this.port.onmessage = (e) => {
      const data = e.data
      if (!data) return
      if (data.type === "stop") {
        this.stopped = true
        return
      }
      if (data.samples) {
        this._enqueue(data.samples)
      }
    }
  }

  // samples: Float32Array of interleaved stereo frames [L,R,L,R,...]
  _enqueue(samples) {
    const frames = Math.floor(samples.length / CHANNELS)
    for (let i = 0; i < frames; i++) {
      const l = samples[i * CHANNELS]
      const r = samples[i * CHANNELS + 1]
      this.ring[0][this.writeIdx] = l
      this.ring[1][this.writeIdx] = r
      this.writeIdx = (this.writeIdx + 1) % RING_FRAMES
      if (this.available < RING_FRAMES) {
        this.available++
      } else {
        // Overflow: drop oldest frame to stay real-time.
        this.readIdx = (this.readIdx + 1) % RING_FRAMES
      }
    }
  }

  process(_inputs, outputs) {
    if (this.stopped) return false
    const out = outputs[0]
    const frames = out[0].length
    for (let i = 0; i < frames; i++) {
      if (this.available > 0) {
        out[0][i] = this.ring[0][this.readIdx]
        out[1][i] = this.ring[1][this.readIdx]
        this.readIdx = (this.readIdx + 1) % RING_FRAMES
        this.available--
      } else {
        out[0][i] = 0
        out[1][i] = 0
      }
    }
    return true
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor)
