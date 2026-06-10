import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { eq, and } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { friendship, user } from '@/lib/db/schema'

// GET /api/friends/pending — incoming pending requests
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
      requesterId: user.id,
      requesterName: user.name,
      requesterUsername: user.username,
    })
    .from(friendship)
    .where(and(eq(friendship.addresseeId, userId), eq(friendship.status, 'pending')))
    .innerJoin(user, eq(user.id, friendship.requesterId))

  return NextResponse.json({ pending: rows })
}
