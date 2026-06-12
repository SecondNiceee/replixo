"use client"

import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

interface RoomStatusProps {
  status: "idle" | "connecting" | "connected" | "disconnected" | "error"
  error: string | null
  roomId: string
}

export function RoomStatus({ status, error, roomId }: RoomStatusProps) {
  const router = useRouter()

  if (status === "idle" || status === "connecting") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <div className="size-10 animate-spin rounded-full border-2 border-border border-t-foreground" />
        <p className="text-sm text-muted-foreground">Подключение к комнате {roomId}…</p>
      </div>
    )
  }

  if (status === "error") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.push("/")}>
          На главную
        </Button>
      </div>
    )
  }

  if (status === "disconnected") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background">
        <p className="text-sm text-muted-foreground">Вы покинули комнату</p>
        <Button variant="outline" onClick={() => router.push("/")}>
          На главную
        </Button>
      </div>
    )
  }

  return null
}
