"use client"

// ---------------------------------------------------------------------------
// Centralised remote-audio playback manager.
//
// On iOS Safari, <audio srcObject=...> is unreliable — the element is often
// silenced even after the user has tapped. The workaround is to route every
// remote stream through an AudioContext:
//   createMediaStreamSource(stream) → destination → context plays out loud
// The AudioContext must be created (or resumed) inside a user gesture.
//
// On desktop browsers we keep the plain <audio>.play() path as a fallback.
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

function resumeContext() {
  const ctx = getAudioContext()
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// iOS detection — use AudioContext path on mobile Safari
// ---------------------------------------------------------------------------
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

function setBlocked(next: boolean) {
  if (next === blocked) return
  blocked = next
  blockedListeners.forEach((cb) => cb(blocked))
}

// Try to play every registered audio element. Resolves the blocked state
// based on whether any element was rejected by the autoplay policy.
export function playAll() {
  // Resume the AudioContext first (unlocks iOS audio in one shot).
  resumeContext()

  let anyBlocked = false
  const attempts: Promise<void>[] = []

  audioElements.forEach((el) => {
    if (!el.srcObject) return
    const p = el.play()
    if (p && typeof p.then === "function") {
      attempts.push(
        p
          .then(() => {})
          .catch(() => {
            anyBlocked = true
          }),
      )
    }
  })

  Promise.allSettled(attempts).then(() => setBlocked(anyBlocked))
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
function connectStreamToContext(stream: MediaStream) {
  const ctx = getAudioContext()
  if (!ctx || streamNodes.has(stream)) return
  try {
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    // Apply any volume that was requested before the node existed.
    const desired = streamVolumes.get(stream)
    gain.gain.value = desired ?? 1
    source.connect(gain)
    gain.connect(ctx.destination)
    streamNodes.set(stream, { source, gain })
  } catch {
    // MediaStream may not have audio tracks yet — ignore
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

// Register an audio element (and optionally a raw MediaStream for iOS routing).
export function registerAudioElement(el: HTMLAudioElement, stream?: MediaStream) {
  audioElements.add(el)
  bindGestureListeners()

  if (isIOS() && stream) {
    // On iOS: route stream through AudioContext so it plays reliably.
    // We still set srcObject so the element exists, but mute it to avoid
    // double playback — the AudioContext graph is the real audio path.
    el.muted = true
    connectStreamToContext(stream)
    resumeContext()
  } else {
    // Desktop / non-iOS path: plain element play().
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
