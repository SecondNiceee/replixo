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

// A silent "tap" bus that carries the exact mix of every remote voice this
// machine plays. It is NOT connected to the speakers (ctx.destination already
// handles playback) — it exists purely so the screen-share echo canceller can
// use "what we're playing" as its far-end reference. See lib/screen-audio-aec.
let referenceBus: GainNode | null = null

function getReferenceBus(ctx: AudioContext): GainNode {
  if (!referenceBus) {
    referenceBus = ctx.createGain()
    referenceBus.gain.value = 1
    // Intentionally left unconnected to ctx.destination — it's a pure tap.
  }
  return referenceBus
}

// The mix of all remote participant audio currently being played, exposed as
// an AudioNode so the screen-share AEC can subtract it from captured system
// audio. Returns null when no AudioContext is available.
export function getRemoteAudioReferenceNode(): AudioNode | null {
  const ctx = getAudioContext()
  if (!ctx) return null
  return getReferenceBus(ctx)
}

// stream → { source, destination } nodes kept alive while the stream is registered.
interface AudioNodes {
  source: MediaStreamAudioSourceNode
  gain: GainNode
}
const streamNodes = new Map<MediaStream, AudioNodes>()

// stream → cleanup for a pending "unmute" listener. Remote WebRTC tracks from a
// mediasoup consumer start life MUTED (the consumer is created paused, then
// resumed), and Chromium will leave a MediaStreamAudioSourceNode PERMANENTLY
// silent if it's created while the track is still muted. So when a stream is
// registered before its track is flowing, we defer building the context node
// until the track fires `unmute`. This map lets us tear that listener down.
const pendingUnmute = new Map<MediaStream, () => void>()

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

// Public accessor so other modules (e.g. UI notification sounds) can reuse the
// same AudioContext that was unlocked on the first user gesture, instead of
// creating their own that browsers would keep suspended.
export function getSharedAudioContext(): AudioContext | null {
  return getAudioContext()
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
// Build the AudioContext gain graph for a stream. Returns true if the node
// graph is now live. Safe to call multiple times (no-op if already built).
function buildStreamNodes(ctx: AudioContext, stream: MediaStream, el?: HTMLAudioElement): boolean {
  if (streamNodes.has(stream)) return true
  try {
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    // Apply any volume that was requested before the node existed.
    const desired = streamVolumes.get(stream)
    gain.gain.value = desired ?? 1
    source.connect(gain)
    gain.connect(ctx.destination)
    // Also feed the AEC reference tap so the screen-share echo canceller knows
    // exactly which remote voices this machine is playing (see screen-audio-aec).
    gain.connect(getReferenceBus(ctx))
    streamNodes.set(stream, { source, gain })
    // The context path is now the real output — mute the element to avoid
    // playing the same audio twice.
    if (el) el.muted = true
    ctx.resume().then(() => setBlocked(ctx.state !== "running")).catch(() => setBlocked(true))
    return true
  } catch {
    return false
  }
}

// Route a stream through the shared AudioContext. Returns true when a live node
// graph exists RIGHT NOW (element should be muted); false when we're either
// falling back to plain element playback or deferring node creation until the
// remote track unmutes (in which case the element must keep playing so there's
// never a silent gap).
function connectStreamToContext(stream: MediaStream, el?: HTMLAudioElement): boolean {
  const ctx = getAudioContext()
  if (!ctx) return false
  if (streamNodes.has(stream)) return true

  const track = stream.getAudioTracks()[0]
  // No audio track yet — nothing to route.
  if (!track) return false

  // If the track is already flowing, build immediately (the common "worked"
  // path). Otherwise defer: creating the source node now would strand it in
  // permanent silence (Chromium). We wire an `unmute` listener that builds the
  // node the moment media actually starts, and we let the element play in the
  // meantime so the participant is audible right away.
  let built = false
  if (!track.muted) {
    built = buildStreamNodes(ctx, stream, el)
  }

  if (!streamNodes.has(stream)) {
    const onUnmute = () => buildStreamNodes(ctx, stream, el)
    track.addEventListener("unmute", onUnmute)
    pendingUnmute.set(stream, () => track.removeEventListener("unmute", onUnmute))
  }

  return built
}

function disconnectStreamFromContext(stream: MediaStream) {
  // Tear down any pending "unmute" listener first (the node may never have been
  // built if the track never started flowing).
  const cancelPending = pendingUnmute.get(stream)
  if (cancelPending) {
    cancelPending()
    pendingUnmute.delete(stream)
  }
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
  // Allow boosting above 1 (100%) via the gain node — up to 4x. The slider in
  // the UI tops out at 2 (200%); the extra headroom is just a safety margin.
  const clamped = Math.max(0, Math.min(4, volume))
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

  const routed = stream ? connectStreamToContext(stream, el) : false

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
    // Not routed yet: either there's no AudioContext at all, or node creation
    // is DEFERRED until the remote track unmutes (see connectStreamToContext).
    // In both cases play the element directly so the participant is audible.
    // When the deferred node is later built, buildStreamNodes() mutes this
    // element to prevent double playback.
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
