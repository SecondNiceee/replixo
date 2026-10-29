"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"

type RevealProps = {
  children: ReactNode
  className?: string
  delay?: number
}

// Один IntersectionObserver на всю страницу вместо отдельного на каждый блок.
let sharedObserver: IntersectionObserver | null = null

function getObserver() {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const node = entry.target as HTMLElement
          node.dataset.reveal = "shown"
          sharedObserver?.unobserve(node)
        }
      },
      { threshold: 0, rootMargin: "0px 0px -10% 0px" },
    )
  }
  return sharedObserver
}

/**
 * Серверный HTML всегда полностью видим (для поисковиков и без JS).
 * Прячем блок только на клиенте и только если он ниже экрана, поэтому
 * видимые сразу блоки не мигают. Состояние меняется через data-атрибут,
 * без ре-рендеров React; анимируются только opacity и transform.
 */
export function Reveal({ children, className, delay = 0 }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (node.getBoundingClientRect().top < window.innerHeight) return

    node.dataset.reveal = "hidden"
    const observer = getObserver()
    observer.observe(node)
    return () => observer.unobserve(node)
  }, [])

  return (
    <div
      ref={ref}
      className={cn("reveal", className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  )
}
