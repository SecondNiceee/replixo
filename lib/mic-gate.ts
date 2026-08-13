"use client"

// ---------------------------------------------------------------------------
// Microphone capture with the noise gate ("Gate / шумоподавление") attached.
//
// Every place that acquires the microphone goes through `captureMic()` instead
// of calling getUserMedia directly, so the gate is impossible to forget:
//
//   getUserMedia(voice constraints) ──▶ mic-noise-gate worklet ──▶ dest track
//                                                                  (published)
//
// The PUBLISHED track is therefore the WebAudio destination track, not the raw
// device track. Two consequences the rest of the app relies on:
//
//   1. Muting still works exactly as before — `track.enabled = false` on the
//      destination track silences the sender just like it does on a device
//      track.
//   2. A destination track never "ends" on its own, so it would hide device
//      loss (unplugged headset, OS reclaim) from the recovery paths that check
//      `readyState === "ended"`. We therefore mirror the raw track's `ended`
//      event onto the destination track by stopping it.
//
// Ownership: the raw device track is invisible to callers, so releasing capture
// MUST go through `releaseMicTrack()` — stopping the published track alone
// would leave the microphone open (and the OS recording indicator lit).
//
// Everything degrades gracefully. If the AudioContext is unavailable or
// suspended, or the worklet module fails to load, `captureMic()` publishes the
// RAW track: the gate is silently unavailable, but audio is never at risk of
// being replaced by a silent WebAudio graph.
// ---------------------------------------------------------------------------

import { getSharedAudioContext } from "./audio-unlock"
import { getVoiceAudioConstraints } from "./media-constraints"
import { useRoomSettingsStore } from "@/stores/room-settings-store"

// Bump when public/noise-gate-worklet.js changes — AudioWorklet modules are
// cached aggressively, so without this a deploy can keep running the old gate.
const WORKLET_VERSION = "3"

export interface MicCapture {
  /** The track to publish and to keep inside the local stream. */
  track: MediaStreamTrack
  /** deviceId the browser actually granted (read from the raw device track). */
  deviceId: string | null
  /** True when `track` is the gated output rather than the raw device track. */
  gated: boolean
}

interface Pipeline {
  raw: MediaStreamTrack
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  dest: MediaStreamAudioDestinationNode
  stop: () => void
}

/** Published track → its gate graph. */
const pipelines = new Map<MediaStreamTrack, Pipeline>()

let workletLoaded = false
let storeBound = false
let keepAliveTimer: ReturnType<typeof setInterval> | null = null

function gateEnabled(): boolean {
  return useRoomSettingsStore.getState().noiseGate
}

function gateStrength(): number {
  return useRoomSettingsStore.getState().noiseGateStrength
}

// Push the user's toggle / slider into every live gate. Bound lazily (never at
// import time) so nothing subscribes on the server or on pages without a call.
function bindStore() {
  if (storeBound) return
  storeBound = true
  useRoomSettingsStore.subscribe((state, prev) => {
    if (state.noiseGate !== prev.noiseGate) setNoiseGateEnabled(state.noiseGate)
    if (state.noiseGateStrength !== prev.noiseGateStrength) {
      setNoiseGateStrength(state.noiseGateStrength)
    }
  })
}

// The gate lives inside the shared AudioContext, and a suspended context
// produces SILENCE on its destination track — i.e. the user would be muted
// without knowing. Browsers suspend contexts on their own (tab backgrounded on
// mobile, audio focus loss), so nudge it back while any gate is live.
function startKeepAlive() {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(() => {
    const ctx = getSharedAudioContext()
    if (!ctx) return
    if (ctx.state === "suspended") ctx.resume().catch(() => {})
  }, 2000)
}

function stopKeepAliveIfIdle() {
  if (pipelines.size > 0 || !keepAliveTimer) return
  clearInterval(keepAliveTimer)
  keepAliveTimer = null
}

async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  if (workletLoaded) return true
  if (!ctx.audioWorklet) return false
  try {
    await ctx.audioWorklet.addModule(`/noise-gate-worklet.js?v=${WORKLET_VERSION}`)
    workletLoaded = true
    return true
  } catch {
    return false
  }
}

async function buildGate(raw: MediaStreamTrack): Promise<MediaStreamTrack | null> {
  try {
    const ctx = getSharedAudioContext()
    if (!ctx) return null
    if (ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {
        /* ignore — handled by the state check below */
      }
    }
    // Refuse to build on a context that isn't actually running: publishing its
    // destination track would silence the user completely.
    if (ctx.state !== "running") return null
    if (!(await ensureWorklet(ctx))) return null

    const source = ctx.createMediaStreamSource(new MediaStream([raw]))
    const node = new AudioWorkletNode(ctx, "mic-noise-gate", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: {
        enabled: gateEnabled(),
        sensitivity: gateStrength(),
        // A gate created while the settings meter is already open must start
        // reporting immediately, otherwise the bar stays dead until the user
        // touches something.
        metering: levelListeners.size > 0,
      },
    })
    node.port.onmessage = (event) => {
      const data = event.data as GateLevelMessage | undefined
      if (data?.type !== "level") return
      emitLevel(data)
    }
    const dest = ctx.createMediaStreamDestination()
    source.connect(node)
    node.connect(dest)

    const track = dest.stream.getAudioTracks()[0]
    if (!track) {
      try {
        source.disconnect()
        node.disconnect()
      } catch {
        /* ignore */
      }
      return null
    }

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      pipelines.delete(track)
      try {
        node.port.postMessage({ type: "stop" })
      } catch {
        /* ignore */
      }
      for (const disconnect of [() => source.disconnect(), () => node.disconnect()]) {
        try {
          disconnect()
        } catch {
          /* ignore */
        }
      }
      try {
        dest.stream.getTracks().forEach((t) => t.stop())
      } catch {
        /* ignore */
      }
      raw.stop()
      stopKeepAliveIfIdle()
    }

    // Device loss must surface on the published track, otherwise the rejoin /
    // recovery paths (which look for `readyState === "ended"`) would keep
    // publishing a permanently silent graph.
    raw.addEventListener("ended", () => stop())

    pipelines.set(track, { raw, source, node, dest, stop })
    startKeepAlive()
    return track
  } catch {
    return null
  }
}

