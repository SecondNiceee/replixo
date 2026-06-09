"use client"

import { useState } from "react"
import { Check } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setDisplayName, DEFAULT_NAME } from "@/lib/display-name"

interface EditNameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentName: string
  onSaved?: () => void
}

export function EditNameDialog({ open, onOpenChange, currentName, onSaved }: EditNameDialogProps) {
  const [value, setValue] = useState(currentName === DEFAULT_NAME ? "" : currentName)

  function handleSave() {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    setDisplayName(trimmed)
    onOpenChange(false)
    onSaved?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ваше имя</DialogTitle>
          <DialogDescription>Как вас будут видеть другие участники.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <Input
            placeholder="Введите имя"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            autoFocus
            maxLength={32}
            aria-label="Ваше имя"
            className="h-12 rounded-xl text-base"
          />
          <Button
            size="lg"
            className="h-12 gap-2 rounded-full text-base font-semibold"
            onClick={handleSave}
            disabled={value.trim().length === 0}
          >
            <Check className="size-5" aria-hidden="true" />
            Сохранить
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
