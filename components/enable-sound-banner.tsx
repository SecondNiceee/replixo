"use client"

import { useEffect, useState } from "react"
import { Volume2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { subscribeBlocked, playAll } from "@/lib/audio-unlock"

// Shown only when the browser has blocked remote-audio playback. Clicking the
// button counts as a user gesture and unblocks sound for everyone in the call.
export function EnableSoundBanner() {
  const [blocked, setBlocked] = useState(false)

  useEffect(() => subscribeBlocked(setBlocked), [])

  if (!blocked) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-50 flex justify-center px-4">
      <Button
        onClick={() => playAll()}
        size="sm"
        className="pointer-events-auto gap-2 rounded-full shadow-lg"
      >
        <Volume2 className="size-4" aria-hidden="true" />
        Включить звук
      </Button>
    </div>
  )
}
