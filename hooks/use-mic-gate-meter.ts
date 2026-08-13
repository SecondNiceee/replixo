"use client"

import { useEffect, useState } from "react"
import { subscribeMicGateLevel, hasActiveMicGate, type MicGateLevel } from "@/lib/mic-gate"

const IDLE: MicGateLevel = { level: 0, threshold: 0, open: false }

// A gate reports every ~50 ms. If nothing arrives for this long the microphone
// is not running (muted-and-released, permission revoked, gate unavailable), and
// the meter must say so instead of freezing on the last value.
const STALE_MS = 700

export interface MicGateMeter extends MicGateLevel {
  /** True while the gate is actually delivering measurements. */
  live: boolean
}

/**
 * Live microphone level as measured *inside* the noise gate, together with the
 * threshold it is compared against. Only subscribes while `active` is true, so a
 * closed settings dialog costs nothing.
 */
export function useMicGateMeter(active: boolean): MicGateMeter {
  const [state, setState] = useState<MicGateMeter>({ ...IDLE, live: false })

  useEffect(() => {
    if (!active) {
      setState({ ...IDLE, live: false })
      return
    }

    let lastReport = Date.now()
    setState({ ...IDLE, live: hasActiveMicGate() })

    const unsubscribe = subscribeMicGateLevel((next) => {
      lastReport = Date.now()
      setState({ ...next, live: true })
    })

    const staleTimer = setInterval(() => {
      if (Date.now() - lastReport < STALE_MS) return
      setState((prev) => (prev.live ? { ...IDLE, live: false } : prev))
    }, STALE_MS)

    return () => {
      unsubscribe()
      clearInterval(staleTimer)
    }
  }, [active])

  return state
}
