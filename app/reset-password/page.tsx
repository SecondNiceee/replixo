'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Logo } from '@/components/logo'
import { CheckCircle, XCircle } from 'lucide-react'

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token')

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // No token in URL — invalid link
  if (!token) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <XCircle className="size-10 text-destructive" />
        <h1 className="text-xl font-semibold text-foreground">
          Недействительная ссылка
        </h1>
        <p className="text-sm text-muted-foreground">
          Ссылка для сброса пароля повреждена или уже была использована.
        </p>
        <Link
          href="/forgot-password"
          className="text-sm text-foreground font-medium underline-offset-4 hover:underline"
        >
          Запросить новую ссылку
        </Link>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Пароль должен быть минимум 8 символов')
      return
    }

    if (password !== confirm) {
      setError('Пароли не совпадают')
      return
    }

    setLoading(true)

    const { error } = await authClient.resetPassword({
      newPassword: password,
      token,
    })

    setLoading(false)

    if (error) {
      if (error.status === 400) {
        setError('Ссылка истекла или недействительна. Запросите новую.')
      } else {
        setError(error.message ?? 'Что-то пошло не так')
      }
      return
    }

    setDone(true)
    setTimeout(() => router.push('/sign-in'), 3000)
  }

  if (done) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <CheckCircle className="size-10 text-green-500" />
        <h1 className="text-xl font-semibold text-foreground">
          Пароль изменён
        </h1>
        <p className="text-sm text-muted-foreground">
          Новый пароль сохранён. Сейчас вы будете перенаправлены на страницу входа.
        </p>
        <Link
          href="/sign-in"
          className="text-sm text-foreground font-medium underline-offset-4 hover:underline"
        >
          Войти сейчас
        </Link>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Новый пароль
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Придумайте надёжный пароль для вашего аккаунта.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="password"
            className="text-sm font-medium text-foreground"
          >
            Новый пароль
          </label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Минимум 8 символов"
            required
            minLength={8}
            autoFocus
            autoComplete="new-password"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="confirm"
            className="text-sm font-medium text-foreground"
          >
            Подтвердите пароль
          </label>
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Повторите пароль"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={loading}
          className="w-full mt-1"
          size="lg"
        >
          {loading ? 'Сохранение...' : 'Сохранить пароль'}
        </Button>
      </form>
    </>
  )
}

export default function ResetPasswordPage() {
  return (
    <main className="min-h-svh bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo />
        </div>
        <div className="rounded-2xl border border-border bg-card p-8">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Загрузка...</p>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </main>
  )
}
