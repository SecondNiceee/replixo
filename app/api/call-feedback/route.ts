import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { FEEDBACK_COMMENT_MAX } from '@/lib/call-feedback'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)

  const rating = body?.rating
  if (rating !== 1 && rating !== 2 && rating !== 3) {
    return NextResponse.json({ error: 'Invalid rating' }, { status: 400 })
  }

  const roomId = typeof body?.roomId === 'string' ? body.roomId.trim().slice(0, 100) : ''
  if (!roomId) {
    return NextResponse.json({ error: 'Invalid room' }, { status: 400 })
  }

  const rawDuration = Number(body?.durationSec)
  const durationSec = Number.isFinite(rawDuration)
    ? Math.min(Math.max(Math.round(rawDuration), 0), 24 * 3600)
    : 0

  const comment =
    rating < 3 && typeof body?.comment === 'string'
      ? body.comment.trim().slice(0, FEEDBACK_COMMENT_MAX) || null
      : null

  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)

  try {
    await pool.query(
      `INSERT INTO "call_feedback" ("roomId", "userId", "userName", "rating", "comment", "durationSec")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        roomId,
        session?.user?.id ?? null,
        session?.user?.name ?? null,
        rating,
        comment,
        durationSec,
      ],
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[call-feedback] insert failed:', (e as Error).message)
    return NextResponse.json({ error: 'Ошибка базы данных' }, { status: 500 })
  }
}
