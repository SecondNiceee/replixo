import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

// ---------------------------------------------------------------------------
// POST /api/lesson/transcribe
// Body: сырые LPCM 16 кГц, 16 бит, моно (до 30 сек / 1 МБ — лимит синхронного
// распознавания SpeechKit). Возвращает { text }.
// ---------------------------------------------------------------------------
const MAX_BYTES = 1024 * 1024

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.YANDEX_SPEECHKIT_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'SpeechKit не настроен' }, { status: 500 })
  }

  const audio = await req.arrayBuffer()
  if (audio.byteLength === 0) return NextResponse.json({ text: '' })
  if (audio.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'Слишком большой фрагмент' }, { status: 413 })
  }

  const url = new URL('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize')
  url.searchParams.set('lang', 'ru-RU')
  url.searchParams.set('format', 'lpcm')
  url.searchParams.set('sampleRateHertz', '16000')
  // With Api-Key auth the folder is derived from the service account; passing a different folderId causes 401.

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Api-Key ${apiKey}` },
    body: audio,
  })

  if (!res.ok) {
    const details = await res.text()
    console.error('SpeechKit error', res.status, details)
    return NextResponse.json(
      { error: 'Ошибка распознавания', speechkitStatus: res.status, details },
      { status: 502 },
    )
  }

  const data = (await res.json()) as { result?: string }
  return NextResponse.json({ text: data.result ?? '' })
}
