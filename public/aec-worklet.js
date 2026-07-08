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
// reference leaks into the captured system audio and subtracts it, leaving
// only the genuine screen content (YouTube, games, music, ...).
//
// IMPORTANT: unlike a microphone picking up speakers, this echo comes from a
// *digital* loopback of the OS mix. The relationship between the reference and
// the leaked echo is therefore almost perfectly LINEAR (a gain + a bulk delay,
// plus slow clock drift between the AudioContext and the OS mixer). A linear
// adaptive filter can consequently cancel it extremely well — the only hard
// requirements are (a) the filter must be long enough to cover the real loop
// delay and (b) it must not diverge during "double-talk" (content playing at
// the same time as remote voices) or when there is no reference at all.
//
// Algorithm: partitioned frequency-domain normalized LMS adaptive filter
// (a.k.a. Multi-Delay block Frequency-domain adaptive Filter, MDF), using
// overlap-save with a from-scratch radix-2 FFT, followed by a gentle,
// far-end-gated residual echo suppressor. Input 0 = primary (captured system
// audio), input 1 = reference (remote voices this machine plays). Output 0 =
// primary with the echo removed.
//
// Graceful degradation: the filter starts at zero, so before it converges the
// output equals the raw captured audio. Adaptation only runs while there is
// real reference energy, so silence/content-only periods never corrupt the
// filter. The residual suppressor is bypassed entirely when no reference is
// playing, so pure screen content is passed through untouched. Any numerical
// blow-up resets the filter instead of emitting noise.
// ---------------------------------------------------------------------------

const BLOCK = 128 // AudioWorklet render quantum
const N = 256 // FFT size (2 * BLOCK, overlap-save)

// Echo-tail coverage. Real-world output+loopback latency ranges from ~20 ms
// (wired) to ~200 ms (Bluetooth). We size the adaptive filter from the actual
// sample rate to cover ~260 ms so the delay almost always falls inside the
// filter — the single most common reason a screen-share AEC "does nothing" is
// a tail that is too short to reach the delayed echo.
const TAIL_MS = 260
const PARTITIONS = Math.max(
  8,
  Math.round((TAIL_MS / 1000) * sampleRate / BLOCK), // `sampleRate` is a worklet global
)

const MU = 0.5 // adaptation step size (per-bin power-normalised below)
const LEAK = 0.9998 // leakage — lets the filter track volume/drift changes
const EPS = 1e-3 // regularisation for the power normalisation

// Adaptation gating.
const REF_ACTIVE = 1e-5 // min reference block energy to consider "playing"
const DIVERGE_RATIO = 2.0 // freeze adapting if error grows past this × input

