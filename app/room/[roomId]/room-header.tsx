"use client"

import { Copy, Check, Pencil, Settings } from "lucide-react"
import { useState, useCallback } from "react"
import { EditNameDialog } from "@/components/edit-name-dialog"
import { RoomSettingsDialog } from "./room-settings-dialog"
import { cn } from "@/lib/utils"

interface RoomHeaderProps {
  roomId: string
  displayName: string
  status: string
  participantCount: number
  isFixed?: boolean
}

export function RoomHeader({ roomId, displayName, status, participantCount, isFixed = false }: RoomHeaderProps) {
  const [copied, setCopied] = useState(false)
  const [editNameOpen, setEditNameOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(roomId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [roomId])

  const handleNameSaved = useCallback(() => {
    window.location.reload()
  }, [])

  return (
    <>
      <header className={cn(
        "left-0 right-0 z-50 flex items-center justify-between px-5 py-3 bg-transparent border-b border-transparent",
        isFixed ? "fixed top-0" : "relative",
      )}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-foreground">Replixo</span>
          <span className="h-4 w-px bg-border" />
          <button
            onClick={handleCopyCode}
            className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs font-mono text-muted-foreground transition-colors hover:text-foreground"
          >
            {roomId}
            {copied ? (
              <Check className="size-3 text-green-500" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setEditNameOpen(true)}
            className="group flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Изменить имя"
          >
            <span className="max-w-[120px] truncate font-medium">{displayName}</span>
            <Pencil className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
          </button>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                status === "connected" ? "bg-green-500" : "bg-muted-foreground",
              )}
            />
            <span className="text-xs text-muted-foreground">
              {participantCount} участник{participantCount !== 1 ? "а" : ""}
            </span>
          </div>
          <span className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Настройки"
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </header>

      <EditNameDialog
        open={editNameOpen}
        onOpenChange={setEditNameOpen}
        currentName={displayName}
        onSaved={handleNameSaved}
      />

      <RoomSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  )
}
