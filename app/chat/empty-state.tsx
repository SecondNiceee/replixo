import { MessageSquare } from 'lucide-react'

// Заглушка правой колонки, когда диалог не выбран. На мобильном не видна:
// там колонка со списком и колонка с диалогом показываются по очереди.
export function EmptyState() {
  return (
    <section className="chat-surface flex min-h-0 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-border/60 px-6 text-center backdrop-blur-xl">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <MessageSquare className="size-8" aria-hidden="true" />
      </span>
      <p className="text-pretty text-sm text-muted-foreground">
        Выберите диалог, чтобы начать переписку
      </p>
    </section>
  )
}
