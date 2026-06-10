'use client'

import { useState } from 'react'
import Link from 'next/link'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Logo } from '@/components/logo'
import { CheckCircle } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await authClient.forgetPassword({
      email: email.trim(),
      redirectTo: '/reset-password',
    })

    setLoading(false)

    if (error) {
      setError(error.message ?? 'Что-то пошло не так')
      return
    }

    setSent(true)
  }

  return (
    <main className="min-h-svh bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo />
        </div>

        <div className="rounded-2xl border border-border bg-card p-8">
          {sent ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <CheckCircle className="size-10 text-green-500" />
              <h1 className="text-xl font-semibold text-foreground">
                Письмо отправлено
              </h1>
              <p className="text-sm text-muted-foreground">
                Мы отправили ссылку для сброса пароля на{' '}
                <span className="font-medium text-foreground">{email}</span>.
                Проверьте почту, ссылка действует 1 час.
              </p>
              <p className="text-xs text-muted-foreground">
                Не пришло? Проверьте папку «Спам».
              </p>
              <Link
                href="/sign-in"
                className="text-sm text-foreground font-medium underline-offset-4 hover:underline mt-2"
              >
                Вернуться ко входу
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  Восстановление пароля
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Введите email вашего аккаунта, и мы пришлём ссылку для сброса.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="email"
                    className="text-sm font-medium text-foreground"
                  >
                    Почта
                  </label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    autoFocus
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
                  {loading ? 'Отправка...' : 'Отправить ссылку'}
                </Button>
              </form>

              <p className="text-sm text-muted-foreground text-center mt-6">
                Вспомнили пароль?{' '}
                <Link
                  href="/sign-in"
                  className="text-foreground font-medium underline-offset-4 hover:underline"
                >
                  Войти
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
