import { defineConfig } from 'drizzle-kit'
import { config as loadEnv } from 'dotenv'

// drizzle-kit does NOT read .env files on its own, so load them here.
// Order matters: the first file that defines a variable wins.
loadEnv({ path: ['.env.development.local', '.env.local', '.env', '.env.production'] })

const url = process.env.DATABASE_URL

if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Add it to .env (or .env.local) in the project root, e.g.\nDATABASE_URL=postgres://user:password@host:5432/dbname',
  )
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url,
  },
  verbose: true,
  strict: false,
})
