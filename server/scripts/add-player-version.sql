/* 守卫式加列：Player.version + (id, version) 复合唯一索引（幂等，可重复执行） */
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Player' AND COLUMN_NAME = 'version'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `Player` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 0',
  'SELECT ''column version already exists''');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Player' AND INDEX_NAME = 'Player_id_version_key'
);
SET @ddl := IF(@idx_exists = 0,
  'CREATE UNIQUE INDEX `Player_id_version_key` ON `Player`(`id`, `version`)',
  'SELECT ''index Player_id_version_key already exists''');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
