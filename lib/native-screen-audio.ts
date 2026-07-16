"use client"

const SAMPLE_RATE = 48000
const WORKLET_URL = "/pcm-capture-worklet.js?v=3"
const PREBUFFER_TIMEOUT_MS = 3000

export interface NativeScreenAudio {
  track: MediaStreamTrack
  stop: () => void
}

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

export async function startNativeScreenAudio(): Promise<NativeScreenAudio | null> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined
  if (!api?.isElectron) return null

  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let dest: MediaStreamAudioDestinationNode | null = null
  let unsubData: (() => void) | null = null
  let unsubEnded: (() => void) | null = null
  let helperStarted = false
  let stopped = false

  const teardown = (stopHelper: boolean) => {
    if (stopped) return
    stopped = true
    try { node?.port.postMessage({ type: stopHelper ? "stop" : "end" }) } catch { /* ignore */ }
    unsubData?.()
    unsubEnded?.()
    if (stopHelper && helperStarted) {
      try { void api.stopAudioCapture() } catch { /* ignore */ }
    }
    try { node?.disconnect() } catch { /* ignore */ }
    try { dest?.stream.getTracks().forEach((track) => track.stop()) } catch { /* ignore */ }
    try { if (ctx) void ctx.close() } catch { /* ignore */ }
    if (workletLoadedFor === ctx) workletLoadedFor = null
  }

  try {
    const support = await api.getAudioCaptureSupport()
    if (!support?.supported) {
      console.log("[v0] Native screen audio unavailable:", support?.reason)
      return null
    }

    const AudioCtx = window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AudioCtx({ sampleRate: SAMPLE_RATE })
    if (ctx.state === "suspended") {
      try { await ctx.resume() } catch { /* user gesture may resume it shortly */ }
    }

    if (!(await ensureWorklet(ctx))) {
      teardown(false)
      console.log("[v0] Native screen audio: worklet failed to load")
      return null
    }

    node = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    dest = ctx.createMediaStreamDestination()
    node.connect(dest)

    let markReady: (() => void) | null = null
    const ready = new Promise<void>((resolve) => { markReady = resolve })

    node.port.onmessage = (event: MessageEvent<{
      type?: string
      fillFrames?: number
      readRate?: number
      underruns?: number
      overflows?: number
      invalidSamples?: number
      resets?: number
    }>) => {
      const message = event.data
      if (message?.type === "ready") {
        markReady?.()
        markReady = null
        return
      }
      if (message?.type !== "metrics") return
      console.log("[v0] Native screen audio buffer recovery:", {
        fillMs: Math.round(((message.fillFrames ?? 0) / SAMPLE_RATE) * 1000),
        readRate: message.readRate?.toFixed(6),
        underruns: message.underruns,
        overflows: message.overflows,
        invalidSamples: message.invalidSamples,
        resets: message.resets,
      })
    }

    // Subscribe before spawning the helper so its first PCM packet cannot be lost.
    let leftover = new Uint8Array(0)
    unsubData = api.onAudioCaptureData((chunk) => {
      if (stopped || !node) return
      const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const bytes = new Uint8Array(leftover.length + incoming.length)
      bytes.set(leftover)
      bytes.set(incoming, leftover.length)

      const frameBytes = 2 * Float32Array.BYTES_PER_ELEMENT
      const usableBytes = bytes.length - (bytes.length % frameBytes)
      if (usableBytes < frameBytes) {
        leftover = bytes
        return
      }
      leftover = bytes.slice(usableBytes)
      const aligned = bytes.slice(0, usableBytes)
      const samples = new Float32Array(aligned.buffer, aligned.byteOffset, usableBytes / 4)
      node.port.postMessage({ samples }, [aligned.buffer])
    })

    unsubEnded = api.onAudioCaptureEnded((code) => {
      console.log("[v0] Native screen audio: helper process ended", code)
      teardown(false)
    })

    const started = await api.startAudioCapture()
    if (!started?.supported) {
      teardown(false)
      console.log("[v0] Native screen audio: helper failed to start:", started?.reason)
      return null
    }
    helperStarted = true

    // Do not publish a track while the worklet is still empty. This avoids the
    // initial starvation burst that was especially audible for window capture.
    const prebuffered = await Promise.race([
      ready.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), PREBUFFER_TIMEOUT_MS)),
    ])
    if (!prebuffered || stopped) {
      teardown(true)
      console.log("[v0] Native screen audio: PCM prebuffer timed out")
      return null
    }

    const track = dest.stream.getAudioTracks()[0]
    if (!track) {
      teardown(true)
      return null
    }
    nativeTracks.add(track)

    const stop = () => teardown(true)
    track.addEventListener("ended", stop, { once: true })
    console.log("[v0] Native screen audio active: process-loopback track ready")
    return { track, stop }
  } catch (error) {
    teardown(true)
    console.log("[v0] Native screen audio setup failed:", error)
    return null
  }
}
