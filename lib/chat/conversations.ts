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
import { isSelfConversationId, selfConversationId } from '@/lib/chat/conversation-id'
import { FAVORITES_TITLE, type DmConversation } from '@/app/chat/types'

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
    // leftJoin, а не innerJoin: у чата «Избранное» участник ровно один, и на
    // внутреннем соединении такой диалог не попал бы в список вообще.
    .leftJoin(peer, and(eq(peer.conversationId, conversation.id), ne(peer.userId, userId)))
    .leftJoin(user, eq(user.id, peer.userId))
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
  const conversations: DmConversation[] = []

  for (const r of rows) {
    const base = {
      ...r,
      lastMessageAt: toIso(r.lastMessageAt),
      peerLastReadAt: toIso(r.peerLastReadAt),
    }

    if (isSelfConversationId(r.id)) {
      // «Избранное»: собеседника нет, поэтому подставляем себя и обнуляем всё,
      // что относится к другому человеку. unreadCount в БД и так всегда 0 —
      // инкремент идёт строкам с userId <> senderId, а их здесь нет.
      conversations.push({
        ...base,
        friendId: userId,
        friendName: FAVORITES_TITLE,
        friendUsername: null,
        unreadCount: 0,
        peerLastReadAt: null,
        isSelf: true,
      })
      continue
    }

    // Страховка от leftJoin: у обычного direct-диалога собеседник обязан быть,
    // и строка без профиля попала бы в UI пустым именем вместо ошибки.
    if (r.friendId === null || r.friendName === null) continue

    conversations.push({
      ...base,
      friendId: r.friendId,
      friendName: r.friendName,
    })
  }

  // Строку «Избранное» показываем всегда, даже если диалога в БД ещё нет: он
  // создаётся при первом открытии, а не на пути чтения списка.
  if (!conversations.some((c) => c.isSelf)) {
    conversations.push({
      id: selfConversationId(userId),
      friendId: userId,
      friendName: FAVORITES_TITLE,
      friendUsername: null,
      unreadCount: 0,
      peerLastReadAt: null,
      lastMessageAt: null,
      lastMessageText: null,
      lastMessageAttachment: null,
      lastMessageSenderId: null,
      isSelf: true,
      pending: true,
    })
  }

  return conversations
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}
