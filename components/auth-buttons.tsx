'use client'

import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { LogOut, UserCircle } from 'lucide-react'

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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/profile')}
          className="text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <UserCircle className="size-4" aria-hidden="true" />
          <span className="hidden md:inline">Профиль</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Выйти из аккаунта"
        >
          <LogOut className="size-4" aria-hidden="true" />
          <span className="hidden md:inline">Выйти</span>
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
