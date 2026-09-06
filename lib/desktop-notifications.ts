'use client'

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Системные (нативные) уведомления браузера через Notification API.
//
// Это «уровень 1»: уведомление показывается операционной системой, поэтому
// видно даже когда вкладка свёрнута или окно браузера за другим приложением.
// Но работает только пока вкладка жива — соединение с сокет-сервером держит
// именно она. Закрытую вкладку накроет только Web Push (уровень 2).
//
// В Electron-сборке тот же API работает без запроса разрешения: приложение
// живёт в трее, сокет не рвётся, и системное уведомление — ровно то, что нужно.
// ---------------------------------------------------------------------------

/** Состояние разрешения. 'unsupported' — API нет (старый Safari, iOS не-PWA). */
export type DesktopPermission = NotificationPermission | 'unsupported'

interface PermissionState {
  permission: DesktopPermission
  /** Пользователь закрыл баннер, не отвечая. Не спрашиваем до следующей сессии. */
  dismissed: boolean
  sync: () => void
  request: () => Promise<DesktopPermission>
  dismiss: () => void
}

const DISMISS_KEY = 'replixo:notifications-banner-dismissed'

function readPermission(): DesktopPermission {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

// Zustand, а не useState в баннере: разрешение — глобальный факт, его читают и
// баннер (показывать ли себя), и уведомитель (можно ли показывать). Ответ на
// промпт браузера должен обновить обоих сразу.
export const useDesktopNotifications = create<PermissionState>((set) => ({
  // На сервере и до первого sync считаем неподдерживаемым: так баннер не
  // мигнёт при гидрации, а появится только после реальной проверки.
  permission: 'unsupported',
  dismissed: false,

  sync: () => set({ permission: readPermission(), dismissed: readDismissed() }),

  request: async () => {
    if (readPermission() === 'unsupported') return 'unsupported'
    try {
      const result = await Notification.requestPermission()
      set({ permission: result })
      return result
    } catch {
      // Старый Safari принимал только callback и бросал на промисе.
      const fallback = readPermission()
      set({ permission: fallback })
      return fallback
    }
  },

  dismiss: () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Приватный режим без storage — просто скроем до перезагрузки.
    }
    set({ dismissed: true })
  },
}))

interface DesktopNotificationOptions {
  title: string
  body: string
  /**
   * Ключ схлопывания: уведомления с одним tag заменяют друг друга, а не
   * копятся. Для диалога — `dm:<conversationId>`, как dedupeKey у тостов.
   */
  tag?: string
  /** Что сделать по клику — обычно перейти в диалог. Окно фокусируем сами. */
  onClick?: () => void
}

/**
 * Показывает системное уведомление, если разрешение выдано.
 * Возвращает false, если показать нечем — вызывающий решает, нужен ли тост.
 */
export function showDesktopNotification({
  title,
  body,
  tag,
  onClick,
}: DesktopNotificationOptions): boolean {
  if (readPermission() !== 'granted') return false

  try {
    const notification = new Notification(title, {
      body,
      tag,
      icon: '/apple-icon.png',
      // Без этого повторное сообщение с тем же tag заменит плашку молча;
      // renotify заставит систему снова привлечь внимание.
      // @ts-expect-error — renotify есть в Chromium/Firefox, но не в типах lib.dom
      renotify: !!tag,
      silent: false,
    })

    notification.onclick = () => {
      // Порядок важен: сначала фокус окна, затем навигация. Иначе SPA-переход
      // произойдёт в фоновой вкладке, и пользователь его не увидит.
      window.focus()
      onClick?.()
      notification.close()
    }

    return true
  } catch {
    // Chrome на Android бросает на конструкторе: там нативные уведомления
    // разрешены только из Service Worker. Это территория уровня 2.
    return false
  }
}
