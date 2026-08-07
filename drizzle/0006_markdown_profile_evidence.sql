ALTER TABLE document_blocks ADD COLUMN source_url TEXT;
ALTER TABLE entity_mentions ADD COLUMN source_url TEXT;
ALTER TABLE staged_document_blocks ADD COLUMN source_url TEXT;
ALTER TABLE staged_entity_mentions ADD COLUMN source_url TEXT;
