import { betterAuth } from 'better-auth'
import { username } from 'better-auth/plugins'
import { pool } from '@/lib/db'
import { Resend } from 'resend'

const USERNAME_RE = /^[a-zA-Z0-9_]{2,20}$/

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null

const APP_URL =
  process.env.BETTER_AUTH_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.V0_RUNTIME_URL ?? 'http://localhost:3000')

export const auth = betterAuth({
  database: pool,
  plugins: [
    username({
      maxUsernameLength: 20,
      minUsernameLength: 2,
      // Reject non-latin usernames at the Better Auth level
      validator: (value: string) => USERNAME_RE.test(value),
    }),
  ],
  baseURL: APP_URL,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    sendResetPassword: async ({ user, url }) => {
      if (!resend) {
        console.error('[auth] RESEND_API_KEY not set — cannot send reset email')
        return
      }
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL ?? 'noreply@replixo.com',
        to: user.email,
        subject: 'Сброс пароля — Replixo',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h2 style="margin:0 0 16px">Сброс пароля</h2>
            <p style="color:#6b7280;margin:0 0 24px">
              Мы получили запрос на сброс пароля для вашего аккаунта.
              Нажмите кнопку ниже, чтобы задать новый пароль.
              Ссылка действует <strong>1 час</strong>.
            </p>
            <a
              href="${url}"
              style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;
                     padding:12px 24px;border-radius:8px;font-weight:600"
            >
              Сбросить пароль
            </a>
            <p style="color:#9ca3af;font-size:12px;margin:24px 0 0">
              Если вы не запрашивали сброс — просто проигнорируйте это письмо.
            </p>
          </div>
        `,
      })
    },
  },
  trustedOrigins: [
    ...(process.env.V0_RUNTIME_URL ? [process.env.V0_RUNTIME_URL] : []),
    ...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []),
    ...(process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]
      : []),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 дней
    updateAge: 60 * 60 * 24,     // обновлять раз в сутки
  },
  ...(process.env.NODE_ENV === 'development'
    ? {
        advanced: {
          // v0 preview работает в cross-site iframe —
          // без этого браузер молча теряет session cookie.
          defaultCookieAttributes: {
            sameSite: 'none' as const,
            secure: true,
          },
        },
      }
    : {}),
})
