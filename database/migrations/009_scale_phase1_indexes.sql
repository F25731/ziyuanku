-- Phase 1 scale indexes: cursor pagination and cached dashboard fallbacks.

ALTER TABLE `resources`
  ADD KEY `idx_resources_deleted_id` (`is_deleted`, `id`),
  ADD KEY `idx_resources_source_deleted_id` (`source_id`, `is_deleted`, `id`);

ALTER TABLE `api_call_logs`
  ADD KEY `idx_calls_created_at` (`created_at`);
