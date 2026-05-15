-- 005_resources_fulltext.sql
-- 阶段5：脱离 Meilisearch，纯 MySQL FULLTEXT 搜索
-- 参照 OpenList database 模式，对 file_name 建 ngram 全文索引（MySQL 5.7+/8.0 自带）
-- ngram_token_size 默认 2，中文双字切词，"资源"两字符就能命中

-- 注意：百万级数据上建 FULLTEXT 索引需要几分钟到十几分钟，期间表会被锁
-- 启动时 runMigrations 会执行；如果担心阻塞可手动在低峰期跑

ALTER TABLE `resources`
  ADD FULLTEXT INDEX `idx_resources_file_name_ft` (`file_name`) WITH PARSER ngram;
