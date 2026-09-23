import { Analytics } from '@vercel/analytics/next'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { auth } from '@/lib/auth'
import { ElectronPatches } from '@/components/electron-patches'
import { DesktopTitlebar } from '@/components/desktop-titlebar'
import { DmNotifier } from '@/components/dm-notifier'
import './globals.css'

const inter = Inter({ variable: '--font-inter', subsets: ['latin', 'cyrillic'] })
const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  metadataBase: new URL('https://replixo.app'),
  title: {
    default: 'Replixo — Видеоплатформа для преподавателей и онлайн-уроков',
    template: '%s — Replixo',
  },
  description:
    'Replixo — видеоплатформа для преподавателей: проводите онлайн-уроки с учениками прямо в браузере. Интерактивная доска, демонстрация экрана, уроки без ограничения по времени и без VPN. Ученик подключается по коду в один клик.',
  keywords: [
    'видеоплатформа для преподавателей',
    'онлайн-уроки',
    'видеосвязь для учителей',
    'платформа для репетиторов',
    'видеозвонки с учениками',
    'дистанционное обучение',
    'интерактивная доска онлайн',
    'демонстрация экрана для урока',
    'онлайн-репетитор',
    'видеоуроки в браузере',
  ],
  authors: [{ name: 'Replixo' }],
  category: 'education',
  generator: 'v0.app',
  openGraph: {
    type: 'website',
    locale: 'ru_RU',
    siteName: 'Replixo',
    title: 'Replixo — Видеоплатформа для преподавателей и онлайн-уроков',
    description:
      'Проводите онлайн-уроки с учениками прямо в браузере: интерактивная доска, демонстрация экрана, уроки без ограничения по времени и без VPN.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Replixo — Видеоплатформа для преподавателей',
    description:
      'Онлайн-уроки с учениками прямо в браузере. Доска, демонстрация экрана, без таймеров и без VPN.',
  },
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Личность нужна здесь, чтобы уведомитель личных сообщений работал на любой
  // странице. Анонимным посетителям он не монтируется вовсе — иначе лендинг
  // делал бы заведомо безуспешные запросы за токеном сокета и списком диалогов.
  const session = await auth.api.getSession({ headers: await headers() })

  return (
    <html
      lang="ru"
      className={`${inter.variable} ${jetbrainsMono.variable} bg-background`}
    >
      <body className="font-sans antialiased">
        <ElectronPatches />
        <DesktopTitlebar />
        {session?.user && <DmNotifier selfId={session.user.id} />}
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
