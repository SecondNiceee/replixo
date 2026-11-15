import Image from "next/image"
import { cn } from "@/lib/utils"

export function ReplixoMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-block size-9 shrink-0", className)}>
      <Image className="theme-icon-light size-full" src="/replixo-camera-light.svg" width={80} height={80} alt="" unoptimized />
      <Image className="theme-icon-dark size-full" src="/replixo-camera-dark.svg" width={80} height={80} alt="" unoptimized />
    </span>
  )
}
