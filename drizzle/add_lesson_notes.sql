-- Конспекты уроков: сохраняет преподаватель после редактирования ИИ-черновика.
CREATE TABLE IF NOT EXISTS "lesson_note" (
  "id" text PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "roomId" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "lesson_note_owner_idx" ON "lesson_note" ("ownerId", "updatedAt");

-- Кому преподаватель отправил конспект. Получатель может только читать.
CREATE TABLE IF NOT EXISTS "lesson_note_share" (
  "noteId" text NOT NULL REFERENCES "lesson_note"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "sharedAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("noteId", "userId")
);
CREATE INDEX IF NOT EXISTS "lesson_note_share_user_idx" ON "lesson_note_share" ("userId", "sharedAt");
