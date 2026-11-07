// Ответ на сообщение — общий для личных чатов и чата комнаты.
//
// В сообщении хранится не ссылка, а снимок цитаты: id оригинала, автор и
// начало текста. Так цитата рисуется без дозапроса оригинала (его может не
// быть в загруженной части ленты), а в комнате переживает и отсутствие БД.

/** Сколько символов оригинала держим в цитате — дальше её всё равно обрезает вёрстка. */
export const REPLY_TEXT_LIMIT = 200

export interface ReplyRef {
  /** id исходного сообщения — по нему цитата прокручивает ленту к оригиналу. */
  id: string
  /** Кто написал оригинал: userId в личных чатах, peerId в комнате. */
  authorId: string
  /** Имя автора на момент ответа. */
  author: string
  text: string
  /** Имя файла, если в оригинале было вложение (для цитаты без текста). */
  attachmentName: string | null
}

function clip(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null
}

/** jsonb из БД или поле из сокета — на клиенте это unknown до проверки формы. */
export function normalizeReply(raw: unknown): ReplyRef | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = clip(r.id, 64)
  const authorId = clip(r.authorId, 128)
  const author = clip(r.author, 80)
  if (!id || !authorId || author === null) return null
  return {
    id,
    authorId,
    author,
    text: clip(r.text, REPLY_TEXT_LIMIT) ?? "",
    attachmentName: clip(r.attachmentName, 120),
  }
}

/** Снимок цитаты из сообщения, на которое отвечают. */
export function buildReply(message: {
  id: string
  authorId: string
  author: string
  text: string
  attachment?: { name: string } | null
}): ReplyRef {
  return {
    id: message.id,
    authorId: message.authorId,
    author: message.author.slice(0, 80),
    text: message.text.trim().slice(0, REPLY_TEXT_LIMIT),
    attachmentName: message.attachment?.name?.slice(0, 120) ?? null,
  }
}

/** Строка-превью цитаты: текст, а если его нет — что было во вложении. */
export function replyPreview(reply: ReplyRef): string {
  if (reply.text) return reply.text
  if (reply.attachmentName) return reply.attachmentName
  return "Сообщение"
}

/**
 * Прокрутить ленту к оригиналу и коротко подсветить его. Ищем по data-атрибуту:
 * если оригинал ещё не подгружен (старше загруженной истории), просто ничего
 * не происходит — цитата и так показывает его начало.
 */
export function scrollToMessage(id: string): void {
  if (typeof document === "undefined") return
  const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
  if (!target) return
  target.scrollIntoView({ behavior: "smooth", block: "center" })
  target.removeAttribute("data-flash")
  // Перезапуск анимации, если по той же цитате кликнули ещё раз.
  void target.offsetWidth
  target.setAttribute("data-flash", "")
  window.setTimeout(() => target.removeAttribute("data-flash"), 1600)
}
