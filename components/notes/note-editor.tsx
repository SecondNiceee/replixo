'use client'

import { useId } from 'react'
import { Input } from '@/components/ui/input'

interface NoteEditorProps {
  title: string
  content: string
  onTitleChange: (value: string) => void
  onContentChange: (value: string) => void
}

export function NoteEditor({ title, content, onTitleChange, onContentChange }: NoteEditorProps) {
  const titleId = useId()
  const contentId = useId()
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
        <label htmlFor={contentId} className="text-sm font-medium">
          Текст конспекта
        </label>
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
      </div>
    </div>
  )
}
