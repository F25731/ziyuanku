-- 008_cleanup_v2.sql
-- 清理模块 V2：
--  1) cleanup_runs.error_message 改 MEDIUMTEXT（旧版用它塞 samples JSON 时撑爆 VARCHAR 500）
--  2) cleanup_runs 加 confirm_over / paused_at 两个字段
--  3) 新表 cleanup_run_samples：样例独立存（最多 50 行/run，含 winner 信息）
--  4) 新表 cleanup_settings：单行 KV，存 safe_ratio 等全局设置（默认 0.3 = 30%）
--  5) _cleanup_temp 不再使用，但表暂保留（避免 migration 倒着改）；
--     DROP 由运维手工执行：DROP TABLE _cleanup_temp;

ALTER TABLE `cleanup_runs`
  MODIFY COLUMN `error_message` MEDIUMTEXT,
  ADD COLUMN `confirm_over` TINYINT(1) NOT NULL DEFAULT 0 AFTER `dry_run`,
  ADD COLUMN `paused_at` TIMESTAMP NULL DEFAULT NULL AFTER `started_at`;

CREATE TABLE IF NOT EXISTS `cleanup_run_samples` (
  `run_id` INT NOT NULL,
  `idx` INT NOT NULL,
  `reason` VARCHAR(20) NOT NULL,
  `resource_id` INT NOT NULL,
  `source_id` INT NOT NULL,
  `file_name` VARCHAR(500) NOT NULL,
  `group_key` VARCHAR(255) DEFAULT NULL,
  `score` INT NOT NULL DEFAULT 0,
  `ext` VARCHAR(20) DEFAULT NULL,
  `winner_id` INT DEFAULT NULL,
  `winner_file_name` VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (`run_id`, `idx`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cleanup_settings` (
  `id` INT NOT NULL DEFAULT 1,
  `safe_ratio` DECIMAL(4,3) NOT NULL DEFAULT 0.300,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `cleanup_settings` (`id`, `safe_ratio`) VALUES (1, 0.300)
ON DUPLICATE KEY UPDATE `id`=`id`;
