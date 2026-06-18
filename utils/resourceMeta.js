function parseFileSizeToBytes(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([a-zA-Z]*)\s*$/);
  if (!m) return null;
  const num = Number.parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  let unit = (m[2] || '').toUpperCase();
  if (/^[KMGT]$/.test(unit)) unit += 'B';
  if (!unit) return Math.round(num * 1024);
  if (unit === 'B') return Math.round(num);
  if (unit === 'KB') return Math.round(num * 1024);
  if (unit === 'MB') return Math.round(num * 1024 * 1024);
  if (unit === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  if (unit === 'TB') return Math.round(num * 1024 * 1024 * 1024 * 1024);
  return null;
}

function getFileExt(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,16})$/);
  return m ? m[1].toLowerCase() : '';
}

module.exports = { parseFileSizeToBytes, getFileExt };
