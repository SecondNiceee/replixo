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
// (wired) to ~200 ms (Bluetooth) — and on Windows the OS audio engine buffer
// plus a Bluetooth headset can together push the round-trip PAST 250 ms, which
// drops the echo OUTSIDE the filter entirely (the AEC then "does nothing" no
// matter how healthy it looks). We size the tail to ~400 ms so even worst-case
// Bluetooth + OS buffering falls inside the filter. The extra partitions cost a
// little CPU but eliminate the most common silent failure mode.
const TAIL_MS = 400
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

// --- Residual echo suppressor (RES) -----------------------------------------
// The linear NLMS stage above realistically reaches only ~10–20 dB ERLE in a
// browser. That is NOT enough: your own voice, delayed ~200 ms and attenuated
// by only 15 dB, is still clearly audible as echo (this is the "I still hear
// myself" report — the linear filter is healthy, it just cannot go deep
// enough). WebRTC solves this exactly the same way: a nonlinear post-filter
// after the linear canceller.
//
// This RES is a per-frequency-bin Wiener gain driven by the linear stage's own
// echo estimate |Y[k]|². Crucially it is SELF-GATING on genuine content:
//   • a bin carrying real screen content has large output power S[k], so
//     G[k] = S / (S + echo) ≈ 1  → content passes through untouched;
//   • an echo-only bin (remote voices, no content — e.g. sharing a static
//     window while people talk) has small S and large echo → G[k] → floor,
//     killing the residual you were hearing.
// So it removes the audible echo without the "musical noise / pumping" that a
// naive spectral gate would inflict on continuously-playing media.
const RES_ENABLED = true
// Aggressive tuning: a linear ERLE of only ~10-15 dB leaves the remote voice
// clearly audible (echo needs ~30-45 dB total to vanish). The RES has to close
// that gap, so we over-subtract hard and allow a very deep floor. Content bins
// are protected by the self-gating gain, so this stays clean on media audio.
const RES_OVERSUB = 2.2 // over-subtraction factor on the ROBUST echo estimate
const RES_FLOOR = 0.012 // min gain (~ -38 dB) — deep cut on echo-only bins
const RES_ATTACK = 0.15 // gain-smoothing weight when INCREASING suppression (fast)
const RES_RELEASE = 0.82 // gain-smoothing weight when RELEASING suppression (slow)

// --- Echo-dominance-adaptive RES (the "I still hear voices, no media" fix) ---
// The self-gating Wiener gain protects real content, but in the reported
// failure case there IS no content — the demonstrator shares a static window
// while people talk, so the captured audio is essentially PURE echo (a delayed
// copy of the reference; the delay-diagnostic corr sits at ~0.9). In that
// regime it is always safe to suppress far harder, because there is nothing to
// protect. We already compute a robust echo-dominance signal every metric
// window: the normalised primary↔reference envelope correlation (`delayCorr`).
// We map it to [0..1] and use it to slide the RES between "gentle, content-
// safe" (corr low ⇒ media present) and "deep kill" (corr high ⇒ pure echo).
// This is the balance the user asked for: media stays clean, voice echo dies.
const RES_OVERSUB_MAX = 12.0 // over-subtraction when captured audio is pure echo
const RES_FLOOR_ECHO = 0.0005 // ~ -66 dB floor when fully echo-dominated
const DOM_CORR_LO = 0.35 // corr ≤ this ⇒ treat as content present (dominance 0)
const DOM_CORR_HI = 0.75 // corr ≥ this ⇒ treat as pure echo (dominance 1)
// Asymmetric dominance smoothing: SNAP UP the instant echo is confirmed (a
// single high-corr window is enough) but RELEASE slowly so the deep suppression
// holds through a talk burst instead of flickering with the noisy per-window
// corr estimate. This is what stops the "quieter but still distinct" leak: the
// logs showed corr bouncing 0.9→0.4→0.9, and the old symmetric EMA averaged
// that down to dom~0.6 so the aggressive RES never fully engaged.
const DOM_ATTACK = 0.25 // weight on OLD value when dom RISING (fast: 75% to new)
const DOM_RELEASE = 0.88 // weight on OLD value when dom FALLING (slow: 12% to new)