// Residual echo suppressor (post linear filter). Conservative on purpose: it
// only ever engages while the far-end is active, is heavily time-smoothed to
// avoid block-edge clicks, and keeps a high gain floor so genuine screen
// content is never gutted.
const RES_BETA = 0.5 // how aggressively residual echo is subtracted
const RES_GMIN = 0.15 // max ~16 dB suppression per bin
const RES_SMOOTH = 0.85 // per-bin gain smoothing across frames

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
    this.suppressor = true
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
    this.magY = new Float32Array(N) // |echo estimate| per bin (for suppressor)
    this.er = new Float32Array(N)
    this.ei = new Float32Array(N)
    this.sr = new Float32Array(N) // suppressor output scratch
    this.si = new Float32Array(N)
    this.gain = new Float32Array(N) // smoothed residual-suppression gain
    this.gain.fill(1)
    this.denom = new Float32Array(N)

    // Metrics accumulation (~0.5 s windows).
    this.mPrimary = 0
    this.mErr = 0
    this.mSamples = 0
    this.metricInterval = Math.max(BLOCK, Math.round(sampleRate * 0.5))

    this.port.onmessage = (e) => {
      const d = e.data
      if (!d) return
      if (d.type === "stop") this.enabled = false
      else if (d.type === "reset") this.resetWeights()
      else if (d.type === "suppressor") this.suppressor = !!d.value
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
    this.gain.fill(1)
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

    const { re, im, yr, yi, magY, er, ei, sr, si, gain, denom, fft, Xr, Xi, Wr, Wi, refPrev } = this

    // --- 1. Reference block energy (drives adaptation gating) ---
    let refPow = 0
    if (hasRef) {
      for (let n = 0; n < BLOCK; n++) refPow += reference[n] * reference[n]
    }
    const refActive = refPow > REF_ACTIVE

    // --- 2. Far-end analysis frame: [prevBlock | currentBlock] ---
    for (let n = 0; n < BLOCK; n++) {
      re[n] = refPrev[n]
      re[n + BLOCK] = hasRef ? reference[n] : 0
      im[n] = 0
      im[n + BLOCK] = 0
    }
    fft.transform(re, im, false)

    // --- 3. Shift partition buffer, store newest reference spectrum at 0 ---
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

    // --- 4. Estimated echo spectrum Y = sum_p W_p * X_p, plus power denom ---
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
    // Magnitude of the modeled echo per bin — used by the residual suppressor.
    for (let k = 0; k < N; k++) magY[k] = Math.sqrt(yr[k] * yr[k] + yi[k] * yi[k])

    // --- 5. IFFT(Y) → time-domain echo estimate (overlap-save: keep 2nd half) ---
    fft.transform(yr, yi, true)

    // --- 6. Error (cleaned) block e = d - echoEstimate ---
    let unstable = false
    let primaryPow = 0
    let errPow = 0
    for (let n = 0; n < BLOCK; n++) {
      const d = primary[n]
      let e = d - yr[n + BLOCK]
      if (!Number.isFinite(e)) {
        unstable = true
        e = d
      }
      if (e > 1) e = 1
      else if (e < -1) e = -1
      output[n] = e // linear-AEC output (default; may be refined in step 9)
      primaryPow += d * d
      errPow += e * e
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

    // --- 7. FFT of error ---
    fft.transform(er, ei, false)

    // --- 8. NLMS weight update per partition (gated to avoid divergence) ---
    // Adapt only while the far-end is actually playing (there is an echo to
    // model) and the filter is not diverging (error not exploding past the
    // input). This single guard cleanly handles double-talk and silence: when
    // content dominates or nothing plays, we simply hold the current filter.
    const adapt = refActive && errPow < primaryPow * DIVERGE_RATIO
    if (adapt) {
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
    }

    // --- 9. Residual echo suppressor (far-end-gated, smoothed) ---
    // Mops up the echo tail the linear filter leaves behind. Only runs while
    // the far-end is active so pure screen content is never touched. Operates
    // on a copy of the error spectrum (the NLMS update above already consumed
    // the un-suppressed error), then re-synthesises the output.
    if (this.suppressor && refActive) {
      for (let k = 0; k < N; k++) {
        const em = Math.sqrt(er[k] * er[k] + ei[k] * ei[k])
        // Wiener-style gain: attenuate bins where modeled echo dominates the
        // remaining error. Floored so content is preserved, smoothed over time.
        const target = em / (em + RES_BETA * magY[k] + 1e-9)
        let g = target < RES_GMIN ? RES_GMIN : target
        g = RES_SMOOTH * gain[k] + (1 - RES_SMOOTH) * g
        gain[k] = g
        sr[k] = er[k] * g
        si[k] = ei[k] * g
      }
      fft.transform(sr, si, true)
      for (let n = 0; n < BLOCK; n++) {
        let e = sr[n + BLOCK]
        if (e > 1) e = 1
        else if (e < -1) e = -1
        output[n] = e
      }
    } else {
      // Relax the gains back toward unity while idle so re-engagement is smooth.
      for (let k = 0; k < N; k++) gain[k] = RES_SMOOTH * gain[k] + (1 - RES_SMOOTH)
    }

    // --- 10. Remember this reference block for the next overlap frame ---
    if (hasRef) refPrev.set(reference)
    else refPrev.fill(0)

    // --- 11. Metrics (~0.5 s): report echo return loss enhancement ---
    this.mPrimary += primaryPow
    this.mErr += errPow
    this.mSamples += BLOCK
    if (this.mSamples >= this.metricInterval) {
      const erle = this.mErr > 0 ? 10 * Math.log10(this.mPrimary / this.mErr) : 0
      this.port.postMessage({
        type: "metrics",
        erle: Math.round(erle * 10) / 10,
        partitions: PARTITIONS,
        tailMs: Math.round((PARTITIONS * BLOCK * 1000) / sampleRate),
        adapting: adapt,
      })
      this.mPrimary = 0
      this.mErr = 0
      this.mSamples = 0
    }

    return true
  }
}

registerProcessor("screen-aec", ScreenAEC)
