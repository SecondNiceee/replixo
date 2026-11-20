import { Analytics } from '@vercel/analytics/next'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Script from 'next/script'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { auth } from '@/lib/auth'
import { ElectronPatches } from '@/components/electron-patches'
import { DesktopTitlebar } from '@/components/desktop-titlebar'
import { DmNotifier } from '@/components/dm-notifier'
import { CallFeedbackPrompt } from '@/components/call-feedback-prompt'
import { ThemeProvider } from '@/components/theme-provider'
import { SITE_NAME, SITE_URL } from '@/lib/seo'
import './globals.css'

const inter = Inter({ variable: '--font-inter', subsets: ['latin', 'cyrillic'] })
const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  formatDetection: { telephone: false, email: false, address: false },
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
    icon: { url: '/icon.svg', type: 'image/svg+xml' },
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
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="light"
          enableSystem={false}
          storageKey="replixo-theme"
          disableTransitionOnChange
        >
          <ElectronPatches />
          <DesktopTitlebar />
          {session?.user && <DmNotifier selfId={session.user.id} />}
          {children}
          <CallFeedbackPrompt />
        </ThemeProvider>
        {process.env.NODE_ENV === 'production' && (
          <>
            <Analytics />
            <Script id="yandex-metrika" strategy="afterInteractive">
              {`
                (function(m,e,t,r,i,k,a){
                  m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
                  m[i].l=1*new Date();
                  for (var j = 0; j < document.scripts.length; j++) {
                    if (document.scripts[j].src === r) { return; }
                  }
                  k=e.createElement(t),a=e.getElementsByTagName(t)[0];
                  k.async=1;k.src=r;a.parentNode.insertBefore(k,a);
                })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=114393776', 'ym');

                ym(114393776, 'init', {
                  ssr: true,
                  webvisor: true,
                  clickmap: true,
                  ecommerce: 'dataLayer',
                  referrer: document.referrer,
                  url: location.href,
                  accurateTrackBounce: true,
                  trackLinks: true
                });
              `}
            </Script>
            <noscript>
              <div>
                {/* The counter must also work when JavaScript is disabled. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="https://mc.yandex.ru/watch/114393776"
                  style={{ position: 'absolute', left: '-9999px' }}
                  alt=""
                />
              </div>
            </noscript>
          </>
        )}
      </body>
    </html>
  )
}
