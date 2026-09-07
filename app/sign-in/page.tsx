import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

// Отдельной страницы входа больше нет — форма живёт в попапе на лендинге.
// Маршрут оставлен, чтобы старые ссылки (письмо сброса пароля, закладки)
// не вели в 404, а открывали тот же попап.
export default async function SignInPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/profile')
  redirect('/?auth=sign-in')
}
