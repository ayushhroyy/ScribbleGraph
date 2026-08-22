PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing'
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  markdown TEXT,
  avg_confidence REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  label TEXT NOT NULL,
  bbox TEXT,
  r2_key TEXT,
  caption TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  idx INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_id);

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  subject TEXT,
  color TEXT
);

CREATE TABLE IF NOT EXISTS concept_links (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  chunk_id TEXT NOT NULL REFERENCES chunks(id),
  PRIMARY KEY (concept_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS backlinks (
  id TEXT PRIMARY KEY,
  chunk_a TEXT NOT NULL REFERENCES chunks(id),
  chunk_b TEXT NOT NULL REFERENCES chunks(id),
  score REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  questions_json TEXT NOT NULL,
  score INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  leitner_box INTEGER NOT NULL DEFAULT 1,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- local-dev fallback when Vectorize binding is unavailable
CREATE TABLE IF NOT EXISTS vectors (
  chunk_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  vec_json TEXT NOT NULL
);
