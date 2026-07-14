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
const SAMPLE_RATE = 48000
// ~1 second ring per channel at 48 kHz — plenty to absorb IPC jitter.
const RING_FRAMES = SAMPLE_RATE
// IPC delivery is bursty. Buffer 100 ms before starting or resuming playback so
// isolated late chunks do not alternate real PCM with zero-filled render quanta.
const PREBUFFER_FRAMES = Math.round(SAMPLE_RATE * 0.1)

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ring = [new Float32Array(RING_FRAMES), new Float32Array(RING_FRAMES)]
    this.writeIdx = 0
    this.readIdx = 0
    this.available = 0 // frames available to read
    this.buffering = true

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

    if (this.buffering && this.available >= PREBUFFER_FRAMES) {
      this.buffering = false
    }

    for (let i = 0; i < frames; i++) {
      if (!this.buffering && this.available > 0) {
        out[0][i] = this.ring[0][this.readIdx]
        out[1][i] = this.ring[1][this.readIdx]
        this.readIdx = (this.readIdx + 1) % RING_FRAMES
        this.available--
      } else {
        out[0][i] = 0
        out[1][i] = 0
      }

      // Once starved, stay silent until enough contiguous PCM has accumulated.
      // This trades a short clean pause for the crackle caused by rapid
      // PCM/silence alternation at every late IPC chunk boundary.
      if (!this.buffering && this.available === 0) {
        this.buffering = true
      }
    }
    return true
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor)
