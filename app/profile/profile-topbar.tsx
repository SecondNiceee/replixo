'use client'

import { useState } from 'react'
import { Inbox, UserPlus, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { StartCallDialog } from '@/components/start-call-dialog'
import { cn } from '@/lib/utils'
import { AddFriendForm } from './add-friend-form'
import { PendingRequests } from './pending-requests'
import { SentRequests } from './sent-requests'
import type { PendingRequest, SentRequest } from './types'

interface ProfileTopbarProps {
  pending: PendingRequest[]
  pendingLoading: boolean
  sent: SentRequest[]
  sentLoading: boolean
  connected: boolean
  unavailable: boolean
}

type RequestsTab = 'incoming' | 'outgoing'

/**
 * Верхняя панель кабинета: «Добавить в друзья» и «Заявки».
 *
 * Оба раздела живут в диалогах, а не в колонке страницы. Это разовые действия
 * («добавил» / «принял»), а постоянного места на экране они лишали бы главное —
 * список чатов и саму переписку.
 */
export function ProfileTopbar({
  pending,
  pendingLoading,
  sent,
  sentLoading,
  connected,
  unavailable,
}: ProfileTopbarProps) {
  const [requestsTab, setRequestsTab] = useState<RequestsTab>('incoming')
  const [callOpen, setCallOpen] = useState(false)

  const tabs: { id: RequestsTab; label: string; count: number }[] = [
    { id: 'incoming', label: 'Входящие', count: pending.length },
    { id: 'outgoing', label: 'Исходящие', count: sent.length },
  ]

  return (
    <header className="topbar-surface flex shrink-0 items-center gap-2 rounded-2xl border border-border/60 px-3 py-2 backdrop-blur-xl md:px-4">
      {/* ?landing=1 — иначе / отправит авторизованного обратно в кабинет и
          лендинг остался бы недоступен изнутри приложения. */}
      <a
        href="/?landing=1"
        className="mr-1 flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground transition-opacity hover:opacity-70"
      >
        {/* Знак тот же, что в components/logo.tsx: сплошной акцент и камера.
            Здесь был свой градиентный квадрат без иконки — на узком экране, где
            подпись скрывалась, от логотипа оставался безымянный синий прямо-
            угольник, не похожий ни на что в остальном приложении. */}
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Video className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
        </span>
        {/* Подпись видна всегда: слово короткое, а без него шапка на узком
            экране начиналась пустотой. */}
        <span>Replixo</span>
      </a>

      <div className="ml-auto flex items-center gap-2">
        {/* «Начать звонок» — главное действие приложения, поэтому стоит первым
            и единственный из трёх кнопок имеет фон. Но не полный primary, как
            на лендинге: там это единственная цель экрана, а здесь рядом список
            диалогов, и сплошная синяя кнопка перетягивала бы на себя весь
            верх. Достаточно подложки secondary с тонкой рамкой — заметно, но
            не громко. */}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setCallOpen(true)}
          className="gap-1.5 border border-border/70 bg-secondary/70 text-foreground hover:bg-secondary"
        >
          <Video className="size-4" strokeWidth={2.25} aria-hidden="true" />
          <span className="hidden sm:inline">Начать звонок</span>
        </Button>

        {/* Добавить в друзья */}
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground" />
            }
          >
            <UserPlus className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Добавить в друзья</span>
          </DialogTrigger>
          {/* app-dark обязателен: DialogContent рендерится в портал у <body>,
              вне <main class="app-dark">, и без класса взял бы палитру :root
              без акцента кабинета. */}
          <DialogContent className="app-dark bg-card sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Добавить в друзья</DialogTitle>
              <DialogDescription>
                Введите username — человек получит заявку и сможет её принять.
              </DialogDescription>
            </DialogHeader>
            <AddFriendForm />
          </DialogContent>
        </Dialog>

        {/* Заявки */}
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="ghost" size="sm" className="relative gap-1.5 text-muted-foreground hover:text-foreground" />
            }
          >
            <Inbox className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Заявки</span>
            {pending.length > 0 && (
              <span
                // Как и счётчики в списке: фиксированный квадрат под круг и
                // grid place-items-center. С min-w-4 + py-0.5 + leading-none
                // высота зависела от кегля, и цифра сидела выше центра.
                className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground"
                aria-label={`${pending.length} входящих заявок`}
              >
                {pending.length > 99 ? '99+' : pending.length}
              </span>
            )}
          </DialogTrigger>
          <DialogContent className="app-dark bg-card sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Заявки в друзья</DialogTitle>
              <DialogDescription>
                Входящие заявки нужно принять, исходящие можно отменить.
              </DialogDescription>
            </DialogHeader>

            {/* Тот же рельс с подчёркиванием, что и в левой панели: два разных
                вида табов на одном экране выдавали бы сборку из кусков. */}
            <div role="tablist" aria-label="Заявки" className="flex gap-6 border-b border-border/60">
              {tabs.map((tab) => {
                const selected = requestsTab === tab.id
                return (
                  <button
                    key={tab.id}
                    id={`requests-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="requests-panel"
                    onClick={() => setRequestsTab(tab.id)}
                    className={cn(
                      '-mb-px border-b-2 pb-2 text-[13px] font-medium tracking-tight transition-colors',
                      selected
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {/* Цифра здесь нужна (сколько заявок разбирать), но пишется
                        сразу после слова одной фразой. Слот фиксированной
                        ширины отрывал её от подписи, а у таба с нулём оставлял
                        за словом пустое место — так «Друзья» в кабинете и стояли
                        с призрачным пробелом. */}
                    {tab.count > 0 ? `${tab.label} ${tab.count > 99 ? '99+' : tab.count}` : tab.label}
                  </button>
                )
              })}
            </div>

            <div
              id="requests-panel"
              role="tabpanel"
              aria-labelledby={`requests-tab-${requestsTab}`}
              className="max-h-[60vh] overflow-y-auto"
            >
              {requestsTab === 'incoming' ? (
                <PendingRequests pending={pending} isLoading={pendingLoading} />
              ) : (
                <SentRequests sent={sent} isLoading={sentLoading} />
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Индикатор соединения остаётся только на проблемном состоянии.
            «На связи» — норма, а норму сообщать нечем: зелёная точка с подписью
            стояла в шапке всегда и занимала место, ничего не меняя. А вот
            «нет связи» объясняет, почему сообщения не уходят, поэтому этот
            случай виден. */}
        {(unavailable || !connected) && (
          <span
            className={cn(
              'ml-1 flex items-center gap-1.5 text-xs',
              unavailable ? 'text-destructive' : 'text-muted-foreground',
            )}
            role="status"
          >
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                unavailable ? 'bg-destructive' : 'bg-muted-foreground/40',
              )}
              aria-hidden="true"
            />
            {/* На узком экране остаётся только точка, поэтому подпись дублируется
                для скринридера — цвет сам по себе ничего не сообщает. */}
            <span className="sr-only md:hidden">
              {unavailable ? 'Чат недоступен' : 'Подключение'}
            </span>
            <span className="hidden md:inline">
              {unavailable ? 'Чат недоступен' : 'Подключение…'}
            </span>
          </span>
        )}
      </div>

      {/* Тот же диалог, что и на лендинге: код комнаты генерируется внутри,
          а переход в комнату делаем так же — с ?create=true, иначе комната не
          создастся и приглашённые попадут в пустоту.

          Монтируем только на открытии: код живёт в useState-инициализаторе, и у
          постоянно смонтированного диалога второй звонок за сессию получил бы
          код от первого — то есть увёл бы в уже занятую комнату. */}
      {callOpen && (
        <StartCallDialog
          open
          contentClassName="app-dark bg-card"
          onOpenChange={setCallOpen}
          onStart={(roomCode) => {
            window.location.href = `/room/${roomCode}?create=true`
          }}
          // В кабинете кнопка «Начать звонок» одна, поэтому вход по коду живёт
          // внутри её диалога (на лендинге для этого есть отдельная кнопка
          // рядом). Без ?create=true: комната уже создана организатором, и флаг
          // здесь означал бы попытку создать её заново.
          onJoin={(roomCode) => {
            window.location.href = `/room/${roomCode}`
          }}
        />
      )}
    </header>
  )
}
