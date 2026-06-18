-- Hourly API call rollups for large installations.

CREATE TABLE IF NOT EXISTS `api_call_hourly_stats` (
  `hour_at` datetime NOT NULL,
  `api_key_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_calls` bigint(20) unsigned NOT NULL DEFAULT 0,
  `quota_calls` bigint(20) unsigned NOT NULL DEFAULT 0,
  `ok_calls` bigint(20) unsigned NOT NULL DEFAULT 0,
  `error_calls` bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_ms` bigint(20) unsigned NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`hour_at`, `api_key_id`),
  KEY `idx_api_call_hourly_key_hour` (`api_key_id`, `hour_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
