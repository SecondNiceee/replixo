-- Роль пользователя: 'teacher' или 'student'. Выбирается при регистрации.
-- Существующие аккаунты становятся учениками; преподавателя назначить вручную:
--   UPDATE "user" SET "role" = 'teacher' WHERE "email" = 'you@example.com';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'student';
