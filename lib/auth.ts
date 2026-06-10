import { betterAuth } from 'better-auth'
import { username } from 'better-auth/plugins'
import { pool } from '@/lib/db'
import nodemailer from 'nodemailer'

const USERNAME_RE = /^[a-zA-Z0-9_]{2,20}$/

function createTransport() {
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS

  if (!host || !user || !pass) return null

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_PORT === '465',
    auth: { user, pass },
  })
}

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
      usernameValidator: (value: string) => USERNAME_RE.test(value),
    }),
  ],
  baseURL: APP_URL,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    sendResetPassword: async ({ user, url }) => {
      const transport = createTransport()
      if (!transport) {
        console.error('[auth] SMTP env vars not set — cannot send reset email')
        return
      }
      await transport.sendMail({
        from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
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
