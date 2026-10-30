-- Push notification targets get what each service needs, plus failure tracking.
ALTER TABLE push_targets ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE push_targets ADD COLUMN keys TEXT;                        -- webpush: {"p256dh","auth"}
ALTER TABLE push_targets ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0; -- apns: development builds
ALTER TABLE push_targets ADD COLUMN last_error TEXT;
ALTER TABLE push_targets ADD COLUMN last_sent_at INTEGER;

-- Every notification sent, from new entries or from an agent's notify call.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  source INTEGER REFERENCES tokens(id) ON DELETE SET NULL,  -- agent that sent it; NULL = new entries
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_source ON notifications (source, created_at);
