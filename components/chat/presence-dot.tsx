'use client'

import { cn } from '@/lib/utils'
import type { PresenceStatus } from '@/stores/dm-store'

// ---------------------------------------------------------------------------
// Точка статуса на аватаре. Одна на все списки: раньше эта разметка была
// скопирована в четырёх местах, и «жёлтый для отошедших» пришлось бы добавлять
// в каждое — с неизбежным расхождением оттенков и размеров.
//
// Оффлайн рисуем ОТСУТСТВИЕМ точки, а не серой точкой: серая на сером аватаре
// читается как «что-то есть», а её и не должно быть видно — за оффлайн отвечает
// текстовая подпись «был(а) N минут назад».
// ---------------------------------------------------------------------------

interface PresenceDotProps {
  status: PresenceStatus
  /**
   * Цвет обводки. Точка лежит на аватаре, поэтому её отделяет от него кольцо
   * цвета фона: без обводки зелёное на зелёном сливается. Значение зависит от
   * подложки (карточка, активная строка списка), поэтому задаётся снаружи.
   */
  ringClassName?: string
  className?: string
  /**
   * Подпись для скринридера. Если статус уже написан рядом текстом, точка
   * декоративна — тогда оставляем пустым, чтобы не читать одно и то же дважды.
   */
  label?: string
}

const COLORS: Record<Exclude<PresenceStatus, 'offline'>, string> = {
  online: 'bg-emerald-500',
  // Жёлтый — общепринятый «отошёл»: тот же смысловой код, что в Slack и Discord,
  // поэтому объяснять его пользователю не нужно.
  idle: 'bg-amber-400',
}

export function PresenceDot({
  status,
  ringClassName = 'border-card',
  className,
  label,
}: PresenceDotProps) {
  if (status === 'offline') return null

  return (
    <span
      className={cn(
        'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2',
        COLORS[status],
        ringClassName,
        className,
      )}
      // role/aria-label только когда подпись есть: пустой label означает, что
      // статус уже озвучен текстом рядом.
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
