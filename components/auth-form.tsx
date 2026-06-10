'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Logo } from '@/components/logo'

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const isSignUp = mode === 'sign-up'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (isSignUp) {
      const trimmed = username.trim()
      if (trimmed.length === 0) {
        setError('Username не может быть пустым')
        return
      }
      if (trimmed.length < 2) {
        setError('Username должен быть минимум 2 символа')
        return
      }
      if (trimmed.length > 20) {
        setError('Username не может быть длиннее 20 символов')
        return
      }
      if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
        setError('Username может содержать только англ. буквы, цифры и _')
        return
      }
    }

    setLoading(true)

    const trimmedUsername = username.trim()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = isSignUp
      ? await (authClient as any).signUp.email({
          email,
          password,
          name: trimmedUsername,
          username: trimmedUsername,
        })
      : await authClient.signIn.email({ email, password })

    setLoading(false)

    if (error) {
      setError(error.message ?? 'Что-то пошло не так')
      return
    }

    router.push('/')
    router.refresh()
  }

  return (
    <main className="min-h-svh bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Logo />
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-8">
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {isSignUp ? 'Создать аккаунт' : 'Добро пожаловать'}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isSignUp
                ? 'Зарегистрируйтесь, чтобы начать'
                : 'Войдите в свой аккаунт'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {isSignUp && (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="username"
                  className="text-sm font-medium text-foreground"
                >
                  Username
                </label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="cooluser"
                  required
                  maxLength={20}
                  autoComplete="username"
                />
                <p className="text-xs text-muted-foreground">
                  Допустимы — англ. буквы, цифры, нижнее подчеркивание
                </p>
              </div>
            )}

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
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="password"
                className="text-sm font-medium text-foreground"
              >
                Пароль
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Минимум 8 символов"
                required
                minLength={8}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
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
              {loading
                ? 'Подождите...'
                : isSignUp
                  ? 'Создать аккаунт'
                  : 'Войти'}
            </Button>
          </form>

          <p className="text-sm text-muted-foreground text-center mt-6">
            {isSignUp ? 'Уже есть аккаунт? ' : 'Нет аккаунта? '}
            <Link
              href={isSignUp ? '/sign-in' : '/sign-up'}
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              {isSignUp ? 'Войти' : 'Зарегистрироваться'}
            </Link>
          </p>
        </div>
      </div>
    </main>
  )
}
