import { MessageSquare } from 'lucide-react'

// Заглушка правой колонки, когда диалог не выбран. На мобильном не видна:
// там колонка со списком и колонка с диалогом показываются по очереди.
export function EmptyState() {
  return (
    <section className="flex min-h-0 w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card px-6 text-center">
      <MessageSquare className="size-10 text-muted-foreground/30" aria-hidden="true" />
      <p className="text-pretty text-sm text-muted-foreground">
        Выберите диалог, чтобы начать переписку
      </p>
    </section>
  )
}
