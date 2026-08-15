'use client'

import { useEffect, type RefObject } from 'react'

// ---------------------------------------------------------------------------
// Проявление тонкой полосы прокрутки на время скролла.
//
// Пара к утилите .scroll-slim в globals.css: та рисует полосу прозрачной, а
// этот хук на время скролла ставит на элемент data-scrolling, по которому CSS
// её показывает.
//
// Почему нужен JS. Дефолтная полоса ОС видна всегда, а единственное чисто-CSS
// состояние, которым её можно было бы прятать, — :hover на контейнере. Но
// курсор над лентой сообщений стоит почти постоянно, так что полоса опять была
// бы видна всегда. «Идёт скролл» в CSS не выражается вовсе.
//
// Обработчик специально ничего не рендерит: события скролла идут пачками по
// десяткам в секунду, и setState здесь означал бы ререндер всей ленты. Правка
// атрибута напрямую в DOM обходится в одну операцию и React не трогает — этим
// же приёмом (data-* вместо состояния) пользуется CSS-анимация.
// ---------------------------------------------------------------------------

/** Сколько полоса ещё видна после последнего события скролла. */
const HIDE_DELAY_MS = 900

export function useScrollbarAutohide(
  ref: RefObject<HTMLElement | null>,
  /**
   * Пересоздать подписку. Нужно, когда элемент появляется в DOM не сразу
   * (например, лента рендерится только после загрузки истории), — иначе на
   * момент первого прохода ref ещё пустой и слушатель не навесится никогда.
   */
  deps: unknown[] = [],
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    let timer: ReturnType<typeof setTimeout> | undefined

    const onScroll = () => {
      el.dataset.scrolling = 'true'
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // Пока thumb под курсором, гасить его нельзя: пользователь как раз
        // собирается за него взяться. :hover в JS читаем через matches.
        if (el.matches(':hover') && el.scrollHeight > el.clientHeight) {
          // Ещё один круг ожидания вместо мгновенного скрытия.
          timer = setTimeout(() => delete el.dataset.scrolling, HIDE_DELAY_MS)
          return
        }
        delete el.dataset.scrolling
      }, HIDE_DELAY_MS)
    }

    el.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      el.removeEventListener('scroll', onScroll)
      if (timer) clearTimeout(timer)
      delete el.dataset.scrolling
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps])
}
