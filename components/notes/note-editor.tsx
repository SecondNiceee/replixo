'use client'

import { useId, useState } from 'react'
import { Eye, PenLine } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { NoteDocument } from '@/components/notes/note-document'

interface NoteEditorProps {
  title: string
  content: string
  onTitleChange: (value: string) => void
  onContentChange: (value: string) => void
  /** Автор и дата для предпросмотра страниц. */
  author?: string
  date?: number
}

export function NoteEditor({ title, content, onTitleChange, onContentChange, author, date }: NoteEditorProps) {
  const titleId = useId()
  const contentId = useId()
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [previewDate] = useState(() => date ?? Date.now())

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={titleId} className="text-sm font-medium">
          Тема урока
        </label>
        <Input
          id={titleId}
          value={title}
          maxLength={200}
          onChange={(e) => onTitleChange(e.target.value)}
          className="h-10 text-base"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={contentId} className="text-sm font-medium">
            Текст конспекта
          </label>
          <div role="tablist" aria-label="Режим" className="flex rounded-lg bg-muted p-0.5">
            {(
              [
                { value: 'edit', label: 'Текст', icon: PenLine },
                { value: 'preview', label: 'Страницы', icon: Eye },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  mode === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'edit' ? (
          <>
            <textarea
              id={contentId}
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              rows={16}
              className="min-h-64 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
            <p className="text-xs text-muted-foreground">
              {'Строка с двоеточием в конце становится разделом, строка с «- » — пунктом списка.'}
            </p>
          </>
        ) : (
          <div className="max-h-[60dvh] overflow-y-auto rounded-lg bg-muted/50 p-3 sm:p-4">
            <NoteDocument title={title || 'Без темы'} content={content} author={author} date={previewDate} />
          </div>
        )}
      </div>
    </div>
  )
}
