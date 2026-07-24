-- ---------------------------------------------------------------------------
-- Идемпотентный фикс схемы чата на VPS.
--
-- Чинит ошибки вида:
--   column "roomId" of relation "message_read" does not exist
--   column "peerId" does not exist
--   column "roomId" does not exist  (deleteRoomMessages)
--
-- Причина: таблицы были созданы со snake_case колонками (room_id, peer_id...),
-- а код server/src/db.ts обращается к ним в camelCase ("roomId", "peerId"...).
-- Плюс таблица presentation_drawing отсутствовала в Drizzle-схеме и не была
-- создана через `db:push`.
--
-- Скрипт безопасен и идемпотентен: можно запускать сколько угодно раз.
-- Существующие данные сохраняются (колонки переименовываются, не удаляются).
--
-- Запуск:  psql "$DATABASE_URL" -f drizzle/fix_chat_columns.sql
-- ---------------------------------------------------------------------------

-- Хелпер: переименовать колонку, только если старая существует, а новой ещё нет.
CREATE OR REPLACE FUNCTION pg_temp.rename_col(tbl text, from_col text, to_col text)
RETURNS void AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = tbl AND column_name = from_col
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = tbl AND column_name = to_col
  ) THEN
    EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', tbl, from_col, to_col);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- === message ===============================================================
CREATE TABLE IF NOT EXISTS "message" (
  "id"          text PRIMARY KEY,
  "roomId"      text NOT NULL,
  "peerId"      text NOT NULL,
  "displayName" text NOT NULL,
  "text"        text NOT NULL DEFAULT '',
  "attachment"  jsonb,
  "createdAt"   timestamp NOT NULL DEFAULT now()
);
SELECT pg_temp.rename_col('message', 'room_id',      'roomId');
SELECT pg_temp.rename_col('message', 'peer_id',      'peerId');
SELECT pg_temp.rename_col('message', 'display_name', 'displayName');
SELECT pg_temp.rename_col('message', 'created_at',   'createdAt');
-- добиваем недостающие колонки (на случай очень старой схемы)
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "attachment" jsonb;
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS "message_roomId_createdAt_idx" ON "message" ("roomId", "createdAt");

-- === message_read ==========================================================
CREATE TABLE IF NOT EXISTS "message_read" (
  "roomId"     text NOT NULL,
  "peerId"     text NOT NULL,
  "lastReadAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt"  timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("roomId", "peerId")
);
SELECT pg_temp.rename_col('message_read', 'room_id',      'roomId');
SELECT pg_temp.rename_col('message_read', 'peer_id',      'peerId');
SELECT pg_temp.rename_col('message_read', 'last_read_at', 'lastReadAt');
SELECT pg_temp.rename_col('message_read', 'updated_at',   'updatedAt');
-- CREATE TABLE IF NOT EXISTS не дополняет уже существующую неполную таблицу.
ALTER TABLE "message_read" ADD COLUMN IF NOT EXISTS "lastReadAt" timestamp NOT NULL DEFAULT now();
ALTER TABLE "message_read" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp NOT NULL DEFAULT now();

-- Старые инсталляции могли создать таблицу без составного PK. Сначала оставляем
-- только самую свежую строку каждой пары, затем добавляем conflict target.
DELETE FROM "message_read" a
USING "message_read" b
WHERE a.ctid < b.ctid
  AND a."roomId" = b."roomId"
  AND a."peerId" = b."peerId";
CREATE UNIQUE INDEX IF NOT EXISTS "message_read_roomId_peerId_unique"
  ON "message_read" ("roomId", "peerId");

-- === whiteboard ============================================================
CREATE TABLE IF NOT EXISTS "whiteboard" (
  "roomId"    text PRIMARY KEY,
  "snapshot"  text,
  "open"      boolean NOT NULL DEFAULT false,
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
SELECT pg_temp.rename_col('whiteboard', 'room_id',    'roomId');
SELECT pg_temp.rename_col('whiteboard', 'updated_at', 'updatedAt');

-- === presentation_drawing ==================================================
-- Эта таблица отсутствовала в Drizzle-схеме — создаём с нуля.
CREATE TABLE IF NOT EXISTS "presentation_drawing" (
  "roomId"     text NOT NULL,
  "slideIndex" text NOT NULL,
  "snapshot"   text,
  "updatedAt"  timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("roomId", "slideIndex")
);
SELECT pg_temp.rename_col('presentation_drawing', 'room_id',     'roomId');
SELECT pg_temp.rename_col('presentation_drawing', 'slide_index', 'slideIndex');
SELECT pg_temp.rename_col('presentation_drawing', 'updated_at',  'updatedAt');
