'use client'

import { Search, X } from 'lucide-react'

interface ListSearchProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Подпись для скринридера: полей поиска в кабинете два — по чатам и по друзьям. */
  label: string
}

/**
 * Поле фильтрации над списком левой панели.
 *
 * Общий компонент, а не по инпуту на список: панель одна, табы переключают её
 * содержимое, и если у «Чатов» поле есть, а у «Друзей» нет — список при
 * переключении прыгает на высоту этого поля. Это и выглядело как недоделка.
 */
export function ListSearch({ value, onChange, placeholder, label }: ListSearchProps) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        // Не «пилюля»: у табов прямой рельс с подчёркиванием, и капсульный инпут
        // под ним смотрелся бы из другого набора.
        className="h-9 w-full rounded-lg border border-transparent bg-foreground/5 pl-9 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-card [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          aria-label="Очистить поиск"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
