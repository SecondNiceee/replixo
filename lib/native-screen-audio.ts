"use client"

// ---------------------------------------------------------------------------
// Variant A (about/echo-fix/plan.md): turn the native WASAPI process-loopback
// PCM stream into a MediaStreamTrack the app can publish as screen-share audio.
//
//   native helper (system mix − Electron process tree)
//        │  raw float32/48k/stereo PCM over Electron IPC
//        ▼
//   pcm-capture AudioWorklet (ring buffer)  ──▶ MediaStreamDestination ──▶ track
//
// Because the capture already excludes our own process tree at the OS level,
// the participants' voices are physically gone before capture — no echo and no
// need for the DSP AEC worklet. This is the deterministic desktop echo fix.
//
// Everything is best-effort: if Electron / the helper / the OS build is not
// available, `startNativeScreenAudio` returns null and the caller falls back to
// the previous loopback + AEC path (no regression).
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 48000
const WORKLET_URL = "/pcm-capture-worklet.js"

export interface NativeScreenAudio {
  /** The captured system-audio track (participants excluded) to publish. */
  track: MediaStreamTrack
  /** Tear down the native capture graph. Safe to call multiple times. */
  stop: () => void
}

// Tracks produced by this module, so the screen-share code can tell a native
// (already echo-free) track apart from a raw loopback track and skip the AEC.
const nativeTracks = new WeakSet<MediaStreamTrack>()

export function isNativeScreenAudioTrack(track: MediaStreamTrack | null | undefined): boolean {
  return !!track && nativeTracks.has(track)
}

let workletLoadedFor: AudioContext | null = null

async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  if (workletLoadedFor === ctx) return true
  if (!ctx.audioWorklet) return false
  try {
    await ctx.audioWorklet.addModule(WORKLET_URL)
    workletLoadedFor = ctx
    return true
  } catch {
    return false
  }
}

/**
 * Start native process-loopback capture and return an echo-free audio track.
 * Returns null when unavailable (non-Electron, old Windows, missing helper,
 * or any setup failure) so the caller can fall back gracefully.
 */
export async function startNativeScreenAudio(): Promise<NativeScreenAudio | null> {
  try {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined
    if (!api?.isElectron) return null

    const support = await api.getAudioCaptureSupport()
    if (!support?.supported) {
      console.log("[v0] Native screen audio unavailable:", support?.reason)
      return null
    }

    // Dedicated context at the helper's native rate so PCM needs no resampling.
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtx({ sampleRate: SAMPLE_RATE })
    if (ctx.state === "suspended") {
      try { await ctx.resume() } catch { /* likely inside a user gesture */ }
    }

    const ok = await ensureWorklet(ctx)
    if (!ok) {
      try { await ctx.close() } catch { /* ignore */ }
      console.log("[v0] Native screen audio: worklet failed to load")
      return null
    }

    const node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    const dest = ctx.createMediaStreamDestination()
    node.connect(dest)

    // Start the helper process in main. Bail out cleanly on failure.
    const started = await api.startAudioCapture()
    if (!started?.supported) {
      try { node.disconnect() } catch { /* ignore */ }
      try { await ctx.close() } catch { /* ignore */ }
      console.log("[v0] Native screen audio: helper failed to start:", started?.reason)
      return null
    }

    // Feed IPC PCM chunks into the worklet. Bytes may arrive unaligned/partial,
    // so buffer a leftover tail and only forward whole stereo float32 frames.
    let leftover = new Uint8Array(0)
    const unsubData = api.onAudioCaptureData((chunk) => {
      // Concatenate any previous partial-sample tail with the new bytes.
      let bytes: Uint8Array
      if (leftover.length) {
        bytes = new Uint8Array(leftover.length + chunk.length)
        bytes.set(leftover, 0)
        bytes.set(chunk, leftover.length)
      } else {
        bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      }

      const bytesPerStereoFrame = 2 * Float32Array.BYTES_PER_ELEMENT
      const usableBytes = bytes.length - (bytes.length % bytesPerStereoFrame)
      if (usableBytes < bytesPerStereoFrame) {
        leftover = bytes.slice(0)
        return
      }
      leftover = bytes.slice(usableBytes)

      // Copy into a fresh 4-byte-aligned buffer before viewing as Float32.
      const aligned = new Uint8Array(usableBytes)
      aligned.set(bytes.subarray(0, usableBytes))
      const samples = new Float32Array(aligned.buffer)
      node.port.postMessage({ samples }, [aligned.buffer])
    })

    const unsubEnded = api.onAudioCaptureEnded(() => {
      console.log("[v0] Native screen audio: helper process ended")
    })

    const track = dest.stream.getAudioTracks()[0]
    if (!track) {
      unsubData()
      unsubEnded()
      try { await api.stopAudioCapture() } catch { /* ignore */ }
      try { node.disconnect() } catch { /* ignore */ }
      try { await ctx.close() } catch { /* ignore */ }
      return null
    }
    nativeTracks.add(track)

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      try { node.port.postMessage({ type: "stop" }) } catch { /* ignore */ }
      unsubData()
      unsubEnded()
      try { void api.stopAudioCapture() } catch { /* ignore */ }
      try { node.disconnect() } catch { /* ignore */ }
      try { dest.stream.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
      try { void ctx.close() } catch { /* ignore */ }
      if (workletLoadedFor === ctx) workletLoadedFor = null
    }

    // If the track is stopped elsewhere (e.g. stopScreenShare), tear down too.
    track.addEventListener("ended", stop)

    console.log("[v0] Native screen audio active: process-loopback track ready")
    return { track, stop }
  } catch (err) {
    console.log("[v0] Native screen audio setup failed:", err)
    return null
  }
}
