'use client'

// Три пульсирующие точки + имя. Место под индикатор зарезервировано в
// ConversationView, поэтому его появление не сдвигает ленту и композер.

export function TypingIndicator({ name }: { name: string }) {
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span className="flex items-center gap-0.5" aria-hidden="true">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1 animate-pulse rounded-full bg-muted-foreground/70"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      {name} печатает…
    </p>
  )
}