// Broadband echo gate. When echo dominance is confirmed there is (in this
// screen-share scenario) NO desired near-end signal to protect — the loopback
// is 100% unwanted remote voices — so on top of the per-bin Wiener gain we pull
// the WHOLE block toward silence. This is the decisive lever that kills the
// residual intelligibility of the voice echo. It engages only above GATE_DOM_ON
// (well clear of the content-present regime, where corr and thus dom are low),
// so media the demonstrator intentionally plays is left untouched.
const GATE_DOM_ON = 0.6 // dom below this ⇒ no broadband gating (protect content)
const GATE_MIN = 0.04 // broadband floor (~ -28 dB) at full echo dominance

// --- Robust residual-echo estimate (the fix for "I still hear myself") -------
// Relying on the instantaneous linear echo estimate |Y[k]|² alone is fragile:
// whenever the linear filter momentarily loses lock (the 3-5 dB ERLE dips seen
// in the logs) |Y|² collapses, the RES stops suppressing, and a burst of the
// remote voice leaks through — audible echo, exactly the symptom.
//
// But we ALWAYS have a perfect digital copy of the far-end, so we always KNOW
// when remote voices are playing, even when the linear filter stumbles. We
// exploit that: track a slowly-adapting per-bin echo-path coupling
//   coupling[k] = smoothed( |Y[k]|² / referencePower[k] )
// i.e. how much reference energy turns into echo at the output. Multiplying the
// (always-available) reference power back by this coupling gives a robust echo
// estimate that stays elevated through linear-filter dips. We drive the RES off
// max(instantaneous |Y|², robust estimate), so suppression never falls away
// while the far-end is active.
const COUPLING_EMA = 0.985 // slow: learns the stable echo-path gain per bin
const ECHO_EMA = 0.6 // faster: tracks the robust echo-power envelope

