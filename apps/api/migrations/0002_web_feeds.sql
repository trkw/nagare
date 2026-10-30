-- Credentials get a name to refer to them by and the host they may be sent to,
-- so a feed (or an agent) can never send them anywhere else.
ALTER TABLE credentials ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE credentials ADD COLUMN host TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX credentials_name ON credentials (name);
