-- 002_sync_progress.sql
-- 阶段3 G/H：百万级长跑同步——run 元数据 + 目录级 BFS 进度持久化

CREATE TABLE IF NOT EXISTS `sync_runs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `source_id` bigint(20) unsigned NOT NULL,
  `mode` varchar(20) NOT NULL DEFAULT 'incremental',
  `status` enum('running','paused','completed','failed') NOT NULL DEFAULT 'running',
  `root_folder_id` varchar(100) NOT NULL DEFAULT '0',
  `total_calls` int(11) NOT NULL DEFAULT 0,
  `total_files` int(11) NOT NULL DEFAULT 0,
  `last_message` varchar(500) DEFAULT NULL,
  `started_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_resume_at` datetime DEFAULT NULL,
  `paused_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sync_runs_source_status` (`source_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sync_progress` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `run_id` bigint(20) unsigned NOT NULL,
  `folder_id` varchar(100) NOT NULL,
  `next_offset` int(11) NOT NULL DEFAULT 1,
  `total_page` int(11) NOT NULL DEFAULT 0,
  `done` tinyint(1) NOT NULL DEFAULT 0,
  `last_pulled_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sync_progress_run_folder` (`run_id`, `folder_id`),
  KEY `idx_sync_progress_run_done` (`run_id`, `done`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
