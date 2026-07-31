'use client'

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Всплывающие уведомления (тосты) о событиях дружбы и новых сообщениях.
//
// Зачем свой стор, а не готовая библиотека: тостов у нас ровно четыре вида, все
// с одинаковой структурой (кто → что → куда перейти), а внешняя зависимость
// потянула бы своё дерево DOM и свою тему. Здесь же — zustand, который в проекте
// уже есть.
//
// Стор намеренно отделён от компонента: события приходят в socket-обработчиках
// (useFriendsRealtime, DmNotifier), где хуков React нет. Пуш делается через
// useNotificationsStore.getState().push(...) — без подписки и лишних ререндеров.
// ---------------------------------------------------------------------------

export type NotificationKind =
  | 'friend-request'
  | 'friend-accepted'
  | 'friend-declined'
  | 'message'

export interface AppNotification {
  id: string
  kind: NotificationKind
  /** Заголовок: обычно имя того, кто вызвал событие. */
  title: string
  /** Пояснение: «хочет добавить вас в друзья», текст сообщения. */
  body?: string
  /** Куда ведёт клик по тосту. Без ссылки тост просто информирует. */
  href?: string
  /** Подпись действия. Показывается только вместе с href. */
  actionLabel?: string
  /** Сколько держать на экране, мс. */
  duration: number
  /**
   * Ключ склейки. Второе сообщение из того же диалога заменяет первое, а не
   * копит стопку: пять сообщений подряд не должны выдавливать с экрана заявку
   * в друзья.
   */
  dedupeKey?: string
}

/** Больше четырёх тостов одновременно — это уже не уведомление, а завал. */
const MAX_VISIBLE = 4

interface NotificationsState {
  items: AppNotification[]
  push: (n: Omit<AppNotification, 'id' | 'duration'> & { duration?: number }) => void
  dismiss: (id: string) => void
  clear: () => void
}

let counter = 0

/** Монотонный id: crypto.randomUUID есть не везде, а порядок нам важнее случайности. */
function nextId(): string {
  counter += 1
  return `n${counter}`
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  items: [],

  push: ({ duration = 6000, ...rest }) =>
    set((state) => {
      // Новый id при склейке — не мелочь: компонент тоста монтируется заново,
      // поэтому таймер автоскрытия начинает отсчёт с нуля, и пользователь
      // видит свежее сообщение полные несколько секунд.
      const item: AppNotification = { ...rest, id: nextId(), duration }

      const withoutDuplicate = rest.dedupeKey
        ? state.items.filter((i) => i.dedupeKey !== rest.dedupeKey)
        : state.items

      const items = [...withoutDuplicate, item]
      // Вытесняем самые старые: свежее событие всегда важнее.
      return { items: items.slice(-MAX_VISIBLE) }
    }),

  dismiss: (id) => set((state) => ({ items: state.items.filter((i) => i.id !== id) })),

  clear: () => set({ items: [] }),
}))

/** Хелпер для socket-обработчиков: пуш без подписки на стор. */
export function pushNotification(
  n: Omit<AppNotification, 'id' | 'duration'> & { duration?: number },
): void {
  useNotificationsStore.getState().push(n)
}
