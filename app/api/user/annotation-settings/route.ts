import { headers } from "next/headers"
import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { annotationSettings } from "@/lib/db/schema"

export type AnnotationSettingsPayload = {
  activation: "none" | "double-click" | "hotkey"
  hotkey: string | null
  hintSeen: boolean
}

function parseBody(body: unknown): AnnotationSettingsPayload | null {
  if (!body || typeof body !== "object") return null
  const value = body as Record<string, unknown>
  const activation = value.activation === "hotkey" || value.activation === "double-click"
    ? value.activation
    : "none"
  const hotkey = typeof value.hotkey === "string" ? value.hotkey.slice(0, 32) : null
  return {
    activation,
    hotkey,
    hintSeen: value.hintSeen === true,
  }
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [row] = await db
    .select()
    .from(annotationSettings)
    .where(eq(annotationSettings.userId, session.user.id))
    .limit(1)

  return NextResponse.json({
    settings: row
      ? { activation: row.activation, hotkey: row.hotkey, hintSeen: row.hintSeen }
      : null,
  })
}

export async function PUT(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const parsed = parseBody(await request.json().catch(() => null))
  if (!parsed) return NextResponse.json({ error: "Некорректное тело запроса" }, { status: 400 })

  await db
    .insert(annotationSettings)
    .values({ userId: session.user.id, ...parsed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: annotationSettings.userId,
      set: { ...parsed, updatedAt: new Date() },
    })

  return NextResponse.json({ settings: parsed })
}
