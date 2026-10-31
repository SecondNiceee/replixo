"use client"

import { memo, useEffect, useRef, useState, useCallback } from "react"
import {
  SendHorizonal,
  ChevronRight,
  Paperclip,
  Plus,
  X,
  FileText,
  Loader2,
  NotebookText,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ChatMessage, ChatAttachment } from "@/hooks/use-mediasoup"
import { useOverlayClickThrough } from "@/hooks/use-overlay-click-through"
import { useScrollbarAutohide } from "@/hooks/use-scrollbar-autohide"
import { ChatMessageList } from "./chat-message-list"
import { useRoomTypingStore } from "@/stores/room-typing-store"
import { formatFileSize, isImageAttachment } from "@/lib/chat-format"
import { isNoteAttachment, noteAttachment } from "@/lib/chat/note-attachment"
import { ComposerTextarea } from "@/app/chat/composer-textarea"
import { NotePickerDialog } from "@/app/chat/note-picker-dialog"

interface RoomChatProps {
  open: boolean
  onClose: () => void
  roomId: string
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
  onTyping: (typing: boolean) => void
  /** Пункт «Конспект» в меню «+» — только у вошедшего преподавателя. */
  canSendNotes: boolean
}

const TYPING_PING_MS = 3000
const TYPING_IDLE_MS = 3000
// Каждое вложение уходит отдельным сообщением, а сервер пропускает не больше
// 5 сообщений за 2 секунды — больше за раз отправить не получится.
const MAX_ATTACHMENTS = 5
const LIMIT_ERROR = `Можно прикрепить не более ${MAX_ATTACHMENTS} вложений за раз`

function formatTypingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} печатает…`
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`
  return `${names[0]} и ещё ${names.length - 1} печатают…`
}

function TypingIndicator() {
  const typingPeers = useRoomTypingStore((s) => s.typingPeers)
  const typingNames = Object.values(typingPeers).map((name) => name || "Участник")

  return (
    <div aria-live="polite" className="flex h-5 shrink-0 items-center gap-2 px-4 text-xs text-muted-foreground">
      {typingNames.length > 0 && (
        <>
          <span className="flex items-center gap-0.5" aria-hidden="true">
            <span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
            <span className="size-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
            <span className="size-1 animate-bounce rounded-full bg-muted-foreground" />
          </span>
          <span className="truncate">{formatTypingLabel(typingNames)}</span>
        </>
      )}
    </div>
  )
}

