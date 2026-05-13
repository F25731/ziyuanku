// 把蓝奏返回的 file_size 格式化成带单位的字符串
// ilanzou：纯数字（KB），如 "4260" → "4.16 MB"
// 老版蓝奏：已带单位，如 "12.3 M" → "12.3 MB"

function formatFileSize(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';

  // 已带单位的：规范化为 数字 + 空格 + 单位（KB/MB/GB/TB）
  const m = s.match(/^([\d.]+)\s*([a-zA-Z]+)/);
  if (m) {
    const num = m[1];
    let unit = m[2].toUpperCase();
    // K/M/G/T 补成 KB/MB/GB/TB
    if (/^[KMGT]$/.test(unit)) unit += 'B';
    return `${num} ${unit}`;
  }

  // 纯数字按 KB 处理
  const kb = Number(s);
  if (!isFinite(kb) || kb < 0) return s;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(digits)} ${units[i]}`;
}

module.exports = { formatFileSize };
