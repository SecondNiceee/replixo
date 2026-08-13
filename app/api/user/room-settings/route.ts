import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { roomSettings } from '@/lib/db/schema'

export type RoomSettingsPayload = {
  soundVolume: number
  noiseGate: boolean
  noiseGateStrength: number
}

function clamp100(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.min(100, Math.max(0, v))
}

function parseBody(body: unknown): RoomSettingsPayload | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  return {
    soundVolume: clamp100(b.soundVolume, 80),
    // Gate is on by default, so anything that isn't an explicit `false` keeps it on.
    noiseGate: typeof b.noiseGate === 'boolean' ? b.noiseGate : true,
    // Threshold position on the mic meter (0..100 ≙ -60..0 dBFS).
    noiseGateStrength: clamp100(b.noiseGateStrength, 20),
  }
}

// GET /api/user/room-settings
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [row] = await db
    .select()
    .from(roomSettings)
    .where(eq(roomSettings.userId, session.user.id))
    .limit(1)

  if (!row) {
    return NextResponse.json({ settings: null })
  }

  return NextResponse.json({
    settings: {
      soundVolume: row.soundVolume,
      noiseGate: row.noiseGate,
      noiseGateStrength: row.noiseGateStrength,
    } satisfies RoomSettingsPayload,
  })
}

// PUT /api/user/room-settings
export async function PUT(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const parsed = parseBody(await req.json().catch(() => null))
  if (!parsed) {
    return NextResponse.json({ error: 'Некорректное тело запроса' }, { status: 400 })
  }

  const [row] = await db
    .insert(roomSettings)
    .values({ userId, ...parsed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: roomSettings.userId,
      set: { ...parsed, updatedAt: new Date() },
    })
    .returning()

  return NextResponse.json({
    settings: {
      soundVolume: row.soundVolume,
      noiseGate: row.noiseGate,
      noiseGateStrength: row.noiseGateStrength,
    } satisfies RoomSettingsPayload,
  })
}