/**
 * Acquire the microphone, wrapped in the noise gate when possible.
 * Rejects with the original getUserMedia error so callers can keep telling
 * "permission denied" apart from other failures.
 */
export async function captureMic(deviceId?: string): Promise<MicCapture> {
  bindStore()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: getVoiceAudioConstraints(deviceId),
  })
  const raw = stream.getAudioTracks()[0]
  if (!raw) throw new Error("Микрофон не вернул аудиодорожку")

  const grantedDeviceId = raw.getSettings().deviceId ?? deviceId ?? null

  const gated = await buildGate(raw)
  if (!gated) return { track: raw, deviceId: grantedDeviceId, gated: false }
  return { track: gated, deviceId: grantedDeviceId, gated: true }
}

/**
 * Stop a microphone track acquired via `captureMic`, including the hidden raw
 * device track behind a gated one. Safe to call with any track (a plain device
 * track is simply stopped) and safe to call twice.
 */
export function releaseMicTrack(track: MediaStreamTrack | null | undefined): void {
  if (!track) return
  const pipeline = pipelines.get(track)
  if (pipeline) {
    pipeline.stop()
    return
  }
  track.stop()
}

/** Apply the user's Gate preference to every live microphone pipeline. */
export function setNoiseGateEnabled(enabled: boolean): void {
  broadcast({ enabled })
}

/** Apply the Gate threshold handle (0..100 on the meter scale) to every live pipeline. */
export function setNoiseGateStrength(strength: number): void {
  broadcast({ sensitivity: Math.min(100, Math.max(0, Math.round(strength))) })
}

function broadcast(config: { enabled?: boolean; sensitivity?: number; metering?: boolean }) {
  for (const pipeline of pipelines.values()) {
    try {
      pipeline.node.port.postMessage({ type: "config", ...config })
    } catch {
      /* ignore — the graph is being torn down */
    }
  }
}

// ---------------------------------------------------------------------------
// Live level metering (for the Gate settings UI)
//
// The settings dialog draws the microphone level against the threshold the gate
// is actually using, which is the only honest way to explain the slider. The
// numbers can only come from the worklet, so they are relayed here; while nobody
// is listening the worklet posts nothing at all.
// ---------------------------------------------------------------------------

interface GateLevelMessage {
  type: "level"
  /** Peak RMS since the previous report, linear 0..1. */
  rms: number
  /** Open threshold the gate compared it against, linear 0..1. */
  threshold: number
  open: boolean
  gain: number
}

export interface MicGateLevel {
  /** Microphone level, 0..100 (mapped from dBFS so it reads like a VU meter). */
  level: number
  /** Where the gate's open threshold sits on the same 0..100 scale. */
  threshold: number
  /** True while the gate is letting audio through. */
  open: boolean
}

type LevelListener = (level: MicGateLevel) => void

const levelListeners = new Set<LevelListener>()

// -60 dBFS is inaudible in practice, 0 dBFS is clipping — mapping that span onto
// 0..100 makes quiet speech visible instead of a barely-moving nub.
const METER_FLOOR_DB = -60

/**
 * A meter position (0..100) back to dBFS — the UI labels the threshold handle
 * with it, because "-42 dB" is the only number that means anything to someone
 * who has tuned a mic before.
 */
export function meterPositionToDb(position: number): number {
  const clamped = Math.min(100, Math.max(0, position))
  return Math.round(METER_FLOOR_DB - (METER_FLOOR_DB * clamped) / 100)
}

function toMeterScale(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  const ratio = (db - METER_FLOOR_DB) / -METER_FLOOR_DB
  return Math.min(100, Math.max(0, Math.round(ratio * 100)))
}

function emitLevel(message: GateLevelMessage) {
  if (levelListeners.size === 0) return
  const payload: MicGateLevel = {
    level: toMeterScale(message.rms),
    threshold: toMeterScale(message.threshold),
    open: message.open,
  }
  for (const listener of levelListeners) {
    try {
      listener(payload)
    } catch {
      /* a broken consumer must not take the meter down */
    }
  }
}

/**
 * Subscribe to the microphone level as measured inside the gate.
 * Returns an unsubscribe function. Metering is turned on in the worklet for the
 * first listener and off again after the last one leaves.
 */
export function subscribeMicGateLevel(listener: LevelListener): () => void {
  levelListeners.add(listener)
  if (levelListeners.size === 1) broadcast({ metering: true })
  return () => {
    levelListeners.delete(listener)
    if (levelListeners.size === 0) broadcast({ metering: false })
  }
}

/** True when at least one gated microphone pipeline is live. */
export function hasActiveMicGate(): boolean {
  return pipelines.size > 0
}
