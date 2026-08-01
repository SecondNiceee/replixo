'use client'

import { useRouter } from 'next/navigation'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUnreadTotal } from '@/hooks/dm/use-unread-total'

// ---------------------------------------------------------------------------
// Кнопка «Сообщения» в шапке с бейджем непрочитанных.
//
// Вынесена из AuthButtons отдельным компонентом, потому что useUnreadTotal
// поднимает сокет и грузит список диалогов. Хуки нельзя вызывать условно, а
// AuthButtons рендерится и для анонимных посетителей — там эти запросы были бы
// заведомо лишними (и получили бы 401). Компонент монтируется только внутри
// ветки «пользователь авторизован».
// ---------------------------------------------------------------------------

export function MessagesButton() {
  const router = useRouter()
  const unread = useUnreadTotal()

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => router.push('/profile')}
      className="relative text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
      aria-label={unread > 0 ? `Сообщения, ${unread} непрочитанных` : 'Сообщения'}
    >
      <MessageSquare className="size-4" aria-hidden="true" />
      <span className="hidden md:inline">Сообщения</span>
      {unread > 0 && (
        <span
          className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground"
          aria-hidden="true"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Button>
  )
}
