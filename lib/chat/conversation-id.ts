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

/**
 * Id «Избранного» — личного чата пользователя с самим собой.
 *
 * Это тот же детерминированный формат с обоими концами на одном пользователе
 * (`direct:<uid>:<uid>`), поэтому отдельной таблицы и отдельного типа диалога
 * не нужно: работает вся существующая механика ЛС (история, вложения, поиск).
 * Приватность держится на строках dm_conversation_member — участник ровно один,
 * а сокет рассылает события только по ним.
 */
export function savedConversationId(userId: string): string {
  return directConversationId(userId, userId)
}

/** Достаёт id второго участника из детерминированного id диалога. */
export function otherUserIdFrom(conversationId: string, selfId: string): string | null {
  if (!conversationId.startsWith('direct:')) return null
  const parts = conversationId.split(':')
  if (parts.length !== 3) return null
  const [, a, b] = parts
  // «Избранное»: оба конца — один и тот же человек, собеседника нет. Проверка
  // идёт до сравнения с selfId, иначе для такого id вернулся бы сам selfId, и
  // вызывающий код принял бы пользователя за собеседника (на сервере это
  // означало бы проверку «дружбы с самим собой» и отказ в отправке).
  if (a === b) return null
  if (a === selfId) return b
  if (b === selfId) return a
  return null
}
