'use client'

import type { ReactElement, ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { AddFriendForm } from './add-friend-form'

interface AddFriendDialogProps {
  /** Элемент-кнопка, в который рендерится триггер (render-prop Base UI). */
  trigger: ReactElement
  children: ReactNode
}

/**
 * Диалог «Добавить в друзья». Один на всё приложение: его открывают и кнопка
 * в шапке кабинета, и пустое состояние списка друзей.
 */
export function AddFriendDialog({ trigger, children }: AddFriendDialogProps) {
  return (
    <Dialog>
      <DialogTrigger render={trigger}>{children}</DialogTrigger>
      {/* app-dark обязателен: DialogContent рендерится в портал у <body>,
          вне <main class="app-dark">, и без класса взял бы палитру :root
          без акцента кабинета. */}
      <DialogContent className="app-dark bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Добавить в друзья</DialogTitle>
          <DialogDescription>
            Введите username — человек получит заявку и сможет её принять.
          </DialogDescription>
        </DialogHeader>
        <AddFriendForm />
      </DialogContent>
    </Dialog>
  )
}
