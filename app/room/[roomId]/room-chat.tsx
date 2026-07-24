"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import {
  SendHorizonal,
  ChevronRight,
  Paperclip,
  X,
  FileText,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChatMessage, ChatAttachment } from "@/hooks/use-mediasoup"
import { useOverlayClickThrough } from "@/hooks/use-overlay-click-through"
import { ChatMessageList } from "./chat-message-list"
import { formatFileSize, isImageAttachment } from "@/lib/chat-format"

interface RoomChatProps {
  open: boolean
  onClose: () => void
  messages: ChatMessage[]
  onSend: (text: string, attachment?: ChatAttachment | null) => void
  // Uploads a file to the room and resolves with its attachment metadata.
  onUploadFile: (file: File) => Promise<ChatAttachment>
  // Base URL of the media server, used to build absolute attachment links.
  mediaBaseUrl: string
  // Index of the first message that was unread when the panel was opened.
  // Messages at this index and beyond are highlighted as "new". null = none.
  unreadFromIndex: number | null
  // peerId -> timestamp (ms) of the latest message that peer has read.
  readMarkers: Record<string, number>
  // Currently connected remote peer ids, used to decide when a message has
  // been read by everyone else in the room.
  peerIds: string[]
}

export function RoomChat({
  open,
  onClose,
  messages,
  onSend,
  onUploadFile,
  mediaBaseUrl,
  unreadFromIndex,
  readMarkers,
  peerIds,
}: RoomChatProps) {
  const [text, setText] = useState("")
  // Attachment that has finished uploading and is staged to send with the next
  // message. Cleared after send or when the user removes it.
  const [pendingAttachment, setPendingAttachment] = useState<ChatAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  // Помечаем панель как интерактивную для overlay-режима (Electron).
  const overlayClickThrough = useOverlayClickThrough()

  // Auto-scroll to the newest message whenever messages change or the panel opens.
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  // Focus the input when the panel opens. We wait for the slide-in transition
  // to finish and pass preventScroll so the browser doesn't snap the still
  // off-screen input into view mid-animation, which made the open feel abrupt.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true })
    }, 300)
    return () => window.clearTimeout(id)
  }, [open])

  const uploadFile = useCallback(
    async (file: File) => {
      setUploadError(null)
      setUploading(true)
      try {
        const attachment = await onUploadFile(file)
        setPendingAttachment(attachment)
      } catch (err) {
        setUploadError((err as Error).message || "Не удалось загрузить файл")
      } finally {
        setUploading(false)
      }
    },
    [onUploadFile],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Reset so selecting the same file again re-triggers change.
      e.target.value = ""
      if (file) void uploadFile(file)
    },
    [uploadFile],
  )

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = text.trim()
      if (!trimmed && !pendingAttachment) return
      if (uploading) return
      onSend(trimmed, pendingAttachment)
      setText("")
      setPendingAttachment(null)
      setUploadError(null)
    },
    [text, pendingAttachment, uploading, onSend],
  )

  // Drag & drop a file anywhere over the panel.
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void uploadFile(file)
    },
    [uploadFile],
  )

  const canSend = (text.trim().length > 0 || !!pendingAttachment) && !uploading

  return (
    <aside
      {...overlayClickThrough}
      aria-label="Чат комнаты"
      aria-hidden={!open}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault()
        dragDepth.current -= 1
        if (dragDepth.current <= 0) setDragging(false)
      }}
      onDrop={handleDrop}
      className="relative flex h-full w-[360px] flex-col border-l border-border bg-card"
    >
      {/* Drag overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary px-6 py-4 text-sm font-medium text-primary">
            Отпустите файл, чтобы прикрепить
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Чат</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="size-8"
          aria-label="Закрыть чат"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        <ChatMessageList
          messages={messages}
          mediaBaseUrl={mediaBaseUrl}
          unreadFromIndex={unreadFromIndex}
          readMarkers={readMarkers}
          peerIds={peerIds}
        />
      </div>

      {/* Pending attachment / upload status */}
      {(pendingAttachment || uploading || uploadError) && (
        <div className="shrink-0 border-t border-border px-3 pt-3">
          {uploading && (
            <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Загрузка файла…
            </div>
          )}
          {uploadError && !uploading && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span className="truncate">{uploadError}</span>
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="shrink-0 opacity-70 hover:opacity-100"
                aria-label="Скрыть ошибку"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {pendingAttachment && !uploading && (
            <div className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2">
              {isImageAttachment(pendingAttachment) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${mediaBaseUrl}${pendingAttachment.url}` || "/placeholder.svg"}
                  alt={pendingAttachment.name}
                  className="size-10 shrink-0 rounded-md object-cover"
                />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                  <FileText className="size-4" />
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {pendingAttachment.name}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {formatFileSize(pendingAttachment.size)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPendingAttachment(null)}
                className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label="Убрать вложение"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-3"
      >
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="size-10 shrink-0 rounded-full"
          aria-label="Прикрепить файл"
        >
          <Paperclip className="size-4" />
        </Button>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          placeholder="Напишите сообщение…"
          aria-label="Текст сообщения"
          className="h-10 flex-1 select-text rounded-full border border-input bg-background px-4 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!canSend}
          className="size-10 shrink-0 rounded-full"
          aria-label="Отправить сообщение"
        >
          <SendHorizonal className="size-4" />
        </Button>
      </form>
    </aside>
  )
}
