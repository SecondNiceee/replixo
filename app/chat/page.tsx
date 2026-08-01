import { redirect } from 'next/navigation'

// Переписка переехала в кабинет: список чатов и открытый диалог теперь на одном
// экране с друзьями и заявками. Старые ссылки (уведомления, кнопка «Сообщения»,
// закладки) ведут сюда, поэтому маршрут остаётся и перекидывает на /profile
// вместе с параметрами ?c= и ?u= — без них глубокая ссылка на диалог потерялась
// бы и открывался бы пустой кабинет.
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const query = new URLSearchParams()

  for (const key of ['c', 'u']) {
    const value = params[key]
    const single = Array.isArray(value) ? value[0] : value
    if (single) query.set(key, single)
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  redirect(`/profile${suffix}`)
}
