import { ReplixoMark } from "@/components/replixo-mark"

export function Logo({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className ?? ""}`}>
      <ReplixoMark />
      <span className="text-lg font-semibold tracking-tight text-foreground">Replixo</span>
    </div>
  )
}
