// Общие типы и мелкие помощники личного чата.

export interface DmSocketData {
  userId?: string
  name?: string
  username?: string | null
}

/**
 * Socket.io-комната всех соединений одного пользователя. Так сообщение
 * доставляется на все его устройства/вкладки, даже когда чат закрыт.
 */
export function userRoom(userId: string): string {
  return `user:${userId}`
}

/**
 * Второй участник диалога из детерминированного id `direct:<minId>:<maxId>`.
 * null — это не 1:1 диалог или пользователь в нём не участвует (тогда доступ
 * всё равно отсечёт membership-проверка в БД).
 *
 * Дублирует lib/chat/conversation-id.ts намеренно: сервер собирается
 * отдельным tsconfig и не импортирует код Next-приложения.
 */
export function otherUserIdFrom(conversationId: string, selfId: string): string | null {
  if (!conversationId.startsWith('direct:')) return null
  const parts = conversationId.split(':')
  if (parts.length !== 3) return null
  const [, a, b] = parts
  if (a === selfId) return b
  if (b === selfId) return a
  return null
}
