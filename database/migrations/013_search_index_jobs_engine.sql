-- Track which external search engine produced a scan checkpoint.

ALTER TABLE `search_index_jobs`
  ADD COLUMN `engine` varchar(32) DEFAULT NULL AFTER `mode`;

CREATE INDEX `idx_search_jobs_engine_status`
  ON `search_index_jobs` (`engine`, `status`, `updated_at`);

CREATE INDEX `idx_search_jobs_engine_checkpoint`
  ON `search_index_jobs` (`engine`, `mode`, `source_id`, `last_id`);
