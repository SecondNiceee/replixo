import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

// ---------------------------------------------------------------------------
// POST /api/lesson/summary
// Body: { transcript: string }. Возвращает { summary } — конспект урока от
// LLM в Yandex AI Studio (OpenAI-совместимый API).
// ---------------------------------------------------------------------------
const MAX_TRANSCRIPT_CHARS = 200_000

// Живая речь на уроке — примерно 110 слов в минуту, страница конспекта — ~400 слов.
const WORDS_PER_MINUTE = 110
const WORDS_PER_PAGE = 400

function lengthGuide(transcript: string) {
  const words = transcript.split(/\s+/).filter(Boolean).length
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE))
  if (minutes < 10) {
    return { minutes, guide: 'Урок короткий: конспект на полстраницы–страницу, только суть.' }
  }
  const pages = Math.min(7, Math.max(1, Math.round(minutes / 18)))
  const targetWords = pages * WORDS_PER_PAGE
  return {
    minutes,
    guide: `Урок длился около ${minutes} мин. Конспект должен быть подробным: примерно ${pages} стр. (≈${targetWords} слов). Короткий конспект для такого урока — ошибка. Если материала в расшифровке меньше, не выдумывай, но раскрой всё, что есть.`,
  }
}

function buildSystemPrompt(guide: string) {
  return `Ты — опытный методист и помощник преподавателя. Тебе дают расшифровку онлайн-урока (распознанная речь, возможны ошибки распознавания — исправляй их по смыслу).
Составь полноценный учебный конспект урока на русском языке, по которому ученик сможет повторить материал без записи.

${guide}

Формат (строго соблюдай разметку):
- Заголовок раздела — отдельная строка, заканчивающаяся двоеточием, например «Ход урока:».
- Пункт списка — строка, начинающаяся с «- ».
- Обычный абзац — просто строка текста. Не начинай абзацы со слова с двоеточием, иначе он станет заголовком.
- Никакого Markdown (#, **, таблиц).

Структура:

Тема урока: ...

Краткое резюме:
Абзац из 3–5 предложений о том, чему был посвящён урок и к чему пришли.

Затем для КАЖДОЙ темы или этапа урока — отдельный раздел с её названием, например «Часть 1. Сложение дробей:». В нём:
- объяснение правила или идеи своими словами, как его давал преподаватель;
- разобранные примеры и задачи с ходом решения и ответом;
- важные замечания, исключения, типичные ловушки.

Ключевые понятия, слова и формулы:
- термин или формула — пояснение

Вопросы ученика и ответы:
- ... (если вопросов не было — пропусти раздел)

Где ученик ошибался / что повторить:
- ...

Домашнее задание:
- ... (если не задавали — напиши «Не задано»)

Рекомендации к следующему уроку:
- ...

Пиши содержательно и конкретно, без воды и общих фраз. Не выдумывай того, чего нет в расшифровке.`
}

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
  const { guide } = lengthGuide(transcript)
  const messages = [
    { role: 'system', content: buildSystemPrompt(guide) },
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
          max_tokens: MAX_OUTPUT_TOKENS,
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
// Без явного лимита модель обрезает ответ на ~2000 токенов — отсюда «маленькие» конспекты.
const MAX_OUTPUT_TOKENS = 8000
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
