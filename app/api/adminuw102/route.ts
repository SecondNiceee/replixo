import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

const ADMIN_PASSWORD = '11559966332211kkKK'
const NOTE_GRACE_MINUTES = 120

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

function isValidPassword(input: unknown): boolean {
  if (typeof input !== 'string' || input.length > 200) return false
  return timingSafeEqual(digest(input), digest(ADMIN_PASSWORD))
}

export interface CallSessionRow {
  id: string
  roomId: string
  startedAt: string
  endedAt: string
  durationSec: number
  maxParticipants: number
  usedScreenShare: boolean
  usedNotes: boolean
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)

  if (!isValidPassword(body?.password)) {
    await new Promise((r) => setTimeout(r, 800))
    return NextResponse.json({ error: 'Неверный пароль' }, { status: 401 })
  }

  try {
    const { rows } = await pool.query(
      `SELECT cs."id"::text AS "id", cs."roomId", cs."startedAt", cs."endedAt",
              cs."durationSec", cs."maxParticipants", cs."usedScreenShare",
              EXISTS (
                SELECT 1 FROM "lesson_note" n
                WHERE n."roomId" = cs."roomId"
                  AND n."createdAt" >= cs."startedAt"
                  AND n."createdAt" <= cs."endedAt" + make_interval(mins => $1)
              ) AS "usedNotes"
       FROM "call_session" cs
       ORDER BY cs."startedAt" DESC
       LIMIT 1000`,
      [NOTE_GRACE_MINUTES],
    )
    return NextResponse.json({ sessions: rows as CallSessionRow[] })
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') {
      return NextResponse.json({ sessions: [] })
    }
    console.error('[adminuw102] query failed:', (e as Error).message)
    return NextResponse.json({ error: 'Ошибка базы данных' }, { status: 500 })
  }
}
