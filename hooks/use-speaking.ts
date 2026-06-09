"use client"

import { useEffect, useRef, useState } from "react"

// Shared AudioContext so we don't spawn one per tile.
let sharedCtx: AudioContext | null = null
function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!sharedCtx) {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    sharedCtx = new Ctx()
  }
  return sharedCtx
}

/**
 * Detects whether the audio track inside `stream` is currently producing sound
 * above a small threshold — used to render a Discord-style "speaking" ring.
 *
 * When the track is disabled (muted) the analyser reads silence, so a muted
 * participant is automatically reported as not speaking.
 */
export function useSpeaking(stream?: MediaStream | null, enabled = true): boolean {
  const [speaking, setSpeaking] = useState(false)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !stream) {
      setSpeaking(false)
      return
    }

    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      setSpeaking(false)
      return
    }

    const ctx = getAudioContext()
    if (!ctx) return

    // Resume context (it may start suspended before a user gesture).
    if (ctx.state === "suspended") ctx.resume().catch(() => {})

    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.3
    source.connect(analyser)

    const data = new Uint8Array(analyser.frequencyBinCount)
    let aboveSince = 0
    let belowSince = 0
    let current = false

    const THRESHOLD = 18 // average volume needed to count as speaking

    const tick = () => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i]
      const avg = sum / data.length
      const now = performance.now()

      if (avg > THRESHOLD) {
        belowSince = 0
        if (!aboveSince) aboveSince = now
        if (!current && now - aboveSince > 60) {
          current = true
          setSpeaking(true)
        }
      } else {
        aboveSince = 0
        if (!belowSince) belowSince = now
        // small hold so the ring doesn't flicker between words
        if (current && now - belowSince > 350) {
          current = false
          setSpeaking(false)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      source.disconnect()
      analyser.disconnect()
      setSpeaking(false)
    }
  }, [stream, enabled])

  return speaking
}
