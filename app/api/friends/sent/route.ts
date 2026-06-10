import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship, user } from '@/lib/db/schema'

// GET /api/friends/sent — outgoing pending requests sent by the current user
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const rows = await db
    .select({
      id: friendship.id,
      createdAt: friendship.createdAt,
      addresseeId: user.id,
      addresseeName: user.name,
      addresseeUsername: user.username,
    })
    .from(friendship)
    .where(and(eq(friendship.requesterId, userId), eq(friendship.status, 'pending')))
    .innerJoin(user, eq(user.id, friendship.addresseeId))

  return NextResponse.json({ sent: rows })
}
