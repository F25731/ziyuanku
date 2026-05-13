const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/db');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      name varchar(255) NOT NULL,
      checksum varchar(40) NOT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_schema_migrations_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function splitStatements(sql) {
  // 先逐行剥掉行注释（-- 开头）和空行，再按分号拆分
  const cleaned = sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  return cleaned
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigrations() {
  await ensureMigrationsTable();
  const dir = path.join(__dirname, '..', 'database', 'migrations');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const full = path.join(dir, file);
    const sql = fs.readFileSync(full, 'utf8');
    const checksum = crypto.createHash('sha1').update(sql).digest('hex');
    const [rows] = await pool.query(
      'SELECT id, checksum FROM schema_migrations WHERE name = ? LIMIT 1',
      [file]
    );
    if (rows.length > 0) {
      if (rows[0].checksum !== checksum) {
        console.warn(`[MIGRATE] checksum changed for ${file} (ignored)`);
      }
      continue;
    }
    console.log(`[MIGRATE] applying ${file}`);
    const stmts = splitStatements(sql);
    for (const stmt of stmts) {
      await pool.query(stmt);
    }
    await pool.query(
      'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
      [file, checksum]
    );
    console.log(`[MIGRATE] applied  ${file}`);
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[MIGRATE] done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[MIGRATE] failed', err);
      process.exit(1);
    });
}

module.exports = { runMigrations };
