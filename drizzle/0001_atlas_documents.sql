CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_blocks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  type TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  short_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  summary TEXT NOT NULL,
  insight TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  block_id TEXT,
  origin TEXT NOT NULL DEFAULT 'rule'
);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  note TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'rule'
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS staged_document_blocks (
  stage_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  type TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE TABLE IF NOT EXISTS staged_entities (
  stage_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  short_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  summary TEXT NOT NULL,
  insight TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE TABLE IF NOT EXISTS staged_entity_mentions (
  stage_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  block_id TEXT,
  origin TEXT NOT NULL DEFAULT 'rule',
  PRIMARY KEY (stage_id, id)
);

CREATE TABLE IF NOT EXISTS staged_relations (
  stage_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL,
  note TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'rule',
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_blocks_document_idx ON document_blocks(document_id);
CREATE INDEX IF NOT EXISTS entity_mentions_document_idx ON entity_mentions(document_id);
CREATE INDEX IF NOT EXISTS entity_mentions_entity_idx ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS relations_document_idx ON relations(document_id);
CREATE INDEX IF NOT EXISTS ingestion_jobs_document_idx ON ingestion_jobs(document_id);
