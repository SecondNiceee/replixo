CREATE TABLE IF NOT EXISTS "annotation_settings" (
  "userId" text PRIMARY KEY NOT NULL,
  "activation" text DEFAULT 'double-click' NOT NULL,
  "hotkey" text,
  "hintSeen" boolean DEFAULT false NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "annotation_settings_userId_user_id_fk"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE
);
