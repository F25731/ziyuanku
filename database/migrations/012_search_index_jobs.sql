-- Admin-managed external search scan/reindex jobs.

CREATE TABLE IF NOT EXISTS `search_index_jobs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `mode` enum('full','incremental') NOT NULL DEFAULT 'full',
  `status` enum('queued','running','completed','failed','paused') NOT NULL DEFAULT 'queued',
  `source_id` bigint(20) unsigned DEFAULT NULL,
  `batch_size` int(11) NOT NULL DEFAULT 1000,
  `max_attempts` int(11) NOT NULL DEFAULT 5,
  `start_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `last_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_resources` bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_seen` bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_indexed` bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_failed` bigint(20) unsigned NOT NULL DEFAULT 0,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `last_error` varchar(1000) DEFAULT NULL,
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_search_jobs_status` (`status`, `updated_at`),
  KEY `idx_search_jobs_mode` (`mode`, `source_id`, `last_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
