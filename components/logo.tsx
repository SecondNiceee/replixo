import { Video } from "lucide-react"

export function Logo({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className ?? ""}`}>
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Video className="size-5" strokeWidth={2.25} aria-hidden="true" />
      </span>
      <span className="text-lg font-semibold tracking-tight text-foreground">Riplexo</span>
    </div>
  )
}
