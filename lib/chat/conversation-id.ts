// Детерминированный id личного диалога 1:1.
//
// Пара пользователей всегда даёт один и тот же id независимо от того, кто
// открыл чат первым. Это избавляет от гонок и от лишнего unique-индекса:
// создание диалога — обычный INSERT ... ON CONFLICT DO NOTHING по первичному
// ключу. Такой же приём используется на mediasoup-сервере (server/src/dm),
// поэтому логика продублирована там намеренно — сервер не импортирует код
// Next-приложения.
export function directConversationId(a: string, b: string): string {
  const [min, max] = a < b ? [a, b] : [b, a]
  return `direct:${min}:${max}`
}

// id чата «Избранное» — переписки пользователя с самим собой.
//
// Префикс намеренно другой (`self:`, а не `direct:`): по нему
// otherUserIdFrom() возвращает null, и сокет-сервер не пытается проверить
// дружбу пользователя с самим собой перед отправкой сообщения. Второе
// следствие — участник у такого диалога ровно один.
export function selfConversationId(userId: string): string {
  return `self:${userId}`
}

export function isSelfConversationId(conversationId: string): boolean {
  return conversationId.startsWith('self:')
}

/** Достаёт id второго участника из детерминированного id диалога. */
export function otherUserIdFrom(conversationId: string, selfId: string): string | null {
  if (!conversationId.startsWith('direct:')) return null
  const parts = conversationId.split(':')
  if (parts.length !== 3) return null
  const [, a, b] = parts
  if (a === selfId) return b
  if (b === selfId) return a
  return null
}
