import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

// См. комментарий в app/sign-in/page.tsx — форма регистрации теперь в попапе.
export default async function SignUpPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/profile')
  redirect('/?auth=sign-up')
}
