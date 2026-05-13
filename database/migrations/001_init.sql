-- 001_init.sql
-- lanzou-resource-hub initial schema
-- 设计原则：无会员/无卡密，JWT + API Key 双通道，支持多来源

CREATE TABLE IF NOT EXISTS `users` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `username` varchar(64) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('admin','operator') NOT NULL DEFAULT 'operator',
  `status` tinyint(1) NOT NULL DEFAULT 1,
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sources` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(100) NOT NULL,
  `provider` varchar(20) NOT NULL DEFAULT 'ilanzou',
  `login_type` enum('account','cookie','public') NOT NULL DEFAULT 'account',
  `root_folder_id` varchar(100) NOT NULL DEFAULT '0',
  `account` varchar(100) DEFAULT NULL,
  `password_text` text,
  `cookie_text` longtext,
  `status` tinyint(1) NOT NULL DEFAULT 1,
  `last_check_at` datetime DEFAULT NULL,
  `last_sync_at` datetime DEFAULT NULL,
  `remark` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sources_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `resources` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `source_id` bigint(20) unsigned NOT NULL,
  `parent_folder_id` varchar(100) DEFAULT NULL,
  `file_id` varchar(100) DEFAULT NULL,
  `file_name` varchar(500) NOT NULL,
  `file_size` varchar(50) DEFAULT NULL,
  `file_type` varchar(50) DEFAULT NULL,
  `file_time` varchar(50) DEFAULT NULL,
  `share_url` varchar(500) DEFAULT NULL,
  `share_pwd` varchar(32) DEFAULT NULL,
  `sync_hash` varchar(64) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_resources_source_file` (`source_id`, `file_id`),
  KEY `idx_resources_deleted` (`is_deleted`),
  KEY `idx_resources_name` (`file_name`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `sync_logs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `source_id` bigint(20) unsigned DEFAULT NULL,
  `status` enum('running','success','failed') NOT NULL DEFAULT 'running',
  `message` text,
  `total` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sync_logs_source` (`source_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `key_prefix` varchar(16) NOT NULL,
  `key_hash` varchar(128) NOT NULL,
  `owner_user_id` bigint(20) unsigned DEFAULT NULL,
  `daily_limit` int(11) NOT NULL DEFAULT 0,
  `total_limit` int(11) NOT NULL DEFAULT 0,
  `rate_per_min` int(11) NOT NULL DEFAULT 60,
  `used_total` bigint(20) unsigned NOT NULL DEFAULT 0,
  `status` tinyint(1) NOT NULL DEFAULT 1,
  `remark` varchar(255) DEFAULT NULL,
  `expire_at` datetime DEFAULT NULL,
  `last_used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `api_call_logs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `api_key_id` bigint(20) unsigned DEFAULT NULL,
  `path` varchar(255) NOT NULL,
  `ip` varchar(64) DEFAULT NULL,
  `status_code` int(11) NOT NULL DEFAULT 0,
  `ms` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_calls_key_time` (`api_key_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
