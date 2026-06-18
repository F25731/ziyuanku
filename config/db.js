const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lanzou_hub',
  waitForConnections: true,
  connectionLimit: Math.max(5, Number(process.env.DB_POOL_LIMIT || 30)),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+08:00',
  dateStrings: true
});

async function testDbConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    console.log('[OK] MySQL connected');
  } finally {
    conn.release();
  }
}

module.exports = { pool, testDbConnection };
