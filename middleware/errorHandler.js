module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[ERR]', req.method, req.originalUrl, err);
  }
  res.status(status).json({
    code: status,
    message: err.message || 'Internal Server Error',
    ...(err.extra ? { detail: err.extra } : {})
  });
};
