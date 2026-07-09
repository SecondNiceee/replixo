// ---------------------------------------------------------------------------
// Screen-share Echo Canceller (AudioWorklet)
//
// Problem: when a participant shares "the whole screen with system sound", the
// OS loopback capture also grabs the OTHER participants' voices that this
// machine is currently playing through its output. That mixed audio is sent
// back to everyone, so a listener hears their own voice echoed.
//
// Fix: we have a perfectly clean, digital copy of exactly what this machine is
// playing — the mix of all remote voices (the "far-end reference"). This
// worklet adaptively estimates how that reference leaks into the captured
// system audio and subtracts it, leaving only the genuine screen content
// (YouTube, games, music, ...).
//
// WHY THIS CASE IS SPECIAL
// ------------------------
// In a normal mic/speaker AEC the "near-end" (your own voice) is INTERMITTENT,
// so classic designs freeze adaptation during "double-talk". Here the near-end
// is the shared CONTENT (a movie, YouTube, a game) which plays essentially
// ALL THE TIME. If we froze adaptation whenever content was present, the
// filter would never converge.
//
// The saving grace: the content is statistically UNCORRELATED with the remote
// voices. A normalized LMS filter therefore naturally converges to cancel only
// the correlated part (the echo) and treats the content as zero-mean gradient
// noise, which the leakage term averages out. So the correct strategy here is:
//   • adapt CONTINUOUSLY while the far-end reference is playing,
//   • use a small, power-normalized step + leakage (clean, slow, stable),
//   • output the LINEAR residual only (no spectral gating), so the content is
//     passed through completely untouched — no musical noise, no pumping.
//
// This is the opposite of a speakerphone AEC and is exactly why the previous
// version (double-talk freeze + aggressive spectral suppressor) sounded bad:
// it both starved the filter of adaptation and mangled the continuous content.
//
// Algorithm: partitioned frequency-domain NLMS (Multi-delay block Frequency-
// domain adaptive Filter, MDF) via overlap-save with a from-scratch radix-2
// FFT, WITH a gradient constraint (applied round-robin, one partition per
// block, Speex-style) so the estimate is a true linear convolution.
//
// Inputs:  0 = primary (captured system audio),  1 = reference (remote voices).
// Output:  0 = primary with the echo removed.
//
// Graceful degradation: weights start at zero, so before convergence the output
// equals the raw captured audio. Any numerical blow-up resets the filter
// instead of emitting noise.
// ---------------------------------------------------------------------------

const BLOCK = 128 // AudioWorklet render quantum
const N = 256 // FFT size (2 * BLOCK, overlap-save)

// Echo-tail coverage. Real-world output+loopback latency ranges from ~20 ms
// (wired) to ~200 ms (Bluetooth). Size the adaptive filter from the actual
// sample rate to cover ~250 ms so the delay almost always falls inside the
// filter — a tail too short to reach the delayed echo is the single most
// common reason a screen-share AEC "does nothing".
const TAIL_MS = 250
const PARTITIONS = Math.max(
  8,
  Math.round((TAIL_MS / 1000) * sampleRate / BLOCK), // `sampleRate` is a worklet global
)

// Adaptation. MU is deliberately small: the continuous, uncorrelated content
// acts as gradient noise, so a gentle step + leakage converges cleanly without
// letting the content perturb the filter (which would modulate the residual
// echo and sound "swirly"). REG keeps the power-normalisation stable on quiet
// bins.
const MU = 0.2 // NLMS step size (power-normalised per bin below)
const LEAK = 0.99995 // leakage — lets the filter track OS volume/clock drift
const REG = 1e-6 // absolute regularisation floor for the normaliser

// A reference block quieter than this carries no usable echo to model, so we
// hold the filter (nothing to learn) rather than divide by ~0.
const REF_ACTIVE = 1e-6

// --- Stability guards -------------------------------------------------------
// The frequency-domain gradient constraint (constrainPartition) is what keeps
// the estimate a TRUE linear convolution. Applying it to only one partition
// per block means the whole filter is only fully constrained every PARTITIONS
// blocks (~250 ms with an 86-partition tail) — far too slow, so circular-
// convolution aliasing accumulates in the un-constrained partitions and the
// filter drifts into divergence (the classic "ERLE climbs, then falls below 0
// and sticks there"). Constrain several partitions per block so the full
// sweep completes in ~16 blocks (~45 ms) instead.
const CONSTRAIN_PER_BLOCK = Math.max(1, Math.ceil(PARTITIONS / 16))

