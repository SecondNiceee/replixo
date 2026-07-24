import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { conversationMember } from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// POST /api/chat/upload?conversationId=<id>   (multipart/form-data, поле "file")
//
// Прокси к POST /dm/:conversationId/upload на mediasoup-сервере. Нужен потому,
// что тот эндпоинт требует `Authorization: Bearer <session token>`, а браузер
// токена не видит: cookie httoOnly и на другой домен не уходит. Здесь мы
// достаём токен из серверной сессии и подставляем его сами.
//
// Ответ сервера (`{ url, name, size, mime }`) отдаём клиенту как есть — этот
// объект затем уходит в dm:send, где сервер повторно проверяет, что url ведёт
// именно в папку данного диалога.
// ---------------------------------------------------------------------------

/**
 * Базовый адрес mediasoup-сервера для запроса «сервер → сервер».
 * MEDIASOUP_URL — приватная переменная (может указывать на localhost:3001 внутри
 * VPS); NEXT_PUBLIC_MEDIASOUP_URL — публичный фолбэк, тот же, что у клиента.
 */
function mediasoupBaseUrl(): string {
  const raw =
    process.env.MEDIASOUP_URL ??
    process.env.NEXT_PUBLIC_MEDIASOUP_URL ??
    'http://localhost:3001'
  return raw.replace(/\/+$/, '')
}

// Тот же формат, что проверяет сервер (server/src/dm/uploads.ts): точка
// запрещена, поэтому «..» отсекается до любых операций с путями.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const conversationId = new URL(req.url).searchParams.get('conversationId') ?? ''
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return NextResponse.json({ error: 'Некорректный диалог' }, { status: 400 })
  }

  // Membership проверяем и здесь, до отправки байтов на mediasoup-сервер: он
  // проверит ещё раз, но незачем гонять по сети файл, который будет отвергнут.
  const [member] = await db
    .select({ userId: conversationMember.userId })
    .from(conversationMember)
    .where(
      and(
        eq(conversationMember.conversationId, conversationId),
        eq(conversationMember.userId, session.user.id),
      ),
    )
    .limit(1)

  if (!member) {
    return NextResponse.json({ error: 'Нет доступа к диалогу' }, { status: 403 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Файл не передан' }, { status: 400 })
  }

  // Пересобираем FormData: так сохраняются имя файла и content-type, а границы
  // multipart генерирует fetch — вручную прокидывать заголовок не нужно.
  const forwarded = new FormData()
  forwarded.append('file', file, file.name)

  try {
    const upstream = await fetch(
      `${mediasoupBaseUrl()}/dm/${encodeURIComponent(conversationId)}/upload`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${session.session.token}` },
        body: forwarded,
        cache: 'no-store',
      },
    )

    const payload = await upstream.json().catch(() => ({ error: 'upload failed' }))
    return NextResponse.json(payload, { status: upstream.status })
  } catch (e) {
    // Сервер вложений недоступен (не запущен / сеть) — это не 500 приложения,
    // а именно недоступность внешней зависимости.
    console.error('[chat] upload proxy failed:', (e as Error).message)
    return NextResponse.json(
      { error: 'Сервер вложений недоступен' },
      { status: 502 },
    )
  }
}
