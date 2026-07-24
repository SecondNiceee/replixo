-- Личные чаты между друзьями (ЛС). Применяется через `pnpm db:push`
-- или вручную: psql "$DATABASE_URL" -f drizzle/add_dm_chat.sql

CREATE TABLE IF NOT EXISTS "dm_conversation" (
  "id" text PRIMARY KEY,
  "type" text NOT NULL DEFAULT 'direct',
  "lastMessageId" text,
  "lastMessageAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

-- Список диалогов сортируется по свежести — снимаем шаг сортировки.
CREATE INDEX IF NOT EXISTS "dm_conversation_lastMessageAt_idx"
  ON "dm_conversation" ("lastMessageAt");

CREATE TABLE IF NOT EXISTS "dm_conversation_member" (
  "conversationId" text NOT NULL REFERENCES "dm_conversation"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "lastReadAt" timestamp NOT NULL DEFAULT now(),
  "unreadCount" integer NOT NULL DEFAULT 0,
  "joinedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "dm_conversation_member_pk" PRIMARY KEY ("conversationId", "userId")
);

CREATE INDEX IF NOT EXISTS "dm_member_userId_idx"
  ON "dm_conversation_member" ("userId");

CREATE TABLE IF NOT EXISTS "dm_message" (
  "id" text PRIMARY KEY,
  "conversationId" text NOT NULL REFERENCES "dm_conversation"("id") ON DELETE CASCADE,
  "senderId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "text" text NOT NULL DEFAULT '',
  "attachment" jsonb,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "editedAt" timestamp,
  "deletedAt" timestamp
);

CREATE INDEX IF NOT EXISTS "dm_message_conv_createdAt_idx"
  ON "dm_message" ("conversationId", "createdAt");
