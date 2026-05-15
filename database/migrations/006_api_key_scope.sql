-- 006_api_key_scope.sql
-- 阶段6：API Key 粒度扩展
--   1) max_results: 每次 /search 最多返回多少条（防关键词命中数十万时慢查询/大响应）
--   2) allowed_source_ids: 该 key 可以访问的 source_id 列表（逗号分隔），NULL = 全部
-- 同时把"消耗配额"的语义收窄到只统计 /resources/:id/link：
--   - 给 api_call_logs 加 is_quota 字段（0/1），中间件按路径决定是否计数
--   - api_keys.used_total 仍累计（兼容旧逻辑），但日配额查询改成 SUM(is_quota=1)

ALTER TABLE `api_keys`
  ADD COLUMN `max_results` INT NOT NULL DEFAULT 1000 AFTER `rate_per_min`,
  ADD COLUMN `allowed_source_ids` VARCHAR(500) DEFAULT NULL AFTER `max_results`;

ALTER TABLE `api_call_logs`
  ADD COLUMN `is_quota` TINYINT(1) NOT NULL DEFAULT 0 AFTER `ms`,
  ADD KEY `idx_calls_key_quota_time` (`api_key_id`, `is_quota`, `created_at`);
