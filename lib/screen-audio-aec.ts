"use client"

// ---------------------------------------------------------------------------
// Screen-share Acoustic Echo Cancellation wiring.
//
// Builds the Web Audio graph that removes the "own voice" echo from captured
// system audio before it is published to other participants:
//
//   screen system audio ──▶ [input 0]
//                                     ╲
//                                      ▶ ScreenAEC worklet ──▶ MediaStreamDest ──▶ published track
//                                     ╱
//   remote voices (reference) ─▶ [input 1]
//
// The worklet (public/aec-worklet.js) adaptively subtracts the reference (the
// exact mix of remote voices this machine plays) from the captured audio, so
// the listener no longer hears themselves — while YouTube/game/music audio in
// the shared screen is preserved.
//
// Everything is best-effort: if the AudioContext, worklet, or reference tap is
// unavailable, `createScreenShareAEC` returns null and the caller publishes the
// raw captured track unchanged (no regression).
// ---------------------------------------------------------------------------

import { getSharedAudioContext, getRemoteAudioReferenceNode } from "./audio-unlock"

export interface ScreenAudioAEC {
  /** The cleaned audio track to publish instead of the raw captured track. */
  track: MediaStreamTrack
  /** Tear down the AEC graph. Safe to call multiple times. */
  stop: () => void
}

// Flip to true to log AEC convergence (ERLE / delay coverage) to the console.
// Handy for verifying the echo canceller actually locks on across browsers.
const AEC_DEBUG = true

// Bump this whenever public/aec-worklet.js changes. It is appended as a query
// string to the module URL so browsers never serve a stale cached worklet —
// AudioWorklet modules are cached aggressively, so without this a fresh deploy
// can keep running the OLD echo-cancellation code (e.g. missing the residual
// suppressor) even after `pnpm build` + restart.
const AEC_WORKLET_VERSION = "8-deep-echo-gate"

let workletModuleLoaded = false

async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  if (workletModuleLoaded) return true
  if (!ctx.audioWorklet) return false
  try {
    await ctx.audioWorklet.addModule(`/aec-worklet.js?v=${AEC_WORKLET_VERSION}`)
    workletModuleLoaded = true
    if (AEC_DEBUG) console.log(`[v0] AEC worklet loaded (v=${AEC_WORKLET_VERSION})`)
    return true
  } catch {
    return false
  }
}

// Wrap a raw captured screen-audio track with echo cancellation. Returns the
// processed track (mono) to publish, or null when AEC can't be set up.
export async function createScreenShareAEC(
  rawTrack: MediaStreamTrack,
): Promise<ScreenAudioAEC | null> {
  try {
    if (!rawTrack || rawTrack.kind !== "audio") {
      if (AEC_DEBUG) console.log("[v0] AEC skipped: no audio track", { rawTrack })
      return null
    }

    if (AEC_DEBUG) {
      const s = rawTrack.getSettings() as MediaTrackSettings & { displaySurface?: string; restrictOwnAudio?: boolean }
      console.log("[v0] AEC setup: captured audio settings", {
        displaySurface: s.displaySurface,
        restrictOwnAudio: s.restrictOwnAudio,
        label: rawTrack.label,
      })
    }

    const ctx = getSharedAudioContext()
    if (!ctx) {
      if (AEC_DEBUG) console.log("[v0] AEC returned null: no AudioContext")
      return null
    }
    if (ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {
        /* ignore — we're likely inside a user gesture already */
      }
    }
    if (AEC_DEBUG) console.log("[v0] AEC: AudioContext state =", ctx.state)

    const ok = await ensureWorklet(ctx)
    if (!ok) {
      if (AEC_DEBUG) console.log("[v0] AEC returned null: worklet module failed to load (/aec-worklet.js)")
      return null
    }

    const reference = getRemoteAudioReferenceNode()
    if (!reference) {
      if (AEC_DEBUG) console.log("[v0] AEC returned null: no remote-audio reference node (nobody's audio routed yet?)")
      return null
    }
    if (AEC_DEBUG) console.log("[v0] AEC: reference bus acquired, wiring worklet…")

    // Source: the captured system audio track only (isolated stream).
    const primaryStream = new MediaStream([rawTrack])
    const primarySource = ctx.createMediaStreamSource(primaryStream)

    const aecNode = new AudioWorkletNode(ctx, "screen-aec", {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // Force mono processing regardless of how many channels each input has.
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    })

    if (AEC_DEBUG) {
      aecNode.port.onmessage = (e) => {
        const d = e.data
        if (d && d.type === "metrics") {
          const delay =
            typeof d.delayMs === "number"
              ? ` | echo delay ~${d.delayMs}ms (corr ${d.delayCorr})${d.delayOutOfRange ? " ⚠ OUT OF RANGE" : ""}`
              : ""
          // linear-only vs post-RES ERLE + how much the RES added + the echo-
          // dominance that is driving the adaptive suppressor. This tells us
          // exactly which stage is the bottleneck when echo is still audible.
          const stages =
            typeof d.linErle === "number"
              ? ` (lin ${d.linErle} dB, RES +${d.resDb} dB, dom ${d.echoDom})`
              : ""
          console.log(
            `[v0] AEC ERLE ${d.erle} dB${stages} | tail ${d.tailMs}ms (${d.partitions} part) | adapting=${d.adapting}${d.diverging ? " | BYPASS (diverging)" : ""}${delay}`,
          )
        }
      }
    }

    primarySource.connect(aecNode, 0, 0) // input 0 = captured system audio
    reference.connect(aecNode, 0, 1) // input 1 = remote voices reference

    const dest = ctx.createMediaStreamDestination()
    aecNode.connect(dest)

    const track = dest.stream.getAudioTracks()[0]
    if (!track) {
      try {
        primarySource.disconnect()
      } catch {
        /* ignore */
      }
      try {
        reference.disconnect(aecNode)
      } catch {
        /* ignore */
      }
      return null
    }

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      try {
        aecNode.port.postMessage({ type: "stop" })
      } catch {
        /* ignore */
      }
      try {
        primarySource.disconnect()
      } catch {
        /* ignore */
      }
      try {
        // Only detach the branch feeding this node; the shared reference bus
        // stays intact for any other/future AEC instance.
        reference.disconnect(aecNode)
      } catch {
        /* ignore */
      }
      try {
        aecNode.disconnect()
      } catch {
        /* ignore */
      }
      try {
        dest.stream.getTracks().forEach((t) => t.stop())
      } catch {
        /* ignore */
      }
    }

    if (AEC_DEBUG) console.log("[v0] AEC active: publishing echo-cancelled track")
    return { track, stop }
  } catch (err) {
    if (AEC_DEBUG) console.log("[v0] AEC returned null: exception during setup", err)
    return null
  }
}