// --- Delay diagnostic --------------------------------------------------------
// If the true echo delay exceeds the filter tail, NOTHING the DSP does can
// cancel it — the reference for that echo simply isn't in the filter's window.
// To make that failure mode VISIBLE (instead of guessing), we estimate the
// bulk echo delay by cross-correlating the short-term power envelopes of the
// captured audio (primary) and the reference. This is diagnostic only: it does
// NOT touch the audio path, so it can never cause a regression. The estimate
// (ms + normalised peak correlation) is reported alongside ERLE, so the logs
// tell us directly whether to grow TAIL_MS further.
const BLOCK_MS = (BLOCK / sampleRate) * 1000 // ms per render quantum
const ENV_LEN = PARTITIONS + 8 // power-envelope history length (blocks)

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

    // Residual echo suppressor state.
    this.yPow = new Float32Array(N) // |Y[k]|² echo-estimate power (saved pre-IFFT)
    this.resGain = new Float32Array(N).fill(1) // smoothed per-bin suppression gain
    this.gr = new Float32Array(N) // RES output FFT scratch (real)
    this.gi = new Float32Array(N) // RES output FFT scratch (imag)
    this.coupling = new Float32Array(N) // smoothed echo-path power gain per bin
    this.echoPowSm = new Float32Array(N) // smoothed robust echo-power estimate

    // Metrics accumulation (~0.5 s windows).
    this.mPrimary = 0
    this.mErr = 0 // post-RES (actual emitted) error power
    this.mErrLin = 0 // linear-stage-only residual power (RES disambiguation)
    this.mSamples = 0
    this.metricInterval = Math.max(BLOCK, Math.round(sampleRate * 0.5))

    // Smoothed echo-dominance [0..1] driving the adaptive RES (see notes above).
    // 0 = content present (be gentle), 1 = pure echo (suppress hard). Starts at
    // 0 so we never over-suppress before we have a confident delay/corr estimate.
    this.echoDom = 0

    // Delay-diagnostic ring buffers of per-block power (oldest→newest via idx).
    this.dEnv = new Float32Array(ENV_LEN) // captured (primary) power envelope
    this.xEnv = new Float32Array(ENV_LEN) // reference power envelope
    this.envIdx = 0 // circular write cursor
    this.envFilled = 0 // how many slots have real data yet
    this.estDelayMs = 0 // last estimated bulk echo delay (ms)
    this.estDelayCorr = 0 // normalised correlation peak [0..1] (confidence)

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
    if (this.coupling) this.coupling.fill(0)
    if (this.echoPowSm) this.echoPowSm.fill(0)
    if (this.resGain) this.resGain.fill(1)
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

  // Estimate the bulk echo delay by cross-correlating the primary and reference
  // power envelopes. Returns { ms, corr } where corr is a normalised [0..1]
  // confidence. Echo appears in `primary` LATER than in `reference`, so we
  // search lags where primary[i] aligns with reference[i - lag], lag ≥ 0.
  // Diagnostic only — never alters the audio path.
  estimateDelay() {
    const n = this.envFilled
    if (n < 16) return { ms: 0, corr: 0 } // not enough history yet
    // Linearise the circular buffers oldest→newest.
    const d = new Float32Array(n)
    const x = new Float32Array(n)
    const start = this.envFilled < ENV_LEN ? 0 : this.envIdx
    for (let i = 0; i < n; i++) {
      const j = (start + i) % ENV_LEN
      d[i] = this.dEnv[j]
      x[i] = this.xEnv[j]
    }
    // Zero-mean both envelopes so silence/DC bias doesn't dominate.
    let dm = 0
    let xm = 0
    for (let i = 0; i < n; i++) {
      dm += d[i]
      xm += x[i]
    }
    dm /= n
    xm /= n
    let dEnergy = 0
    for (let i = 0; i < n; i++) {
      d[i] -= dm
      x[i] -= xm
      dEnergy += d[i] * d[i]
    }
    if (dEnergy < 1e-12) return { ms: 0, corr: 0 }
    const maxLag = Math.min(PARTITIONS, n - 8)
    let bestLag = 0
    let bestScore = -Infinity
    let bestNorm = 0
    for (let lag = 0; lag <= maxLag; lag++) {
      let dot = 0
      let xe = 0
      for (let i = lag; i < n; i++) {
        const xv = x[i - lag]
        dot += d[i] * xv
        xe += xv * xv
      }
      if (xe < 1e-12) continue
      const norm = dot / Math.sqrt(dEnergy * xe) // normalised correlation
      if (norm > bestNorm) {
        bestNorm = norm
        bestScore = dot
        bestLag = lag
      }
    }
    void bestScore
    return { ms: bestLag * BLOCK_MS, corr: bestNorm > 0 ? bestNorm : 0 }
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

    // --- 4b. Save |Y[k]|² for the residual suppressor BEFORE the IFFT below
    // overwrites yr/yi with the time-domain echo estimate, and update the
    // ROBUST echo-power estimate (see COUPLING_EMA notes above). ---
    const yPow = this.yPow
    const coupling = this.coupling
    const echoPowSm = this.echoPowSm
    for (let k = 0; k < N; k++) {
      const yp = yr[k] * yr[k] + yi[k] * yi[k]
      yPow[k] = yp
      // `denom[k]` (= REG + Σ_p |X_p[k]|²) is the total reference energy across
      // the whole echo tail — an always-available measure of how much far-end
      // could be echoing right now, independent of the linear filter's health.
      if (refActive) {
        const c = yp / denom[k] // instantaneous echo-path power gain
        coupling[k] = COUPLING_EMA * coupling[k] + (1 - COUPLING_EMA) * c
      }
      // Robust echo power: reference energy × learned coupling, floored by the
      // instantaneous estimate so fast transients aren't missed. This stays
      // elevated through linear-filter dips, keeping the RES suppressing.
      const robust = coupling[k] * denom[k]
      const est = robust > yp ? robust : yp
      echoPowSm[k] = ECHO_EMA * echoPowSm[k] + (1 - ECHO_EMA) * est
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

      // --- 7b. Residual echo suppressor (nonlinear post-filter) ---
      // Apply a self-gating Wiener gain to the LINEAR residual spectrum, then
      // overlap-save back to time domain. The ungained er/ei are kept intact
      // for the NLMS gradient below — adaptation must see the true linear
      // error, never the suppressed signal, or the filter would mis-converge.
      if (RES_ENABLED) {
        const gain = this.resGain
        const gr = this.gr
        const gi = this.gi
        const echoPowSm = this.echoPowSm
        // Slide RES aggressiveness by the current echo-dominance. When the
        // captured audio is pure echo (no content to protect) we over-subtract
        // much harder and allow a far deeper floor; when media is present we
        // fall back to the gentle, content-safe base values.
        const dom = this.echoDom
        const oversubDyn = RES_OVERSUB + dom * (RES_OVERSUB_MAX - RES_OVERSUB)
        const floorDyn = RES_FLOOR + dom * (RES_FLOOR_ECHO - RES_FLOOR)
        for (let k = 0; k < N; k++) {
          const s = er[k] * er[k] + ei[k] * ei[k] // post-linear output power
          // Robust echo proxy (survives linear-filter dips) instead of the raw,
          // fragile instantaneous |Y|². This is the key change that stops the
          // remote voice leaking through when ERLE momentarily drops.
          const echo = oversubDyn * echoPowSm[k]
          let g = s / (s + echo + 1e-12)
          if (g < floorDyn) g = floorDyn
          // Fast attack (suppress quickly), slow release (avoid echo bursts).
          const prev = gain[k]
          const w = g < prev ? RES_ATTACK : RES_RELEASE
          g = w * prev + (1 - w) * g
          gain[k] = g
          gr[k] = er[k] * g
          gi[k] = ei[k] * g
        }
        fft.transform(gr, gi, true) // → time domain suppressed block
        // Broadband echo gate: above GATE_DOM_ON, ramp the whole block toward
        // GATE_MIN as dominance approaches 1. Nothing to protect here, so this
        // finishes off the intelligibility the per-bin gain leaves behind.
        let echoGate = 1
        if (dom > GATE_DOM_ON) {
          const t = (dom - GATE_DOM_ON) / (1 - GATE_DOM_ON) // 0..1
          echoGate = 1 - t * (1 - GATE_MIN)
        }
        let outPow = 0
        for (let n = 0; n < BLOCK; n++) {
          let o = gr[n + BLOCK] * echoGate
          if (o > 1) o = 1
          else if (o < -1) o = -1
          output[n] = o
          outPow += o * o
        }
        emittedPow = outPow // metrics/ERLE reflect the REAL suppressed output
      }

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

    // --- 9b. Feed the delay-diagnostic power envelopes (per block). ---
    this.dEnv[this.envIdx] = primaryPow
    this.xEnv[this.envIdx] = refPow
    this.envIdx = (this.envIdx + 1) % ENV_LEN
    if (this.envFilled < ENV_LEN) this.envFilled++

    // --- 10. Metrics (~0.5 s): report echo return loss enhancement ---
    this.mPrimary += primaryPow
    this.mErr += emittedPow // actual emitted output (post-RES)
    this.mErrLin += errPow // linear-stage residual only (before RES)
    this.mSamples += BLOCK
    if (this.mSamples >= this.metricInterval) {
      // Post-RES ERLE (what the listener actually hears) AND linear-only ERLE.
      // Splitting these tells us WHICH stage is the bottleneck: if erle ≈ linErle
      // the RES is not adding suppression (tune the RES); if linErle is low but
      // erle is high the linear stage is weak but the RES rescues it; if BOTH are
      // low despite high corr the echo path is nonlinear (only the RES can help).
      const erle = this.mErr > 0 ? 10 * Math.log10(this.mPrimary / this.mErr) : 0
      const linErle = this.mErrLin > 0 ? 10 * Math.log10(this.mPrimary / this.mErrLin) : 0
      const tailMs = Math.round((PARTITIONS * BLOCK * 1000) / sampleRate)
      const { ms: delayMs, corr: delayCorr } = this.estimateDelay()
      this.estDelayMs = delayMs
      this.estDelayCorr = delayCorr

      // Update the smoothed echo-dominance that drives the adaptive RES. A high
      // primary↔reference envelope correlation means the captured audio is
      // basically a delayed copy of the reference (pure echo, no content), so
      // it is safe to suppress hard; low corr means media is present, so back
      // off to protect it.
      const domRaw = Math.max(0, Math.min(1, (delayCorr - DOM_CORR_LO) / (DOM_CORR_HI - DOM_CORR_LO)))
      // Fast attack when echo appears, slow release so the deep suppression
      // holds through a talk burst despite the noisy per-window corr estimate.
      const domW = domRaw > this.echoDom ? DOM_ATTACK : DOM_RELEASE
      this.echoDom = domW * this.echoDom + (1 - domW) * domRaw

      // If a confident delay estimate sits near/beyond the tail, the echo is
      // (partly) outside the filter — flag it so the logs explain leftover echo.
      const delayOutOfRange = delayCorr > 0.3 && delayMs > tailMs * 0.8
      this.port.postMessage({
        type: "metrics",
        erle: Math.round(erle * 10) / 10,
        linErle: Math.round(linErle * 10) / 10,
        resDb: Math.round((erle - linErle) * 10) / 10,
        echoDom: Math.round(this.echoDom * 100) / 100,
        partitions: PARTITIONS,
        tailMs,
        adapting: refActive,
        diverging,
        delayMs: Math.round(delayMs),
        delayCorr: Math.round(delayCorr * 100) / 100,
        delayOutOfRange,
      })
      this.mPrimary = 0
      this.mErr = 0
      this.mErrLin = 0
      this.mSamples = 0
    }

    return true
  }
}

registerProcessor("screen-aec", ScreenAEC)
