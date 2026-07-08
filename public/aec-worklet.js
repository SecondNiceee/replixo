// ---------------------------------------------------------------------------
// Screen-share Acoustic Echo Canceller (AudioWorklet)
//
// Problem: when a participant shares "the whole screen with system sound", the
// OS loopback capture also grabs the OTHER participants' voices that this
// machine is currently playing through its output. That mixed audio is sent
// back to everyone, so a listener hears their own voice echoed.
//
// Fix (the same idea Discord/WebRTC use): we have a perfectly clean, digital
// copy of exactly what this machine is playing — the mix of all remote voices
// (the "far-end reference"). This worklet adaptively estimates how that
// reference leaks into the captured system audio (level + delay introduced by
// the OS loopback path) and subtracts it, leaving only the genuine screen
// content (YouTube, games, music, ...).
//
// Algorithm: partitioned frequency-domain normalized LMS adaptive filter
// (a.k.a. Multi-Delay block Frequency-domain adaptive Filter, MDF), using
// overlap-save with a from-scratch radix-2 FFT. Input 0 = primary (captured
// system audio), input 1 = reference (remote voices this machine plays).
// Output 0 = primary with the echo removed.
//
// Graceful degradation: the filter starts at zero, so before it converges the
// output equals the raw captured audio. If the reference is silent or absent
// (nothing being played), it converges toward passing the primary through
// unchanged. Any numerical blow-up resets the filter instead of emitting noise.
// ---------------------------------------------------------------------------

const BLOCK = 128 // AudioWorklet render quantum
const N = 256 // FFT size (2 * BLOCK, overlap-save)
const PARTITIONS = 32 // 32 * 128 / 48000 ≈ 85 ms of echo tail coverage
const MU = 0.3 // adaptation step size
const LEAK = 0.99999 // tiny leakage keeps the filter from drifting
const EPS = 1e-3 // regularisation for the power normalisation

class FFT {
  constructor(n) {
    this.n = n
    this.cos = new Float32Array(n / 2)
    this.sin = new Float32Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      const a = (-2 * Math.PI * i) / n
      this.cos[i] = Math.cos(a)
      this.sin[i] = Math.sin(a)
    }
    const bits = Math.round(Math.log2(n))
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let x = i
      let r = 0
      for (let j = 0; j < bits; j++) {
        r = (r << 1) | (x & 1)
        x >>= 1
      }
      this.rev[i] = r
    }
  }

  // In-place complex FFT (or inverse when `inverse` is true).
  transform(re, im, inverse) {
    const n = this.n
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let i = 0; i < n; i += size) {
        let k = 0
        for (let j = i; j < i + half; j++) {
          const c = this.cos[k]
          const s = inverse ? -this.sin[k] : this.sin[k]
          const l = j + half
          const tr = re[l] * c - im[l] * s
          const ti = re[l] * s + im[l] * c
          re[l] = re[j] - tr
          im[l] = im[j] - ti
          re[j] += tr
          im[j] += ti
          k += step
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n
        im[i] /= n
      }
    }
  }
}

