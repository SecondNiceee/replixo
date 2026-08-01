'use client'

import { useState } from 'react'
import { UserPlus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDmSocket } from '@/hooks/dm/use-dm-socket'
import { friendsAction, notifyFriendsChanged } from '@/hooks/dm/use-friends-realtime'

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
    const { ok, data } = await friendsAction(socket, '/api/friends/request', 'POST', {
      username: trimmed,
    })
    setAddLoading(false)

    if (!ok) {
      setAddError(data?.error ?? 'Ошибка')
      return
    }

    setAddUsername('')
    setAddSuccess(`Заявка отправлена пользователю ${trimmed}`)
    // Адресат должен увидеть заявку сразу, без перезагрузки страницы.
    notifyFriendsChanged(
      socket,
      data?.friendship?.addresseeId,
      'requested',
      data?.notified === true,
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <UserPlus className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Добавить друга</h2>
      </div>
      <form onSubmit={handleAddFriend} className="flex gap-2">
        <Input
          value={addUsername}
          onChange={(e) => {
            setAddUsername(e.target.value)
            setAddError(null)
            setAddSuccess(null)
          }}
          placeholder="Введите username"
          maxLength={20}
          className="flex-1"
        />
        <Button type="submit" size="sm" disabled={addLoading || !addUsername.trim()}>
          {addLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UserPlus className="size-4" />
          )}
          <span className="hidden sm:inline">Отправить</span>
        </Button>
      </form>
      {addError && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {addError}
        </p>
      )}
      {addSuccess && (
        <p className="mt-2 text-sm text-green-500" role="status">
          {addSuccess}
        </p>
      )}
    </div>
  )
}
