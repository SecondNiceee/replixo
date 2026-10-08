import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

// ---------------------------------------------------------------------------
// POST /api/lesson/summary
// Body: { transcript: string }. Возвращает { summary } — конспект урока от
// LLM в Yandex AI Studio (OpenAI-совместимый API).
// ---------------------------------------------------------------------------
const MAX_TRANSCRIPT_CHARS = 200_000

const SYSTEM_PROMPT = `Ты — помощник преподавателя. Тебе дают расшифровку онлайн-урока (распознанная речь, возможны ошибки распознавания).
Составь конспект урока на русском языке строго в формате:

Тема урока: ...

Что прошли:
- ...

Ключевые понятия, слова и формулы:
- ...

Где ученик ошибался / что повторить:
- ...

Домашнее задание:
- ... (если не задавали — напиши «Не задано»)

Пиши кратко и по делу, без воды. Не выдумывай того, чего нет в расшифровке.`

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'teacher') {
    return NextResponse.json({ error: 'Только для преподавателей' }, { status: 403 })
  }

  const apiKey = process.env.YANDEX_AI_API_KEY
  const folderId = process.env.YANDEX_FOLDER_ID
  if (!apiKey || !folderId) {
    return NextResponse.json({ error: 'Yandex AI Studio не настроен' }, { status: 500 })
  }

  const body = (await req.json().catch(() => null)) as { transcript?: unknown } | null
  const transcript = typeof body?.transcript === 'string' ? body.transcript.trim() : ''
  if (!transcript) {
    return NextResponse.json({ error: 'Пустая расшифровка' }, { status: 400 })
  }

  const models = [
    process.env.YANDEX_LLM_MODEL || 'deepseek-v4-flash',
    process.env.YANDEX_LLM_FALLBACK_MODEL || 'yandexgpt/latest',
  ]
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: transcript.slice(0, MAX_TRANSCRIPT_CHARS) },
  ]

  for (const model of models) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      const res = await fetch('https://llm.api.cloud.yandex.net/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: `gpt://${folderId}/${model}`,
          temperature: 0.3,
          messages,
        }),
      })

      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
        const summary = data.choices?.[0]?.message?.content?.trim() ?? ''
        return NextResponse.json({ summary, model })
      }

      console.error(`Yandex LLM error (${model}, попытка ${attempt + 1})`, res.status, await res.text())

      // Ретраить имеет смысл только перегрузку/лимиты; 4xx (ключ, каталог, модель) не исправятся сами.
      if (!RETRYABLE_STATUSES.has(res.status)) break
      if (attempt < ATTEMPTS_PER_MODEL - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }

  return NextResponse.json(
    { error: 'Сервис ИИ сейчас перегружен, попробуйте составить конспект ещё раз через минуту' },
    { status: 503 },
  )
}

const ATTEMPTS_PER_MODEL = 3
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
