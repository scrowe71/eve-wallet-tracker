-- EVE Wallet Tracker schema (same tables and indexes as the original SQLite database).

CREATE TABLE users (
  id INTEGER NOT NULL,
  eve_character_id INTEGER NOT NULL,
  eve_character_name VARCHAR(128) NOT NULL,
  owner_hash VARCHAR(255),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE app_settings (
  "key" VARCHAR(100) NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY ("key")
);

CREATE TABLE characters (
  id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  character_name VARCHAR(128) NOT NULL,
  owner_hash VARCHAR(255),
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at DATETIME,
  last_wallet_sync_at DATETIME,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE TABLE sessions (
  id INTEGER NOT NULL,
  activity_type VARCHAR(50) NOT NULL,
  session_type VARCHAR(50) NOT NULL,
  source_character_id INTEGER,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  fleet_size INTEGER NOT NULL,
  apply_fleet_multiplier BOOLEAN NOT NULL,
  wallet_income FLOAT NOT NULL,
  loot_value FLOAT NOT NULL,
  total_value FLOAT NOT NULL,
  notes TEXT,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(source_character_id) REFERENCES characters (character_id)
);

CREATE TABLE wallet_entries (
  id INTEGER NOT NULL,
  esi_journal_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  entry_date DATETIME NOT NULL,
  ref_type VARCHAR(100) NOT NULL,
  description TEXT,
  amount FLOAT NOT NULL,
  balance FLOAT,
  activity_type VARCHAR(50),
  session_id INTEGER,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY(character_id) REFERENCES characters (character_id),
  FOREIGN KEY(session_id) REFERENCES sessions (id)
);

CREATE TABLE loot_entries (
  id INTEGER NOT NULL PRIMARY KEY,
  session_id INTEGER,
  character_id INTEGER,
  loot_date DATETIME,
  activity_type VARCHAR(50),
  item_name VARCHAR(255) NOT NULL,
  type_id INTEGER,
  quantity INTEGER NOT NULL,
  price_source VARCHAR(50) NOT NULL,
  jita_price FLOAT NOT NULL,
  valuation_percentage FLOAT NOT NULL,
  calculated_value FLOAT NOT NULL,
  created_at DATETIME NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions (id),
  FOREIGN KEY(character_id) REFERENCES characters (character_id)
);

CREATE UNIQUE INDEX ix_characters_character_id ON characters (character_id);
CREATE INDEX ix_characters_character_name ON characters (character_name);
CREATE INDEX ix_characters_user_id ON characters (user_id);
CREATE INDEX ix_loot_entries_activity_type ON loot_entries (activity_type);
CREATE INDEX ix_loot_entries_character_id ON loot_entries (character_id);
CREATE INDEX ix_loot_entries_loot_date ON loot_entries (loot_date);
CREATE INDEX ix_loot_entries_session_id ON loot_entries (session_id);
CREATE INDEX ix_sessions_activity_type ON sessions (activity_type);
CREATE INDEX ix_sessions_end_time ON sessions (end_time);
CREATE INDEX ix_sessions_source_character_id ON sessions (source_character_id);
CREATE INDEX ix_sessions_start_time ON sessions (start_time);
CREATE UNIQUE INDEX ix_users_eve_character_id ON users (eve_character_id);
CREATE INDEX ix_users_eve_character_name ON users (eve_character_name);
CREATE INDEX ix_wallet_entries_activity_type ON wallet_entries (activity_type);
CREATE INDEX ix_wallet_entries_character_id ON wallet_entries (character_id);
CREATE INDEX ix_wallet_entries_entry_date ON wallet_entries (entry_date);
CREATE UNIQUE INDEX ix_wallet_entries_esi_journal_id ON wallet_entries (esi_journal_id);
CREATE INDEX ix_wallet_entries_ref_type ON wallet_entries (ref_type);
CREATE INDEX ix_wallet_entries_session_id ON wallet_entries (session_id);
