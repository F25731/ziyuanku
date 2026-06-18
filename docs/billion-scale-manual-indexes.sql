-- Optional billion-scale helper indexes.
-- Run manually during a maintenance window after the app is healthy.
-- Do not put these in automatic startup migrations for very large tables.

ALTER TABLE `resources`
  ADD KEY `idx_resources_source_ext_id` (`source_id`, `file_ext`, `is_deleted`, `id`);

ALTER TABLE `resources`
  ADD KEY `idx_resources_size_id` (`file_size_bytes`, `id`);
