CREATE TABLE IF NOT EXISTS "call_session" (
  "id" bigserial PRIMARY KEY,
  "roomId" text NOT NULL,
  "startedAt" timestamp NOT NULL,
  "endedAt" timestamp NOT NULL,
  "durationSec" integer NOT NULL,
  "maxParticipants" integer NOT NULL,
  "usedScreenShare" boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "call_session_startedAt_idx" ON "call_session" ("startedAt");
