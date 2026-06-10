import { betterAuth } from 'better-auth'
import { username } from 'better-auth/plugins'
import { pool } from '@/lib/db'

const USERNAME_RE = /^[a-zA-Z0-9_]{2,20}$/

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
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : process.env.V0_RUNTIME_URL),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
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
