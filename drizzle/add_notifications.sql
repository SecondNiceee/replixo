-- Постоянные уведомления (центр уведомлений + бейдж).
--
-- Раньше события дружбы жили только в тосте: получатель, который был офлайн
-- или перезагрузил страницу, про принятие/отклонение заявки не узнавал.
-- Запись создаёт Next-роут одновременно с изменением дружбы, сокет-сервер
-- только пушит уже сохранённое.
--
-- Выполнять можно повторно: всё под IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "notification" (
  "id"        text PRIMARY KEY,
  "userId"    text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "kind"      text NOT NULL,
  "actorId"   text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "readAt"    timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

-- Центр уведомлений всегда читает «мои, свежие сверху».
CREATE INDEX IF NOT EXISTS "notification_user_createdAt_idx"
  ON "notification" ("userId", "createdAt");

-- Одно живое уведомление на (получатель, актор, вид): повторная заявка от
-- того же человека обновляет запись через ON CONFLICT, а не копит стопку.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_user_actor_kind_uq"
  ON "notification" ("userId", "actorId", "kind");
