-- Three-stage cleanup pipeline:
-- 1) generate candidates
-- 2) review candidate statistics and samples
-- 3) apply candidates in batches, with undo support

ALTER TABLE `cleanup_runs`
  MODIFY COLUMN `status` ENUM('running','review_ready','applying','completed','failed','paused','undone') NOT NULL DEFAULT 'running',
  MODIFY COLUMN `total_examined` bigint(20) unsigned NOT NULL DEFAULT 0,
  MODIFY COLUMN `removed_by_format` bigint(20) unsigned NOT NULL DEFAULT 0,
  MODIFY COLUMN `removed_by_dedupe` bigint(20) unsigned NOT NULL DEFAULT 0,
  ADD COLUMN `candidate_total` bigint(20) unsigned NOT NULL DEFAULT 0 AFTER `total_examined`,
  ADD COLUMN `applied_total` bigint(20) unsigned NOT NULL DEFAULT 0 AFTER `candidate_total`,
  ADD COLUMN `last_scanned_id` bigint(20) unsigned NOT NULL DEFAULT 0 AFTER `applied_total`;

ALTER TABLE `cleanup_deleted`
  MODIFY COLUMN `resource_id` bigint(20) unsigned NOT NULL;

ALTER TABLE `cleanup_run_samples`
  MODIFY COLUMN `resource_id` bigint(20) unsigned NOT NULL,
  MODIFY COLUMN `winner_id` bigint(20) unsigned DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `cleanup_candidates` (
  `run_id` int NOT NULL,
  `resource_id` bigint(20) unsigned NOT NULL,
  `reason` varchar(20) NOT NULL,
  `source_id` bigint(20) unsigned NOT NULL,
  `file_name` varchar(500) NOT NULL,
  `group_key` varchar(255) DEFAULT NULL,
  `score` int NOT NULL DEFAULT 0,
  `ext` varchar(20) DEFAULT NULL,
  `size_bytes` bigint(20) unsigned DEFAULT NULL,
  `winner_id` bigint(20) unsigned DEFAULT NULL,
  `winner_file_name` varchar(500) DEFAULT NULL,
  `status` enum('candidate','applied','excluded') NOT NULL DEFAULT 'candidate',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `applied_at` datetime DEFAULT NULL,
  PRIMARY KEY (`run_id`, `resource_id`),
  KEY `idx_cleanup_candidates_status` (`run_id`, `status`, `resource_id`),
  KEY `idx_cleanup_candidates_reason` (`run_id`, `reason`),
  KEY `idx_cleanup_candidates_source` (`run_id`, `source_id`),
  KEY `idx_cleanup_candidates_group` (`run_id`, `group_key`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cleanup_dedupe_keys` (
  `run_id` int NOT NULL,
  `resource_id` bigint(20) unsigned NOT NULL,
  `source_id` bigint(20) unsigned NOT NULL,
  `group_key` varchar(255) NOT NULL,
  `score` int NOT NULL DEFAULT 0,
  `file_name` varchar(500) NOT NULL,
  `ext` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`run_id`, `resource_id`),
  KEY `idx_cleanup_dedupe_group` (`run_id`, `group_key`(191), `score`, `resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
