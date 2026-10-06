"use client"

import { useEffect, useMemo, useState } from "react"
import { Copy, FileText, Loader2, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useLessonRecorder } from "@/hooks/use-lesson-recorder"
import type { RemotePeer } from "@/hooks/mediasoup/types"

interface LessonSummaryButtonProps {
  localStream: MediaStream | null
  peers: Map<string, RemotePeer>
}

export function LessonSummaryButton({ localStream, peers }: LessonSummaryButtonProps) {
  const audioKey = [localStream?.id, ...[...peers.values()].map((p) => p.audioStream?.id)].join("|")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const streams = useMemo(
    () => [localStream, ...[...peers.values()].map((p) => p.audioStream)].filter((s): s is MediaStream => !!s),
    [audioKey],
  )
  const { status, summary, error, start, stop } = useLessonRecorder(streams)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (status === "done" || status === "error") setOpen(true)
  }, [status])

  const recording = status === "recording"
  const summarizing = status === "summarizing"

  const handleClick = () => {
    if (recording) void stop()
    else if (!summarizing) void start()
  }

  const copy = async () => {
    await navigator.clipboard.writeText(summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        onClick={handleClick}
        disabled={summarizing}
        aria-busy={summarizing}
        className={cn(
          "size-12 rounded-full",
          recording && "border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
        aria-label={
          summarizing
            ? "Составляем конспект…"
            : recording
              ? "Закончить запись и составить конспект"
              : "Начать запись для ИИ-конспекта"
        }
        title={recording ? "Идёт запись урока. Нажмите, чтобы получить конспект" : "ИИ-конспект урока"}
      >
        {summarizing ? (
          <Loader2 className="size-5 animate-spin" />
        ) : recording ? (
          <Square className="size-4 animate-pulse fill-current" />
        ) : (
          <FileText className="size-5" />
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-3rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Конспект урока</DialogTitle>
            <DialogDescription>Составлен ИИ по расшифровке разговора.</DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border p-4 text-sm leading-relaxed">
              {summary}
            </div>
          )}
          <DialogFooter>
            {!error && (
              <Button variant="outline" onClick={copy}>
                <Copy />
                {copied ? "Скопировано" : "Копировать"}
              </Button>
            )}
            <Button onClick={() => setOpen(false)}>Закрыть</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
