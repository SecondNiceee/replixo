import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

// Ссылки из писем и закладок открывают форму входа на стартовой странице.
export default async function SignInPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect('/profile')
  redirect('/?auth=sign-in')
}
