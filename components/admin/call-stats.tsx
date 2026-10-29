"use client"

import { Button } from "@/components/ui/button"
import type { CallSessionRow } from "@/app/api/adminuw102/route"

function formatDuration(totalSec: number) {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h} ч ${m} мин`
  if (m > 0) return `${m} мин ${s} с`
  return `${s} с`
}

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function percent(part: number, total: number) {
  return total === 0 ? "0%" : `${Math.round((part / total) * 100)}%`
}

function YesNo({ value }: { value: boolean }) {
  return value ? (
    <span className="font-medium text-primary">Да</span>
  ) : (
    <span className="text-muted-foreground">Нет</span>
  )
}

export function CallStats({
  sessions,
  refreshing,
  onRefresh,
}: {
  sessions: CallSessionRow[]
  refreshing: boolean
  onRefresh: () => void
}) {
  const total = sessions.length
  const screen = sessions.filter((s) => s.usedScreenShare).length
  const notes = sessions.filter((s) => s.usedNotes).length
  const avgDuration =
    total === 0 ? 0 : Math.round(sessions.reduce((a, s) => a + s.durationSec, 0) / total)

  const summary = [
    { label: "Конференций", value: String(total) },
    { label: "Средняя длительность", value: formatDuration(avgDuration) },
    { label: "С демонстрацией экрана", value: `${screen} · ${percent(screen, total)}` },
    { label: "С конспектом", value: `${notes} · ${percent(notes, total)}` },
  ]

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Конференции
          </h1>
          <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Обновление…" : "Обновить"}
          </Button>
        </header>

        <section aria-label="Итоги" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {summary.map((item) => (
            <div key={item.label} className="flex flex-col gap-1 rounded-lg border border-border p-4">
              <span className="text-sm text-muted-foreground">{item.label}</span>
              <span className="text-lg font-semibold text-foreground">{item.value}</span>
            </div>
          ))}
        </section>

        {total === 0 ? (
          <p className="text-muted-foreground">
            Пока нет ни одной завершённой конференции. Данные записываются, когда из комнаты выходит последний участник.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Начало</th>
                  <th scope="col" className="px-4 py-3 font-medium">Комната</th>
                  <th scope="col" className="px-4 py-3 font-medium">Длительность</th>
                  <th scope="col" className="px-4 py-3 font-medium">Участников</th>
                  <th scope="col" className="px-4 py-3 font-medium">Демонстрация</th>
                  <th scope="col" className="px-4 py-3 font-medium">Конспект</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="whitespace-nowrap px-4 py-3 text-foreground">
                      {dateFormat.format(new Date(s.startedAt))}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{s.roomId}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-foreground">
                      {formatDuration(s.durationSec)}
                    </td>
                    <td className="px-4 py-3 text-foreground">{s.maxParticipants}</td>
                    <td className="px-4 py-3"><YesNo value={s.usedScreenShare} /></td>
                    <td className="px-4 py-3"><YesNo value={s.usedNotes} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
