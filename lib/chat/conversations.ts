// ---------------------------------------------------------------------------
// Чтение списка личных диалогов из БД.
//
// Вынесено из app/api/chat/conversations/route.ts: те же данные нужны серверному
// рендеру /profile, чтобы список чатов был в HTML первым кадром. Роут остаётся
// точкой ревалидации и вызывает эту же функцию.
// ---------------------------------------------------------------------------

import { and, eq, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@/lib/db'
import { conversation, conversationMember, directMessage, user } from '@/lib/db/schema'
import type { DmConversation } from '@/app/chat/types'

/**
 * Диалоги пользователя, свежие сверху.
 *
 * Один запрос: моё членство → диалог → членство собеседника → его профиль →
 * последнее сообщение (по денормализованному lastMessageId).
 */
export async function listConversations(userId: string): Promise<DmConversation[]> {
  // Второе членство в том же диалоге — это собеседник.
  const peer = alias(conversationMember, 'peer')

  const rows = await db
    .select({
      id: conversation.id,
      lastMessageAt: conversation.lastMessageAt,
      unreadCount: conversationMember.unreadCount,
      // Маркер прочтения собеседника: по нему рисуются двойные галочки на
      // моих сообщениях до перезагрузки страницы (дальше его двигает сокет).
      peerLastReadAt: peer.lastReadAt,
      friendId: user.id,
      friendName: user.name,
      friendUsername: user.username,
      lastMessageText: directMessage.text,
      // Нужен для превью: у сообщения-файла текст пустой, и без этого в списке
      // висело бы «Нет сообщений».
      lastMessageAttachment: directMessage.attachment,
      lastMessageSenderId: directMessage.senderId,
    })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .innerJoin(peer, and(eq(peer.conversationId, conversation.id), ne(peer.userId, userId)))
    .innerJoin(user, eq(user.id, peer.userId))
    .leftJoin(directMessage, eq(directMessage.id, conversation.lastMessageId))
    .where(eq(conversationMember.userId, userId))
    // NULLS LAST обязателен: в Postgres DESC ставит NULL первыми, из-за чего
    // только что созданные диалоги без сообщений висели бы выше активных.
    .orderBy(sql`${conversation.lastMessageAt} DESC NULLS LAST`)

  // Даты в ISO приводим здесь, а не полагаемся на NextResponse.json: клиент
  // ждёт строку (DmConversation.lastMessageAt / peerLastReadAt), а drizzle
  // отдаёт Date. Иначе SSR-пропсы и ответ роута имели бы разную форму, и
  // new Date(peerLastReadAt) после первой ревалидации получил бы другой тип —
  // галочки прочтения дрогнули бы на глазах.
  return rows.map((r) => ({
    ...r,
    lastMessageAt: toIso(r.lastMessageAt),
    peerLastReadAt: toIso(r.peerLastReadAt),
  }))
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}
