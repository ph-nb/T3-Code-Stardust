CREATE TABLE IF NOT EXISTS local_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_documents(
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  ordinal INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL CHECK(json_valid(body)),
  PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS local_documents_parent ON local_documents(kind,parent_id,ordinal,id);
CREATE TABLE IF NOT EXISTS local_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE IF NOT EXISTS local_receipts(command_id TEXT PRIMARY KEY,result TEXT NOT NULL CHECK(json_valid(result)));
