'use client'

import { useState } from 'react'
import { AtSign, Loader2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import {
  friendsAction,
  friendsActionErrorMessage,
  notifyFriendsChanged,
} from '@/hooks/dm/use-friends-realtime'

export function AddFriendForm() {
  // Соединение общее (refcount), поэтому лишнего websocket здесь не появляется.
  const { socket } = useDmSocket()
  const [addUsername, setAddUsername] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addLoading, setAddLoading] = useState(false)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = addUsername.trim()
    if (!trimmed) return

    setAddLoading(true)
    setAddError(null)
    setAddSuccess(null)

    // friendsAction, а не fetch напрямую: он передаёт id нашего соединения, и
    // сервер погасит эхо только в этой вкладке — соседние обновятся событием.
    const result = await friendsAction(socket, '/api/friends/request', 'POST', {
      username: trimmed,
    })
    setAddLoading(false)

    if (!result.ok) {
      // Инлайн, а не тост: ошибка относится к тому, что человек только что ввёл,
      // и должна стоять рядом с полем. Текст берём из общего разбора — прежнее
      // `data.error ?? 'Ошибка'` показывало голое «Ошибка» на 429 и на офлайне,
      // теряя и причину, и время до повтора.
      setAddError(friendsActionErrorMessage(result))
      return
    }

    setAddUsername('')
    setAddSuccess(`Заявка отправлена пользователю ${trimmed}`)
    // Адресат должен увидеть заявку сразу, без перезагрузки страницы.
    notifyFriendsChanged(
      socket,
      result.data?.friendship?.addresseeId,
      'requested',
      result.data?.notified === true,
    )
  }

  return (
    // Без своей карточки и заголовка: форма живёт внутри диалога «Добавить в
    // друзья», который уже даёт и рамку, и подпись. Вложенная карточка читалась
    // бы как вторая рамка, а второй заголовок дублировал бы DialogTitle.
    <div className="flex flex-col gap-2">
      <form onSubmit={handleAddFriend} className="flex gap-2">
        <div className="relative flex-1">
          <AtSign
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={addUsername}
            onChange={(e) => {
              setAddUsername(e.target.value)
              setAddError(null)
              setAddSuccess(null)
            }}
            placeholder="username"
            aria-label="Username друга"
            maxLength={20}
            autoComplete="off"
            className="h-10 pl-9"
          />
        </div>
        <Button
          type="submit"
          disabled={addLoading || !addUsername.trim()}
          className="h-10 gap-1.5"
        >
          {addLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UserPlus className="size-4" />
          )}
          Отправить
        </Button>
      </form>
      {addError && (
        <p className="text-sm text-destructive" role="alert">
          {addError}
        </p>
      )}
      {addSuccess && (
        <p className="text-sm text-emerald-400" role="status">
          {addSuccess}
        </p>
      )}
    </div>
  )
}
