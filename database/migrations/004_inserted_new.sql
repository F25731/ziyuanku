-- 004_inserted_new.sql
-- 阶段5：增量扫盘可以区分 "真正新增" vs "已存在(只是 upsert 刷新了一遍)"
-- sync_runs 加 inserted_new 字段（每次 INSERT...ON DUPLICATE KEY 用 affectedRows 反推）

ALTER TABLE `sync_runs`
  ADD COLUMN `inserted_new` int(11) NOT NULL DEFAULT 0 AFTER `total_files`;