function PendingAttachment({
  attachment,
  mediaBaseUrl,
  onRemove,
}: {
  attachment: ChatAttachment
  mediaBaseUrl: string
  onRemove: () => void
}) {
  const note = isNoteAttachment(attachment)
  return (
    <div className="relative flex shrink-0 items-center gap-2 rounded-lg bg-muted px-2.5 py-2 pr-7">
      {note ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <NotebookText className="size-4" />
        </span>
      ) : isImageAttachment(attachment) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`${mediaBaseUrl}${attachment.url}` || "/placeholder.svg"}
          alt={attachment.name}
          className="size-9 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <FileText className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 max-w-28 flex-col">
        <span className="truncate text-xs font-medium text-foreground">{attachment.name}</span>
        <span className="text-[10px] text-muted-foreground">
          {note ? "Конспект" : formatFileSize(attachment.size)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={`Убрать вложение ${attachment.name}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export const RoomChat = memo(function RoomChat({
  open,
  onClose,
  roomId,
  messages,
  onSend,
  onUploadFile,
  mediaBaseUrl,
  unreadFromIndex,
  readMarkers,
  peerIds,
  onTyping,
  canSendNotes,
}: RoomChatProps) {
  const [text, setText] = useState("")

  // typing:true goes out once and is refreshed every TYPING_PING_MS while the
  // user keeps typing; typing:false after TYPING_IDLE_MS of silence or on send.
  const lastTypingPingRef = useRef(0)
  const typingIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTypingRef = useRef(onTyping)
  onTypingRef.current = onTyping

  const stopTyping = useCallback(() => {
    if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current)
    typingIdleTimerRef.current = null
    if (lastTypingPingRef.current === 0) return
    lastTypingPingRef.current = 0
    onTypingRef.current(false)
  }, [])

  const noteTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingPingRef.current > TYPING_PING_MS) {
      lastTypingPingRef.current = now
      onTypingRef.current(true)
    }
    if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current)
    typingIdleTimerRef.current = setTimeout(stopTyping, TYPING_IDLE_MS)
  }, [stopTyping])

  useEffect(() => stopTyping, [stopTyping])

  // Уже загруженные файлы и выбранные конспекты, ожидающие отправки.
  const [pendingList, setPendingList] = useState<ChatAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notePickerOpen, setNotePickerOpen] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const pendingCountRef = useRef(0)
  pendingCountRef.current = pendingList.length

  useScrollbarAutohide(scrollRef, [open])

  // Помечаем панель как интерактивную для overlay-режима (Electron).
  const overlayClickThrough = useOverlayClickThrough()

  // Auto-scroll to the newest message whenever messages change or the panel opens.
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  // Грузим по одному файлу: порядок превью совпадает с порядком выбора.
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      const free = MAX_ATTACHMENTS - pendingCountRef.current
      if (free <= 0) {
        setUploadError(LIMIT_ERROR)
        return
      }
      const toUpload = files.slice(0, free)
      setUploadError(files.length > toUpload.length ? LIMIT_ERROR : null)
      setUploading(true)
      let lastError: string | null = null
      for (const file of toUpload) {
        try {
          const attachment = await onUploadFile(file)
          setPendingList((prev) => [...prev, attachment])
        } catch (err) {
          lastError = (err as Error).message || `Не удалось загрузить файл «${file.name}»`
        }
      }
      setUploading(false)
      if (lastError) setUploadError(lastError)
    },
    [onUploadFile],
  )

  // Ссылку на конспект подписывает сервер приложения: по ней участники комнаты
  // получат доступ к конспекту (см. lib/chat/note-attachment.ts).
  const handlePickNote = useCallback(
    async (note: { id: string; title: string }) => {
      if (pendingCountRef.current >= MAX_ATTACHMENTS) throw new Error(LIMIT_ERROR)
      const res = await fetch(`/api/notes/${note.id}/room-share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      })
      const payload = (await res.json().catch(() => null)) as { url?: string; error?: string } | null
      if (!res.ok || !payload?.url) throw new Error(payload?.error ?? "Не удалось прикрепить конспект")
      const attachment = noteAttachment(note.id, note.title, payload.url)
      setPendingList((prev) => (prev.some((a) => a.url === attachment.url) ? prev : [...prev, attachment]))
    },
    [roomId],
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      // Reset so selecting the same files again re-triggers change.
      e.target.value = ""
      void addFiles(files)
    },
    [addFiles],
  )

  // Каждое вложение — отдельным сообщением, текст — к последнему.
  const submit = useCallback(() => {
    const trimmed = text.trim()
    if (uploading || (!trimmed && pendingList.length === 0)) return
    if (pendingList.length === 0) {
      onSend(trimmed, null)
    } else {
      pendingList.forEach((att, i) => onSend(i === pendingList.length - 1 ? trimmed : "", att))
    }
    stopTyping()
    setText("")
    setPendingList([])
    setUploadError(null)
  }, [text, pendingList, uploading, onSend, stopTyping])

  // Ctrl+V with copied images/files: clipboard files arrive as items of kind
  // "file". Only intercept when one exists, so plain text paste still works.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (uploading) return
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f)
      if (!files.length) return
      e.preventDefault()
      const named = files.map((file, i) =>
        file.name && file.name !== "image.png"
          ? file
          : new File([file], `pasted-${Date.now()}-${i}.${file.type.split("/")[1] || "png"}`, { type: file.type }),
      )
      void addFiles(named)
    },
    [uploading, addFiles],
  )

  // Drag & drop files anywhere over the panel.
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      void addFiles(Array.from(e.dataTransfer.files ?? []))
    },
    [addFiles],
  )

  const canSend = (text.trim().length > 0 || pendingList.length > 0) && !uploading

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
      className="relative flex h-full w-screen max-w-[360px] flex-col border-l border-border bg-card"
    >
      {/* Drag overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary px-6 py-4 text-sm font-medium text-primary">
            Отпустите файлы, чтобы прикрепить
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
      <div ref={scrollRef} className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ChatMessageList
          messages={messages}
          mediaBaseUrl={mediaBaseUrl}
          unreadFromIndex={unreadFromIndex}
          readMarkers={readMarkers}
          peerIds={peerIds}
        />
      </div>

      <TypingIndicator />

      <div className="shrink-0 border-t border-border/60 bg-card/70">
        {/* Upload status / staged attachments */}
        {(pendingList.length > 0 || uploading || uploadError) && (
          <div className="flex flex-col gap-2 px-3 pt-3">
            {uploading && (
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Загрузка файлов…
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
            {pendingList.length > 0 && (
              <div className="scroll-slim flex gap-2 overflow-x-auto pb-1">
                {pendingList.map((att) => (
                  <PendingAttachment
                    key={att.url}
                    attachment={att}
                    mediaBaseUrl={mediaBaseUrl}
                    onRemove={() => setPendingList((prev) => prev.filter((a) => a.url !== att.url))}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex items-end gap-2 px-3 py-3"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileChange}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              openOnHover
              delay={60}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10 shrink-0 rounded-full bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground data-[popup-open]:bg-foreground/10 data-[popup-open]:text-foreground"
                  aria-label="Прикрепить"
                />
              }
            >
              <Plus className="size-5 transition-transform in-data-[popup-open]:rotate-45" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="min-w-44">
              <DropdownMenuItem
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || pendingList.length >= MAX_ATTACHMENTS}
              >
                <Paperclip />
                Файл
              </DropdownMenuItem>
              {canSendNotes && (
                <DropdownMenuItem
                  onClick={() => setNotePickerOpen(true)}
                  disabled={pendingList.length >= MAX_ATTACHMENTS}
                >
                  <NotebookText />
                  Конспект
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <ComposerTextarea
            value={text}
            onChange={(value) => {
              setText(value)
              if (value) noteTyping()
              else stopTyping()
            }}
            onSubmit={submit}
            onPaste={handlePaste}
            disabled={false}
            maxLength={2000}
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
      </div>

      {canSendNotes && (
        <NotePickerDialog open={notePickerOpen} onOpenChange={setNotePickerOpen} onPick={handlePickNote} />
      )}
    </aside>
  )
})
