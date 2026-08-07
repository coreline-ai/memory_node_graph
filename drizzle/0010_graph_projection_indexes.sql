CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_id);
CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_id);
CREATE INDEX IF NOT EXISTS relations_document_idx ON relations(document_id);
CREATE INDEX IF NOT EXISTS entity_mentions_document_idx ON entity_mentions(document_id);
