-- 003_max_depth_and_events.sql
-- 阶段4 改造：参照 OpenList 的 max_index_depth + 实时事件流

-- A. sources 表增加最大索引深度（对齐 OpenList 默认 20）
ALTER TABLE `sources`
  ADD COLUMN `max_index_depth` int(11) NOT NULL DEFAULT 20 AFTER `root_folder_id`;

-- B. sync_runs 加 max_depth 快照（让历史 run 能回看当时配置）
ALTER TABLE `sync_runs`
  ADD COLUMN `max_index_depth` int(11) NOT NULL DEFAULT 20 AFTER `root_folder_id`;

-- C. 同步运行时事件流（粗粒度：folder_pulled/folder_done/summary/rate_limited/error/paused/completed/run_started）
CREATE TABLE IF NOT EXISTS `sync_run_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `run_id` bigint(20) unsigned NOT NULL,
  `level` enum('debug','info','warn','error','done') NOT NULL DEFAULT 'info',
  `event` varchar(40) NOT NULL,
  `message` varchar(1000) DEFAULT NULL,
  `payload` text DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_sync_run_events_run_id` (`run_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
