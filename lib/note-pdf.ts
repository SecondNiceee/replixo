import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'
import { parseNote } from '@/components/notes/note-document'

const COLORS = {
  primary: '#4F5BD5',
  text: '#1F2433',
  muted: '#6B7280',
  rule: '#E3E5EA',
}

function safeFileName(title: string) {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${cleaned.slice(0, 80) || 'Конспект урока'}.pdf`
}

function rule(): Content {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 495, y2: 0, lineWidth: 0.75, lineColor: COLORS.rule }],
    margin: [0, 14, 0, 14],
  }
}

/**
 * Собирает настоящий PDF-файл в браузере и скачивает его.
 * pdfmake грузится лениво, чтобы не утяжелять страницу. Встроенный шрифт
 * Roboto поддерживает кириллицу, поэтому текст в PDF остаётся текстом.
 */
export async function downloadNotePdf(note: {
  title: string
  content: string
  author: string
  date: number
}) {
  const [{ default: pdfMake }, fontsModule] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ])
  // В разных сборках 0.2.x vfs экспортируется по-разному.
  const fonts = fontsModule as unknown as Record<string, any>
  pdfMake.vfs = fonts.pdfMake?.vfs ?? fonts.default?.pdfMake?.vfs ?? fonts.default ?? fonts

  const date = new Date(note.date).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const body: Content[] = parseNote(note.content).map((block) => {
    if (block.type === 'heading') {
      return {
        text: block.text.toUpperCase(),
        style: 'heading',
        headlineLevel: 1,
      }
    }
    if (block.type === 'bullets') {
      return {
        ul: block.items,
        markerColor: COLORS.primary,
        style: 'body',
        margin: [0, 0, 0, 8],
      }
    }
    return { text: block.text, style: 'body', margin: [0, 0, 0, 8] }
  })

  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [50, 56, 50, 56],
    info: { title: note.title, author: note.author, creator: 'Replixo' },
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.4, color: COLORS.text },
    styles: {
      eyebrow: { fontSize: 8, bold: true, color: COLORS.primary, characterSpacing: 1.5 },
      title: { fontSize: 24, bold: true, lineHeight: 1.15, margin: [0, 8, 0, 8] },
      meta: { fontSize: 9.5, color: COLORS.muted },
      heading: { fontSize: 9, bold: true, color: COLORS.primary, characterSpacing: 1.2, margin: [0, 14, 0, 6] },
      body: { fontSize: 11, lineHeight: 1.45 },
    },
    content: [
      { text: 'КОНСПЕКТ УРОКА', style: 'eyebrow' },
      { text: note.title, style: 'title' },
      { text: `${note.author} · ${date}`, style: 'meta' },
      rule(),
      ...body,
    ],
    footer: (current, total) => ({
      columns: [
        { text: 'Составлено в Replixo', color: COLORS.muted, fontSize: 8 },
        { text: `${current} / ${total}`, alignment: 'right', color: COLORS.muted, fontSize: 8 },
      ],
      margin: [50, 20, 50, 0],
    }),
    // Не оставляем заголовок раздела одиноким внизу страницы.
    pageBreakBefore: (node, following) =>
      node.headlineLevel === 1 && following.length === 0,
  }

  pdfMake.createPdf(doc).download(safeFileName(note.title))
}
