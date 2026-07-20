PRAGMA foreign_keys = ON;

CREATE TABLE municipalities (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
CREATE TABLE polling_stations (
  municipality_code TEXT NOT NULL,
  section_number INTEGER NOT NULL,
  polling_place TEXT,
  address TEXT NOT NULL,
  electors INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY (municipality_code, section_number),
  FOREIGN KEY (municipality_code) REFERENCES municipalities(code)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  access_code_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE assignments (
  user_id TEXT NOT NULL,
  municipality_code TEXT NOT NULL,
  section_number INTEGER NOT NULL,
  PRIMARY KEY (user_id, municipality_code, section_number),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (municipality_code, section_number) REFERENCES polling_stations(municipality_code, section_number)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('turnout','scrutiny')),
  user_id TEXT NOT NULL,
  municipality_code TEXT NOT NULL,
  section_number INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  correction_of TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  app_version TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (municipality_code, section_number) REFERENCES polling_stations(municipality_code, section_number),
  FOREIGN KEY (correction_of) REFERENCES submissions(id)
);
CREATE INDEX idx_submissions_station_time ON submissions(municipality_code, section_number, received_at);
CREATE INDEX idx_assignments_station ON assignments(municipality_code, section_number);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  municipality_code TEXT,
  section_number INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE message_receipts (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id),
  FOREIGN KEY(message_id) REFERENCES messages(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
