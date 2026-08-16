/**
 * Запоминание открытого диалога между перезагрузками страницы.
 *
 * Кабинет — рабочий экран: F5 в открытой переписке возвращал в пустое «Выберите
 * чат», и диалог приходилось искать в списке заново. Поэтому активный
 * conversationId держим в localStorage и восстанавливаем при монтировании.
 *
 * Ключ привязан к id пользователя: на общем компьютере вторая учётная запись
 * иначе получила бы чужой последний диалог. Открыть его она всё равно не смогла
 * бы (нет членства — сервер ответит 403), но в интерфейсе мигнула бы чужая
 * переписка.
 *
 * Именно localStorage, а не sessionStorage: смысл в том, чтобы диалог доживал до
 * следующего открытия приложения, а не только до конца жизни таба.
 */

const PREFIX = 'replixo:last-conversation:'

function key(userId: string) {
  return `${PREFIX}${userId}`
}

/**
 * Доступ к localStorage всегда через try/catch: в приватном режиме Safari и при
 * запрете сторонних данных обращение к нему бросает, а падать из-за необязательной
 * памяти об открытом чате нельзя.
 */
export function readLastConversationId(userId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(key(userId))
    return value && value.length > 0 ? value : null
  } catch {
    return null
  }
}

export function writeLastConversationId(userId: string, conversationId: string | null): void {
  if (typeof window === 'undefined') return
  try {
    // null — пользователь закрыл диалог кнопкой «Назад». Это осознанный выход из
    // переписки, поэтому запись удаляем: иначе следующая перезагрузка вернула бы
    // человека туда, откуда он только что вышел.
    if (conversationId) {
      window.localStorage.setItem(key(userId), conversationId)
    } else {
      window.localStorage.removeItem(key(userId))
    }
  } catch {
    // Память об открытом чате — удобство, а не функциональность: молча живём без неё.
  }
}
