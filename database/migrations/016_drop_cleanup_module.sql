-- Remove the abandoned cleanup/deduplication module.
-- Existing deployments drop the old tables; fresh deployments keep no cleanup schema.

DROP TABLE IF EXISTS `cleanup_dedupe_groups`;
DROP TABLE IF EXISTS `cleanup_dedupe_keys`;
DROP TABLE IF EXISTS `cleanup_candidates`;
DROP TABLE IF EXISTS `cleanup_run_samples`;
DROP TABLE IF EXISTS `cleanup_deleted`;
DROP TABLE IF EXISTS `_cleanup_temp`;
DROP TABLE IF EXISTS `cleanup_settings`;
DROP TABLE IF EXISTS `cleanup_runs`;
DROP TABLE IF EXISTS `cleanup_rules`;
