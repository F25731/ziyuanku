const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const HttpError = require('../utils/httpError');

function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'please_change_this_to_a_long_random_string') {
    console.warn('[WARN] JWT_SECRET not set or default — change it in .env');
  }
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    secret || 'dev-secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET || 'dev-secret';
  return jwt.verify(token, secret);
}

async function getUserById(id) {
  const [rows] = await pool.query(
    'SELECT id, username, role, status, last_login_at, created_at FROM users WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const [rows] = await pool.query(
    'SELECT * FROM users WHERE username = ? LIMIT 1',
    [username]
  );
  return rows[0] || null;
}

async function login(username, password) {
  const user = await getUserByUsername(String(username || '').trim());
  if (!user || user.status !== 1) {
    throw new HttpError(401, '用户名或密码错误');
  }
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw new HttpError(401, '用户名或密码错误');

  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  const token = signToken(user);
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role
    }
  };
}

async function changePassword(userId, oldPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    throw new HttpError(400, '新密码至少 6 位');
  }
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  const user = rows[0];
  if (!user) throw new HttpError(404, '用户不存在');
  const ok = await bcrypt.compare(String(oldPassword || ''), user.password_hash);
  if (!ok) throw new HttpError(400, '原密码错误');
  const hash = await bcrypt.hash(String(newPassword), 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
}

async function ensureAdminUser() {
  const username = String(process.env.ADMIN_INIT_USERNAME || 'admin').trim();
  const password = String(process.env.ADMIN_INIT_PASSWORD || 'Admin@123456');
  const [rows] = await pool.query(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  );
  if (rows.length > 0) return;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')",
    [username, hash]
  );
  console.log(`[OK] Initial admin created: ${username}`);
}

module.exports = {
  signToken,
  verifyToken,
  getUserById,
  getUserByUsername,
  login,
  changePassword,
  ensureAdminUser
};
