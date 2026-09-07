'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { AuthForm } from '@/components/auth-form'
import { useAuthDialog } from '@/stores/auth-dialog-store'

export function AuthDialog() {
  const mode = useAuthDialog((s) => s.mode)
  const open = useAuthDialog((s) => s.open)
  const close = useAuthDialog((s) => s.close)

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const authParam = searchParams.get('auth')

  // ?auth=sign-in|sign-up открывает попап по прямой ссылке: сюда ведут старые
  // /sign-in и /sign-up, «Войти» после сброса пароля и защита кабинета. Параметр
  // сразу убираем из адреса, иначе он «застрянет» и попап откроется ещё раз
  // после закрытия при любом обновлении страницы.
  useEffect(() => {
    if (authParam !== 'sign-in' && authParam !== 'sign-up') return
    open(authParam)
    const rest = new URLSearchParams(searchParams.toString())
    rest.delete('auth')
    const query = rest.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [authParam, open, pathname, router, searchParams])

  return (
    <Dialog open={mode !== null} onOpenChange={(isOpen) => !isOpen && close()}>
      <DialogContent className="p-6 sm:max-w-sm">
        {/* Видимый заголовок рисует сама форма, а этот нужен только для
            ассистивных технологий — иначе base-ui ругается на диалог без имени. */}
        <DialogTitle className="sr-only">
          {mode === 'sign-up' ? 'Регистрация' : 'Вход'}
        </DialogTitle>
        {mode && <AuthForm mode={mode} onSwitchMode={open} onSuccess={close} />}
      </DialogContent>
    </Dialog>
  )
}
