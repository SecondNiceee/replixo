import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { chatButtonSettings } from '@/lib/db/schema'

export type ChatButtonSettingsPayload = {
  xRatio: number
  yRatio: number
  visible: boolean
  hotkey: string | null
}

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback
  return Math.min(1, Math.max(0, v))
}

function parseBody(body: unknown): ChatButtonSettingsPayload | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const hotkey =
    b.hotkey === null || b.hotkey === undefined
      ? null
      : typeof b.hotkey === 'string'
        ? b.hotkey.slice(0, 32)
        : null
  return {
    xRatio: clamp01(b.xRatio, 0.92),
    yRatio: clamp01(b.yRatio, 0.78),
    visible: typeof b.visible === 'boolean' ? b.visible : true,
    hotkey,
  }
}

// GET /api/user/chat-button-settings — read own chat button settings.
// Returns { settings: null } when the user has never saved any yet.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [row] = await db
    .select()
    .from(chatButtonSettings)
    .where(eq(chatButtonSettings.userId, session.user.id))
    .limit(1)

  if (!row) {
    return NextResponse.json({ settings: null })
  }

  return NextResponse.json({
    settings: {
      xRatio: row.xRatio,
      yRatio: row.yRatio,
      visible: row.visible,
      hotkey: row.hotkey,
    } satisfies ChatButtonSettingsPayload,
  })
}

// PUT /api/user/chat-button-settings — upsert own chat button settings.
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
    .insert(chatButtonSettings)
    .values({ userId, ...parsed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chatButtonSettings.userId,
      set: { ...parsed, updatedAt: new Date() },
    })
    .returning()

  return NextResponse.json({
    settings: {
      xRatio: row.xRatio,
      yRatio: row.yRatio,
      visible: row.visible,
      hotkey: row.hotkey,
    } satisfies ChatButtonSettingsPayload,
  })
}
