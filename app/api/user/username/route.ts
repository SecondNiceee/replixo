import { headers } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'

const USERNAME_RE = /^[a-zA-Z0-9_]{2,20}$/

// PATCH /api/user/username — change own username
export async function PATCH(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const body = await req.json().catch(() => null)
  const newUsername = typeof body?.username === 'string' ? body.username.trim() : ''

  if (!newUsername) {
    return NextResponse.json({ error: 'username обязателен' }, { status: 400 })
  }

  if (!USERNAME_RE.test(newUsername)) {
    return NextResponse.json(
      {
        error:
          'Username может содержать только латинские буквы, цифры и _, длина 2–20 символов',
      },
      { status: 422 },
    )
  }

  // Check uniqueness (exclude self)
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, newUsername))
    .limit(1)

  if (existing && existing.id !== userId) {
    return NextResponse.json({ error: 'Этот username уже занят' }, { status: 409 })
  }

  const [updated] = await db
    .update(user)
    .set({ username: newUsername, name: newUsername, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning({ id: user.id, username: user.username, name: user.name })

  return NextResponse.json({ user: updated })
}
