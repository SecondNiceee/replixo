CREATE TABLE IF NOT EXISTS "call_feedback" (
  "id" bigserial PRIMARY KEY,
  "roomId" text NOT NULL,
  "userId" text REFERENCES "user"("id") ON DELETE SET NULL,
  "userName" text,
  "rating" integer NOT NULL,
  "comment" text,
  "durationSec" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "call_feedback_createdAt_idx" ON "call_feedback" ("createdAt");