// Divergence guard. A linear echo canceller must NEVER make the signal louder:
// if the running output power exceeds the input power the filter is actively
// injecting echo instead of removing it (this is exactly the negative-ERLE
// state seen in the logs). When that happens we (a) bypass to the raw capture
// so there is zero regression, and (b) shrink the weights toward zero so the
// NLMS loop re-converges from a clean state instead of staying stuck.
const DIV_EMA = 0.9 // smoothing for the input/output power detector
const DIV_RATIO = 1.06 // output louder than input by >6% ⇒ diverging
const DEADAPT = 0.5 // per-block weight shrink while diverging (fast recovery)

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
    this.denom = new Float32Array(N) // per-bin input power (normaliser)
    this.cr = new Float32Array(N) // constraint scratch
    this.ci = new Float32Array(N)

    this.constrainIdx = 0 // round-robin gradient-constraint cursor

    this.cand = new Float32Array(BLOCK) // candidate cleaned block (pre-guard)
    this.pAvg = 0 // smoothed input power  (divergence detector)
    this.eAvg = 0 // smoothed output power (divergence detector)

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

  // Project one partition's weights back onto the space of length-BLOCK time-
  // domain filters (zero the wrap-around tail). Applied round-robin so that
  // over PARTITIONS blocks the whole filter stays constrained — this is what
  // makes the frequency-domain estimate a true linear convolution, and it is
  // cheap (2 FFTs per block total).
  constrainPartition(p) {
    const { cr, ci, fft, Wr, Wi } = this
    cr.set(Wr[p])
    ci.set(Wi[p])
    fft.transform(cr, ci, true) // → time domain
    for (let n = BLOCK; n < N; n++) {
      cr[n] = 0
      ci[n] = 0
    }
    fft.transform(cr, ci, false) // → frequency domain
    Wr[p].set(cr)
    Wi[p].set(ci)
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

    // --- 3. Shift partition ring, store newest reference spectrum at index 0 ---
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
    for (let k = 0; k < N; k++) denom[k] = REG
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

    // --- 5. IFFT(Y) → time-domain echo estimate (overlap-save: keep 2nd half) ---
    fft.transform(yr, yi, true)

    // --- 6. Candidate cleaned block e = d - echoEstimate (decided below) ---
    const cand = this.cand
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
      cand[n] = e
      primaryPow += d * d
      errPow += e * e
    }

    // Numerical blow-up: reset the filter, pass the raw capture through.
    if (unstable) {
      this.resetWeights()
      this.pAvg = 0
      this.eAvg = 0
      for (let n = 0; n < BLOCK; n++) output[n] = primary[n]
      refPrev.set(hasRef ? reference : new Float32Array(BLOCK))
      return true
    }

    // --- 6b. Divergence guard (input/output power) ---
    // Track smoothed input vs output power. If the "cleaned" output is louder
    // than the raw capture the filter has diverged and is injecting echo, so we
    // bypass to the raw signal (no regression) and shrink the weights toward
    // zero so NLMS re-converges instead of sticking at a negative ERLE.
    this.pAvg = DIV_EMA * this.pAvg + (1 - DIV_EMA) * primaryPow
    this.eAvg = DIV_EMA * this.eAvg + (1 - DIV_EMA) * errPow
    const diverging = this.eAvg > this.pAvg * DIV_RATIO

    let emittedPow = errPow
    if (diverging) {
      // Bypass: publish the untouched capture this block.
      for (let n = 0; n < BLOCK; n++) output[n] = primary[n]
      emittedPow = primaryPow
      // De-adapt fast: pull every weight halfway to zero.
      for (let p = 0; p < PARTITIONS; p++) {
        const wr = Wr[p]
        const wi = Wi[p]
        for (let k = 0; k < N; k++) {
          wr[k] *= DEADAPT
          wi[k] *= DEADAPT
        }
      }
      // Relax the detector so a single good block can end bypass mode.
      this.eAvg = this.pAvg
    } else {
      // Emit the cleaned block and build the gradient error frame [zeros | e].
      for (let n = 0; n < BLOCK; n++) {
        const e = cand[n]
        output[n] = e
        er[n] = 0
        er[n + BLOCK] = e
        ei[n] = 0
        ei[n + BLOCK] = 0
      }

      // --- 7. FFT of error ---
      fft.transform(er, ei, false)

      // --- 8. NLMS weight update (adapt continuously while far-end is active) ---
      // The content is uncorrelated with the reference, so continuous adaptation
      // converges onto the echo path only; leakage bleeds off the uncorrelated
      // gradient noise. No double-talk freeze here — that is intentional and is
      // the key to this working on continuously-playing content.
      if (refActive) {
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

        // --- 8b. Gradient constraint: sweep several partitions per block so
        // the whole filter is re-constrained fast enough to prevent aliasing
        // build-up (the main driver of the divergence above). ---
        for (let c = 0; c < CONSTRAIN_PER_BLOCK; c++) {
          this.constrainPartition(this.constrainIdx)
          this.constrainIdx = (this.constrainIdx + 1) % PARTITIONS
        }
      }
    }

    // --- 9. Remember this reference block for the next overlap frame ---
    if (hasRef) refPrev.set(reference)
    else refPrev.fill(0)

    // --- 10. Metrics (~0.5 s): report echo return loss enhancement ---
    this.mPrimary += primaryPow
    this.mErr += emittedPow
    this.mSamples += BLOCK
    if (this.mSamples >= this.metricInterval) {
      const erle = this.mErr > 0 ? 10 * Math.log10(this.mPrimary / this.mErr) : 0
      this.port.postMessage({
        type: "metrics",
        erle: Math.round(erle * 10) / 10,
        partitions: PARTITIONS,
        tailMs: Math.round((PARTITIONS * BLOCK * 1000) / sampleRate),
        adapting: refActive,
        diverging,
      })
      this.mPrimary = 0
      this.mErr = 0
      this.mSamples = 0
    }

    return true
  }
}

registerProcessor("screen-aec", ScreenAEC)
