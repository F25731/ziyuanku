-- Move heavyweight cleanup work out of the web process.
-- queued/apply_queued are claimed by cleanup-worker; running/applying are worker-owned.

ALTER TABLE `cleanup_runs`
  MODIFY COLUMN `status` ENUM('queued','running','review_ready','apply_queued','applying','completed','failed','paused','undone') NOT NULL DEFAULT 'queued',
  ADD COLUMN `worker_id` varchar(128) DEFAULT NULL AFTER `status`,
  ADD COLUMN `worker_heartbeat_at` datetime DEFAULT NULL AFTER `worker_id`;

CREATE TABLE IF NOT EXISTS `cleanup_dedupe_groups` (
  `run_id` int NOT NULL,
  `group_key` varchar(255) NOT NULL,
  `total` int NOT NULL DEFAULT 0,
  `processed` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`run_id`, `group_key`),
  KEY `idx_cleanup_dedupe_groups_pending` (`run_id`, `processed`, `group_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
