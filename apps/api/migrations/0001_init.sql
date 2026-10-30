-- Nagare initial schema. Timestamps are unix epoch milliseconds.

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('app', 'agent')),
  scopes TEXT NOT NULL,              -- space separated: read write subscribe notify
  hash TEXT NOT NULL UNIQUE,         -- sha256 hex of the bearer token
  max_feeds INTEGER,                 -- agent only: cap on feeds it may add
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE credentials (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('basic', 'header', 'cookie')),
  secret_encrypted TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE feeds (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'rss' CHECK (kind IN ('rss', 'web', 'agent')),
  url TEXT NOT NULL UNIQUE,          -- feed URL, page URL (web) or source URL (agent)
  title TEXT NOT NULL DEFAULT '',
  site_url TEXT,
  selector TEXT,                     -- web feeds: CSS selector for items
  credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
  notify INTEGER NOT NULL DEFAULT 0,
  auto_translate INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at INTEGER,
  next_fetch_at INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX feeds_next_fetch ON feeds (kind, next_fetch_at);

CREATE TABLE subscriptions (
  feed_id INTEGER PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  added_by INTEGER REFERENCES tokens(id) ON DELETE SET NULL,
  reason TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  author TEXT,
  content TEXT,
  full_content TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (feed_id, guid)
);
CREATE INDEX entries_published ON entries (published_at DESC);
CREATE INDEX entries_feed_published ON entries (feed_id, published_at DESC);
CREATE INDEX entries_created ON entries (created_at);

-- Trigram tokenizer so Japanese text is searchable.
CREATE VIRTUAL TABLE entries_fts USING fts5 (
  title, content, content = 'entries', content_rowid = 'id', tokenize = 'trigram'
);
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER entries_au AFTER UPDATE OF title, content ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO entries_fts (rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE entry_states (
  entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  read INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX entry_states_updated ON entry_states (updated_at);

CREATE TABLE translations (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  title TEXT,
  content TEXT,
  engine TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, lang)
);

CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY,
  to_agent INTEGER REFERENCES tokens(id) ON DELETE CASCADE,  -- NULL = any agent
  entry_ids TEXT NOT NULL,           -- JSON array of entry ids
  note TEXT,
  created_at INTEGER NOT NULL,
  picked_up_at INTEGER
);

CREATE TABLE push_targets (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('apns', 'fcm', 'webpush')),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
