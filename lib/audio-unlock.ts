"use client"

// ---------------------------------------------------------------------------
// Centralised remote-audio playback manager.
//
// Every remote stream is routed through a shared AudioContext on ALL platforms:
//   createMediaStreamSource(stream) → gain → destination
// This serves two purposes:
//   1. Reliable playback on iOS Safari, where <audio srcObject=...> is often
//      silenced even after a tap.
//   2. Reliable per-user volume control everywhere — setting <audio>.volume on
//      a remote WebRTC MediaStream is ignored by several desktop browsers, so
//      the gain node is the authoritative volume control.
// The AudioContext must be created/resumed inside a user gesture. The <audio>
// element stays attached but muted (it satisfies Chrome's remote-MediaStream
// quirk). If no AudioContext is available we fall back to plain element play().
// ---------------------------------------------------------------------------

const audioElements = new Set<HTMLAudioElement>()
const blockedListeners = new Set<(blocked: boolean) => void>()

let blocked = false
let gestureBound = false

// Shared AudioContext — created/resumed on first user gesture.
let sharedAudioContext: AudioContext | null = null

// stream → { source, destination } nodes kept alive while the stream is registered.
interface AudioNodes {
  source: MediaStreamAudioSourceNode
  gain: GainNode
}
const streamNodes = new Map<MediaStream, AudioNodes>()

// Desired volume (0..1) per stream, applied to the gain node when it exists.
// Stored separately so a volume set before the node is created still applies.
const streamVolumes = new Map<MediaStream, number>()

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!sharedAudioContext) {
    try {
      sharedAudioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    } catch {
      return null
    }
  }
  return sharedAudioContext
}

function setBlocked(next: boolean) {
  if (next === blocked) return
  blocked = next
  blockedListeners.forEach((cb) => cb(blocked))
}

// Resume the shared AudioContext (all remote audio is routed through it) and
// attempt to play every registered audio element. Because audio now plays via
// the AudioContext gain graph, the blocked state is derived from whether the
// context is allowed to run rather than from individual element rejections.
export function playAll() {
  // Kick the (muted) elements too — harmless and keeps srcObject "live".
  audioElements.forEach((el) => {
    if (!el.srcObject) return
    const p = el.play()
    if (p && typeof p.then === "function") p.catch(() => {})
  })

  const ctx = getAudioContext()
  if (!ctx) {
    setBlocked(false)
    return
  }
  ctx
    .resume()
    .then(() => setBlocked(ctx.state !== "running"))
    .catch(() => setBlocked(true))
}

function handleGesture() {
  playAll()
}

function bindGestureListeners() {
  if (gestureBound || typeof window === "undefined") return
  gestureBound = true
  window.addEventListener("pointerdown", handleGesture)
  window.addEventListener("keydown", handleGesture)
  window.addEventListener("touchstart", handleGesture, { passive: true })
}

// ---------------------------------------------------------------------------
// iOS AudioContext routing for a MediaStream
// ---------------------------------------------------------------------------
function connectStreamToContext(stream: MediaStream): boolean {
  const ctx = getAudioContext()
  if (!ctx) return false
  if (streamNodes.has(stream)) return true
  try {
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    // Apply any volume that was requested before the node existed.
    const desired = streamVolumes.get(stream)
    gain.gain.value = desired ?? 1
    source.connect(gain)
    gain.connect(ctx.destination)
    streamNodes.set(stream, { source, gain })
    return true
  } catch {
    // MediaStream may not have audio tracks yet — ignore
    return false
  }
}

function disconnectStreamFromContext(stream: MediaStream) {
  const nodes = streamNodes.get(stream)
  if (!nodes) return
  try {
    nodes.source.disconnect()
    nodes.gain.disconnect()
  } catch { /* ignore */ }
  streamNodes.delete(stream)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Set per-stream playback volume (0..1). Works on both the iOS AudioContext
// path (via the gain node) and is a no-op-safe store otherwise. Returns true
// if the stream is routed through the AudioContext (i.e. the <audio> element's
// own .volume will be ignored and this is the only thing that changes volume).
export function setStreamVolume(stream: MediaStream | undefined | null, volume: number): boolean {
  if (!stream) return false
  const clamped = Math.max(0, Math.min(1, volume))
  streamVolumes.set(stream, clamped)
  const nodes = streamNodes.get(stream)
  if (nodes) {
    nodes.gain.gain.value = clamped
    return true
  }
  return false
}

// Register an audio element and route its stream through the AudioContext.
//
// Routing every remote stream through an AudioContext gain node (on ALL
// platforms, not just iOS) is the only reliable way to control per-user
// volume — setting <audio>.volume on a remote WebRTC MediaStream is ignored by
// several browsers. When routing succeeds the element is kept muted (it stays
// attached purely to satisfy Chrome's remote-MediaStream quirk and to avoid
// double playback). If the AudioContext is unavailable we fall back to plain
// element playback so audio still works.
export function registerAudioElement(el: HTMLAudioElement, stream?: MediaStream) {
  audioElements.add(el)
  bindGestureListeners()

  const routed = stream ? connectStreamToContext(stream) : false

  if (routed) {
    // AudioContext gain graph is the real audio path — mute the element.
    el.muted = true
    const ctx = getAudioContext()
    if (ctx) {
      ctx
        .resume()
        .then(() => setBlocked(ctx.state !== "running"))
        .catch(() => setBlocked(true))
    }
    // Muted play keeps the srcObject pipeline alive (harmless if it fails).
    const p = el.play()
    if (p && typeof p.then === "function") p.catch(() => {})
  } else {
    // Fallback: no AudioContext — play through the element directly.
    el.muted = false
    const p = el.play()
    if (p && typeof p.then === "function") {
      p.catch(() => setBlocked(true))
    }
  }

  return () => {
    audioElements.delete(el)
    if (stream) {
      disconnectStreamFromContext(stream)
      streamVolumes.delete(stream)
    }
  }
}

// Subscribe to blocked-state changes. Returns an unsubscribe function.
export function subscribeBlocked(cb: (blocked: boolean) => void) {
  blockedListeners.add(cb)
  cb(blocked)
  return () => {
    blockedListeners.delete(cb)
  }
}

export function isAudioBlocked() {
  return blocked
}
