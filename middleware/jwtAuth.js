const { verifyToken, getUserById } = require('../services/userService');

async function jwtRequired(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      return res.status(401).json({ code: 401, message: '未登录' });
    }
    const payload = verifyToken(token);
    const user = await getUserById(payload.sub);
    if (!user || user.status !== 1) {
      return res.status(401).json({ code: 401, message: '用户已失效' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ code: 401, message: 'token 无效或已过期' });
  }
}

function adminRequired(req, res, next) {
  if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ code: 403, message: '仅管理员可访问' });
  }
  return next();
}

module.exports = { jwtRequired, adminRequired };
