-- Billion-scale write path: resource metadata and async search index outbox.

ALTER TABLE `resources`
  ADD COLUMN `file_size_bytes` bigint(20) unsigned DEFAULT NULL,
  ADD COLUMN `file_ext` varchar(32) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `search_index_outbox` (
  `resource_id` bigint(20) unsigned NOT NULL,
  `op` enum('upsert','delete') NOT NULL DEFAULT 'upsert',
  `attempts` int(11) NOT NULL DEFAULT 0,
  `available_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `locked_at` datetime DEFAULT NULL,
  `last_error` varchar(1000) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`resource_id`),
  KEY `idx_search_outbox_available` (`available_at`, `attempts`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
