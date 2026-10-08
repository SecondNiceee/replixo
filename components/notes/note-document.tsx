type Block =
  | { type: 'heading'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'para'; text: string }

/** Тема из строки «Тема урока: …» — по ней предзаполняется заголовок. */
export function extractTopic(content: string): string | null {
  const m = content.match(/^\s*\**\s*Тема урока\s*\**\s*:\s*\**\s*(.+?)\**\s*$/im)
  return m?.[1]?.trim() || null
}

/**
 * Конспект хранится обычным текстом в формате, который выдаёт ИИ:
 * «Раздел:» — заголовок, «- пункт» — список. Так его легко править в
 * textarea, а здесь он превращается в свёрстанный документ.
 */
export function parseNote(content: string): Block[] {
  const blocks: Block[] = []
  let list: { type: 'bullets'; items: string[] } | null = null

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim()
    if (!line) {
      list = null
      continue
    }
    const bullet = line.match(/^(?:[-•*–]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      if (!list) {
        list = { type: 'bullets', items: [] }
        blocks.push(list)
      }
      list.items.push(bullet[1])
      continue
    }
    list = null
    if (/^тема урока\s*:/i.test(line)) continue
    const heading = line.match(/^([^:]{2,80}):\s*(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', text: heading[1] })
      if (heading[2]) blocks.push({ type: 'para', text: heading[2] })
      continue
    }
    blocks.push({ type: 'para', text: line })
  }
  return blocks
}

export function NoteDocument({
  title,
  content,
  author,
  date,
}: {
  title: string
  content: string
  author: string
  date: number
}) {
  const blocks = parseNote(content)
  const formatted = new Date(date).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return (
    <article className="note-paper flex flex-col gap-8 rounded-2xl bg-paper px-6 py-10 text-paper-foreground shadow-2xl sm:px-14 sm:py-14 print:rounded-none print:p-0 print:shadow-none">
      <header className="flex flex-col gap-4 border-b border-paper-rule pb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Конспект урока</p>
        <h1 className="text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{title}</h1>
        <p className="text-sm text-paper-muted">
          {author} · {formatted}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {blocks.map((block, i) => {
          if (block.type === 'heading') {
            return (
              <h2
                key={i}
                className="mt-5 break-after-avoid text-sm font-semibold uppercase tracking-[0.12em] text-primary first:mt-0"
              >
                {block.text}
              </h2>
            )
          }
          if (block.type === 'bullets') {
            return (
              <ul key={i} className="flex flex-col gap-2">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-3 text-pretty text-base leading-relaxed">
                    <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )
          }
          return (
            <p key={i} className="text-pretty text-base leading-relaxed">
              {block.text}
            </p>
          )
        })}
      </div>

      <footer className="border-t border-paper-rule pt-6 text-xs text-paper-muted">Составлено в Replixo</footer>
    </article>
  )
}
