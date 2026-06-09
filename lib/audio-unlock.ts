"use client"

// ---------------------------------------------------------------------------
// Centralised remote-audio playback manager.
//
// Browsers block audio playback with sound until the user has interacted with
// the *current* document. Because the user navigates from the lobby into the
// room (a new document), that gesture does not carry over, so the first
// play() on a remote <audio> element is often rejected. There is no way to
// bypass this policy programmatically — the best we can do is:
//   1. Retry playback automatically on the very first user gesture
//      (pointerdown / keydown / touchstart) anywhere on the page.
//   2. Expose whether audio is currently blocked so the UI can show an
//      explicit "Enable sound" button as a guaranteed one-click fix.
// ---------------------------------------------------------------------------

const audioElements = new Set<HTMLAudioElement>()
const blockedListeners = new Set<(blocked: boolean) => void>()

let blocked = false
let gestureBound = false

function setBlocked(next: boolean) {
  if (next === blocked) return
  blocked = next
  blockedListeners.forEach((cb) => cb(blocked))
}

// Try to play every registered audio element. Resolves the blocked state
// based on whether any element was rejected by the autoplay policy.
export function playAll() {
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
  // `once: false` because a single element might still need a retry, but
  // playAll() will flip the blocked flag to false once everything plays.
  window.addEventListener("pointerdown", handleGesture)
  window.addEventListener("keydown", handleGesture)
  window.addEventListener("touchstart", handleGesture)
}

// Register an audio element and immediately try to play it.
export function registerAudioElement(el: HTMLAudioElement) {
  audioElements.add(el)
  bindGestureListeners()

  const p = el.play()
  if (p && typeof p.then === "function") {
    p.catch(() => setBlocked(true))
  }

  return () => {
    audioElements.delete(el)
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
