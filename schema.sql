-- D1-Datenbank "demxane-status"
-- Anwenden: npx wrangler d1 execute demxane-status --remote --file schema.sql

CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,   -- 'host' (Auslastung Mini) oder 'services' (letzte Prüfung)
  value      TEXT NOT NULL,      -- JSON
  updated_at INTEGER NOT NULL    -- Unix-Millisekunden
);

CREATE TABLE IF NOT EXISTS checks (
  slot    INTEGER NOT NULL,      -- Stunde seit 1970 (Unix-Millisekunden / 3600000)
  service TEXT    NOT NULL,      -- id aus public/services.json
  up      INTEGER NOT NULL,      -- 1 = die ganze Stunde erreichbar, 0 = mindestens eine Prüfung fehlgeschlagen
  PRIMARY KEY (slot, service)
);

CREATE INDEX IF NOT EXISTS checks_slot ON checks (slot);
