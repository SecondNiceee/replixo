import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { chatSettings } from '@/lib/db/schema'

// Persisted chat-button settings shape shared with the client store.
interface ChatSettingsPayload {
  showChatButton: boolean
  openChatKey: string
  buttonX: number | null
  buttonY: number | null
}

const DEFAULTS: ChatSettingsPayload = {
  showChatButton: true,
  openChatKey: 'Tab',
  buttonX: null,
  buttonY: null,
}

function normalize(body: unknown): Partial<ChatSettingsPayload> {
  if (!body || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  const out: Partial<ChatSettingsPayload> = {}
  if (typeof b.showChatButton === 'boolean') out.showChatButton = b.showChatButton
  if (typeof b.openChatKey === 'string' && b.openChatKey.length > 0 && b.openChatKey.length <= 32) {
    out.openChatKey = b.openChatKey
  }
  if (typeof b.buttonX === 'number' && b.buttonX >= 0 && b.buttonX <= 1) out.buttonX = b.buttonX
  if (b.buttonX === null) out.buttonX = null
  if (typeof b.buttonY === 'number' && b.buttonY >= 0 && b.buttonY <= 1) out.buttonY = b.buttonY
  if (b.buttonY === null) out.buttonY = null
  return out
}

// GET /api/settings — current user's chat settings (or defaults if none yet).
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [row] = await db
      .select()
      .from(chatSettings)
      .where(eq(chatSettings.userId, session.user.id))
      .limit(1)

    if (!row) {
      return NextResponse.json({ settings: DEFAULTS })
    }

    return NextResponse.json({
      settings: {
        showChatButton: row.showChatButton,
        openChatKey: row.openChatKey,
        buttonX: row.buttonX,
        buttonY: row.buttonY,
      } satisfies ChatSettingsPayload,
    })
  } catch (err) {
    console.error('[settings] GET failed:', err)
    return NextResponse.json({ settings: DEFAULTS })
  }
}

// PUT /api/settings — upsert the current user's chat settings.
// Used both for normal saves and for merging guest (localStorage) settings into
// a freshly registered account.
export async function PUT(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const patch = normalize(await req.json().catch(() => null))

  try {
    const [existing] = await db
      .select()
      .from(chatSettings)
      .where(eq(chatSettings.userId, userId))
      .limit(1)

    const merged: ChatSettingsPayload = {
      showChatButton: patch.showChatButton ?? existing?.showChatButton ?? DEFAULTS.showChatButton,
      openChatKey: patch.openChatKey ?? existing?.openChatKey ?? DEFAULTS.openChatKey,
      buttonX: patch.buttonX !== undefined ? patch.buttonX : existing?.buttonX ?? DEFAULTS.buttonX,
      buttonY: patch.buttonY !== undefined ? patch.buttonY : existing?.buttonY ?? DEFAULTS.buttonY,
    }

    await db
      .insert(chatSettings)
      .values({ userId, ...merged, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: chatSettings.userId,
        set: { ...merged, updatedAt: new Date() },
      })

    return NextResponse.json({ settings: merged })
  } catch (err) {
    console.error('[settings] PUT failed:', err)
    return NextResponse.json({ error: 'Не удалось сохранить настройки' }, { status: 500 })
  }
}
