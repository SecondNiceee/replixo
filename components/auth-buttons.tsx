'use client'

import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { LogOut, User } from 'lucide-react'

interface AuthButtonsProps {
  user: { name: string; email: string } | null
}

export function AuthButtons({ user }: AuthButtonsProps) {
  const router = useRouter()

  const handleSignOut = async () => {
    await authClient.signOut()
    router.push('/')
    router.refresh()
  }

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <div className="hidden md:flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-3 py-1">
          <User className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground">{user.name}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Выйти из аккаунта"
        >
          <LogOut className="size-4" aria-hidden="true" />
          <span className="sr-only">Выйти</span>
        </Button>
      </div>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => router.push('/sign-in')}
      className="text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      Войти
    </Button>
  )
}