class ScreenAEC extends AudioWorkletProcessor {
  constructor() {
    super()
    this.enabled = true
    this.fft = new FFT(N)

    // Far-end (reference) frequency-domain partitions, newest at index 0.
    this.Xr = Array.from({ length: PARTITIONS }, () => new Float32Array(N))
    this.Xi = Array.from({ length: PARTITIONS }, () => new Float32Array(N))
    // Adaptive filter weights per partition (frequency domain).
    this.Wr = Array.from({ length: PARTITIONS }, () => new Float32Array(N))
    this.Wi = Array.from({ length: PARTITIONS }, () => new Float32Array(N))

    this.refPrev = new Float32Array(BLOCK) // previous reference block (overlap)
    // Scratch buffers reused every render quantum.
    this.re = new Float32Array(N)
    this.im = new Float32Array(N)
    this.yr = new Float32Array(N)
    this.yi = new Float32Array(N)
    this.er = new Float32Array(N)
    this.ei = new Float32Array(N)
    this.denom = new Float32Array(N)

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "stop") this.enabled = false
      if (e.data && e.data.type === "reset") this.resetWeights()
    }
  }

  resetWeights() {
    for (let p = 0; p < PARTITIONS; p++) {
      this.Wr[p].fill(0)
      this.Wi[p].fill(0)
      this.Xr[p].fill(0)
      this.Xi[p].fill(0)
    }
    this.refPrev.fill(0)
  }

  process(inputs, outputs) {
    if (!this.enabled) return false

    const primary = inputs[0] && inputs[0][0]
    const output = outputs[0] && outputs[0][0]
    if (!output) return true

    // No captured audio this quantum — emit silence.
    if (!primary || primary.length !== BLOCK) {
      output.fill(0)
      return true
    }

    const reference = inputs[1] && inputs[1][0]
    const hasRef = !!reference && reference.length === BLOCK

    const { re, im, yr, yi, er, ei, denom, fft, Xr, Xi, Wr, Wi, refPrev } = this

    // --- 1. Far-end (reference) analysis frame: [prevBlock | currentBlock] ---
    for (let n = 0; n < BLOCK; n++) {
      re[n] = refPrev[n]
      re[n + BLOCK] = hasRef ? reference[n] : 0
      im[n] = 0
      im[n + BLOCK] = 0
    }
    fft.transform(re, im, false)

    // --- 2. Shift partition buffer, store newest reference spectrum at 0 ---
    const oldestR = Xr[PARTITIONS - 1]
    const oldestI = Xi[PARTITIONS - 1]
    for (let p = PARTITIONS - 1; p > 0; p--) {
      Xr[p] = Xr[p - 1]
      Xi[p] = Xi[p - 1]
    }
    Xr[0] = oldestR
    Xi[0] = oldestI
    Xr[0].set(re)
    Xi[0].set(im)

    // --- 3. Estimated echo spectrum Y = sum_p W_p * X_p, plus power denom ---
    yr.fill(0)
    yi.fill(0)
    for (let k = 0; k < N; k++) denom[k] = EPS
    for (let p = 0; p < PARTITIONS; p++) {
      const xr = Xr[p]
      const xi = Xi[p]
      const wr = Wr[p]
      const wi = Wi[p]
      for (let k = 0; k < N; k++) {
        const xrk = xr[k]
        const xik = xi[k]
        yr[k] += wr[k] * xrk - wi[k] * xik
        yi[k] += wr[k] * xik + wi[k] * xrk
        denom[k] += xrk * xrk + xik * xik
      }
    }

    // --- 4. IFFT(Y) → time-domain echo estimate (overlap-save: keep 2nd half) ---
    fft.transform(yr, yi, true)

    // --- 5. Error (cleaned) block e = d - echoEstimate ---
    let unstable = false
    for (let n = 0; n < BLOCK; n++) {
      let e = primary[n] - yr[n + BLOCK]
      if (!Number.isFinite(e)) {
        unstable = true
        e = primary[n]
      }
      if (e > 1) e = 1
      else if (e < -1) e = -1
      output[n] = e
      // Error analysis frame: [zeros | e]
      er[n] = 0
      er[n + BLOCK] = e
      ei[n] = 0
      ei[n + BLOCK] = 0
    }

    if (unstable) {
      this.resetWeights()
      refPrev.set(hasRef ? reference : new Float32Array(BLOCK))
      return true
    }

    // --- 6. FFT of error, then NLMS weight update per partition ---
    fft.transform(er, ei, false)
    for (let p = 0; p < PARTITIONS; p++) {
      const xr = Xr[p]
      const xi = Xi[p]
      const wr = Wr[p]
      const wi = Wi[p]
      for (let k = 0; k < N; k++) {
        const f = MU / denom[k]
        const xrk = xr[k]
        const xik = xi[k]
        // conj(X) * E
        const gr = xrk * er[k] + xik * ei[k]
        const gi = xrk * ei[k] - xik * er[k]
        wr[k] = LEAK * wr[k] + f * gr
        wi[k] = LEAK * wi[k] + f * gi
      }
    }

    // --- 7. Remember this reference block for the next overlap frame ---
    if (hasRef) refPrev.set(reference)
    else refPrev.fill(0)

    return true
  }
}

registerProcessor("screen-aec", ScreenAEC)
