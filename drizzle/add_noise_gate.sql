-- Микрофонный шумоподавитель (гейт) в настройках комнаты.
-- Включён по умолчанию, поэтому у существующих пользователей он тоже появится
-- включённым.
ALTER TABLE "room_settings"
  ADD COLUMN IF NOT EXISTS "noiseGate" boolean DEFAULT true NOT NULL;
