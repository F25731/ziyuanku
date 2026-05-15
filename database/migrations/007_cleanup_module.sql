-- 007_cleanup_module.sql
-- 阶段7：可插拔的清理/去重模块
--   cleanup_rules    : 用户定义的清理规则（DSL JSON）
--   cleanup_runs     : 每次执行清理的快照
--   cleanup_deleted  : 这次清理"软删除"了哪些资源（用于撤销）
--   _cleanup_temp    : 跑大批量去重时的临时分组表（不 DROP，复用，按 run_id 隔离）

CREATE TABLE IF NOT EXISTS `cleanup_rules` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(80) NOT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `config` JSON NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_cleanup_rule_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cleanup_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `rule_id` INT DEFAULT NULL,
  `rule_name_snapshot` VARCHAR(80) NOT NULL,
  `config_snapshot` JSON NOT NULL,
  `scope_source_ids` VARCHAR(500) DEFAULT NULL,   -- 逗号分隔；空 = 全部库
  `cross_source` TINYINT(1) NOT NULL DEFAULT 0,
  `dry_run` TINYINT(1) NOT NULL DEFAULT 1,
  `status` ENUM('running','completed','failed','undone') NOT NULL DEFAULT 'running',
  `total_examined` INT NOT NULL DEFAULT 0,
  `removed_by_format` INT NOT NULL DEFAULT 0,
  `removed_by_dedupe` INT NOT NULL DEFAULT 0,
  `error_message` VARCHAR(500) DEFAULT NULL,
  `started_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_cleanup_runs_rule` (`rule_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 关联表：哪些资源被这次 run 软删除掉了 → 用于撤销
CREATE TABLE IF NOT EXISTS `cleanup_deleted` (
  `run_id` INT NOT NULL,
  `resource_id` INT NOT NULL,
  `reason` VARCHAR(20) NOT NULL,         -- 'format' | 'dedupe'
  PRIMARY KEY (`run_id`, `resource_id`),
  KEY `idx_cleanup_deleted_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 跑去重时的中间结果（group_key + score），不 DROP，复用
CREATE TABLE IF NOT EXISTS `_cleanup_temp` (
  `run_id` INT NOT NULL,
  `resource_id` INT NOT NULL,
  `group_key` VARCHAR(255) NOT NULL,
  `score` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`run_id`, `resource_id`),
  KEY `idx_cleanup_temp_group` (`run_id`, `group_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 内置一条"小说去重"模板（可被用户编辑/删除）
INSERT INTO `cleanup_rules` (`name`, `description`, `config`, `enabled`) VALUES
('小说去重（示例）', '按作者+标题分组，留精校/全本/版本最优的一份',
 JSON_OBJECT(
   'qualifier', JSON_OBJECT('name_must_match', '(?:作者|著)\\\\s*[:：]?|[《》]|(完结|全集|全本|精校版?|校对版|番外|典藏版|修订版|未删减版)'),
   'key_extractor', JSON_OBJECT(
     'lowercase', true, 'strip_ext', true, 'strip_brackets', true, 'strip_author', true,
     'strip_keywords', JSON_ARRAY('完结','全集','全本','精校版?','校对版','番外','插图版','文字版','典藏版','未删减版','修订版','精排版','epub','txt','pdf','mobi','azw3'),
     'strip_separators', true, 'include_author_in_key', true
   ),
   'score_rules', JSON_ARRAY(
     JSON_OBJECT('pattern', '精校版?|校对版', 'score', 50),
     JSON_OBJECT('pattern', '全本|全集|完结', 'score', 40),
     JSON_OBJECT('pattern', '典藏版|修订版|未删减版', 'score', 30),
     JSON_OBJECT('pattern', '插图版|文字版', 'score', 10),
     JSON_OBJECT('pattern', '番外', 'score', -20)
   ),
   'format_score', JSON_OBJECT('txt', 3, 'epub', 2, 'azw3', 1, 'mobi', 1, 'pdf', 0),
   'tie_breaker', 'id_desc',
   'format_filter', JSON_OBJECT('mode', 'off', 'extensions', JSON_ARRAY())
 ), 0)
ON DUPLICATE KEY UPDATE `id`=`id`;
