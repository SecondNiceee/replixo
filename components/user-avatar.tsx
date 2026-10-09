import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const SIZES = {
  sm: 'size-9',
  md: 'size-10',
  lg: 'size-12',
} as const

type UserAvatarProps = {
  name: string
  size?: keyof typeof SIZES
  className?: string
  /** Дополнительные элементы поверх аватара, например точка статуса. */
  children?: ReactNode
}

export function UserAvatar({ name, size = 'md', className, children }: UserAvatarProps) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-sm text-foreground ring-1 ring-inset ring-border md:text-base',
        SIZES[size],
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
      {children}
    </span>
  )
}
