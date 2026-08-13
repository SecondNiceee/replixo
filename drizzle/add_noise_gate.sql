-- Микрофонный шумоподавитель (гейт) в настройках комнаты.
-- Включён по умолчанию, поэтому у существующих пользователей он тоже появится
-- включённым.
ALTER TABLE "room_settings"
  ADD COLUMN IF NOT EXISTS "noiseGate" boolean DEFAULT true NOT NULL;

-- Сила гейта (0..100). 50 — базовая настройка: режет клавиатуру и вентилятор,
-- но не трогает обычную речь.
ALTER TABLE "room_settings"
  ADD COLUMN IF NOT EXISTS "noiseGateStrength" integer DEFAULT 50 NOT NULL;
