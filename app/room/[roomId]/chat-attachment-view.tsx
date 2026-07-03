import { FileText, Download } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatAttachment } from "@/hooks/use-mediasoup"
import { formatFileSize, isImageAttachment } from "./chat-helpers"

// Renders an attachment inside a message bubble: image preview for images,
// a downloadable file card for everything else.
export function AttachmentView({
  attachment,
  mediaBaseUrl,
  self,
}: {
  attachment: ChatAttachment
  mediaBaseUrl: string
  self: boolean
}) {
  const href = `${mediaBaseUrl}${attachment.url}`
  if (isImageAttachment(attachment)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-xl border border-border/60"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={href || "/placeholder.svg"}
          alt={attachment.name}
          className="max-h-60 w-full max-w-[260px] object-cover"
          loading="lazy"
        />
      </a>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.name}
      className={cn(
        "flex max-w-[260px] items-center gap-3 rounded-xl border border-border/60 px-3 py-2 transition-colors",
        self ? "bg-primary-foreground/10 hover:bg-primary-foreground/20" : "bg-background hover:bg-muted",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <FileText className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{attachment.name}</span>
        <span className="text-[11px] opacity-70">{formatFileSize(attachment.size)}</span>
      </span>
      <Download className="size-4 shrink-0 opacity-70" />
    </a>
  )
}
