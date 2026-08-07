CREATE VIRTUAL TABLE IF NOT EXISTS `graph_entity_fts` USING fts5(
  `entity_id` UNINDEXED,
  `label`,
  `summary`,
  `tags`,
  tokenize='unicode61'
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `graph_block_fts` USING fts5(
  `block_id` UNINDEXED,
  `text`,
  tokenize='unicode61'
);
--> statement-breakpoint
INSERT INTO `graph_entity_fts` (`entity_id`, `label`, `summary`, `tags`)
SELECT `id`, `label`, `summary`, `tags_json` FROM `entities`;
--> statement-breakpoint
INSERT INTO `graph_block_fts` (`block_id`, `text`)
SELECT `id`, `text` FROM `document_blocks`;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `graph_entity_fts_insert` AFTER INSERT ON `entities` BEGIN
  DELETE FROM `graph_entity_fts` WHERE `entity_id` = NEW.`id`;
  INSERT INTO `graph_entity_fts` (`entity_id`, `label`, `summary`, `tags`)
  VALUES (NEW.`id`, NEW.`label`, NEW.`summary`, NEW.`tags_json`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `graph_entity_fts_update` AFTER UPDATE ON `entities` BEGIN
  DELETE FROM `graph_entity_fts` WHERE `entity_id` = OLD.`id`;
  INSERT INTO `graph_entity_fts` (`entity_id`, `label`, `summary`, `tags`)
  VALUES (NEW.`id`, NEW.`label`, NEW.`summary`, NEW.`tags_json`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `graph_entity_fts_delete` AFTER DELETE ON `entities` BEGIN
  DELETE FROM `graph_entity_fts` WHERE `entity_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `graph_block_fts_insert` AFTER INSERT ON `document_blocks` BEGIN
  DELETE FROM `graph_block_fts` WHERE `block_id` = NEW.`id`;
  INSERT INTO `graph_block_fts` (`block_id`, `text`) VALUES (NEW.`id`, NEW.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `graph_block_fts_update` AFTER UPDATE ON `document_blocks` BEGIN
  DELETE FROM `graph_block_fts` WHERE `block_id` = OLD.`id`;
  INSERT INTO `graph_block_fts` (`block_id`, `text`) VALUES (NEW.`id`, NEW.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `graph_block_fts_delete` AFTER DELETE ON `document_blocks` BEGIN
  DELETE FROM `graph_block_fts` WHERE `block_id` = OLD.`id`;
END;
