-- Ответы на сообщения в личных чатах и в чате комнаты.
-- Применяется вручную: psql "$DATABASE_URL" -f drizzle/add_message_reply.sql
--
-- "replyTo" — снимок цитаты { id, authorId, author, text, attachmentName },
-- а не внешний ключ: цитата рисуется без дозапроса оригинала, и удаление
-- оригинала её не ломает. null — обычное сообщение.

ALTER TABLE "dm_message" ADD COLUMN IF NOT EXISTS "replyTo" jsonb;
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "replyTo" jsonb;
