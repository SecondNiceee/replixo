"use client"

import { useState, useEffect, useCallback } from "react"

export interface AudioDevice {
  deviceId: string
  label: string
}

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([])

  const refresh = useCallback(async () => {
    try {
      // enumerate without asking permission first — labels may be empty
      let list = await navigator.mediaDevices.enumerateDevices()
      let mics = list.filter((d) => d.kind === "audioinput")

      // If labels are empty we need to request permission once to get real names
      if (mics.length > 0 && !mics[0].label) {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        tempStream.getTracks().forEach((t) => t.stop())
        list = await navigator.mediaDevices.enumerateDevices()
        mics = list.filter((d) => d.kind === "audioinput")
      }

      setDevices(
        mics.map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Микрофон ${i + 1}`,
        })),
      )
    } catch {
      // permission denied — no devices available
      setDevices([])
    }
  }, [])

  useEffect(() => {
    refresh()
    navigator.mediaDevices.addEventListener("devicechange", refresh)
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh)
  }, [refresh])

  return { devices, refresh }
}
