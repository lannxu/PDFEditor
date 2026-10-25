// 通用工具：几何、颜色、事件辅助

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round1 = (v) => Math.round(v * 10) / 10;

let _uid = 0;
export const uid = () => `e${Date.now().toString(36)}${(_uid++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---- 2x3 矩阵（PDF 风格 [a,b,c,d,e,f]），m × n ----
export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ---- 屏幕坐标系（y 向下）下绕中心旋转 ----
export function rotPt(p, c, deg) {
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

// 四角点（屏幕坐标，y 向下）取 AABB
export function aabbOfQuad(quad) {
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// 元素（含旋转）的四个角，坐标为页面 pt
export function elQuad(el) {
  const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const loc = [
    { x: el.x, y: el.y }, { x: el.x + el.w, y: el.y },
    { x: el.x + el.w, y: el.y + el.h }, { x: el.x, y: el.y + el.h },
  ];
  return loc.map((p) => rotPt(p, c, el.rot || 0));
}

export function elBBox(el) { return aabbOfQuad(elQuad(el)); }

// 两 AABB 相交
export function rectsHit(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
// a 被 b 覆盖的面积比例
export function coverRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-6, a.w * a.h);
}

// ---- 颜色 ----
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.test(hex || '') ? (hex || '').match(/^#?([0-9a-f]{6})$/i) : null;
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
export function rgbToHex(r, g, b) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ---- 文本 ----
export const CJK_RE = /[\u2E80-\u2EFF\u3000-\u303F\u31C0-\u31EF\u3200-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
export const hasCJK = (s) => CJK_RE.test(s || '');

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 采样 FNV 哈希（首尾各 64KB + 长度），大文件不逐字节遍历，避免卡 UI
export function hashBytes(buf) {
  const u8 = new Uint8Array(buf);
  const len = u8.length;
  const span = Math.min(65536, len);
  let h = 0x811c9dc5 ^ len;
  for (let i = 0; i < span; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = Math.max(0, len - span); i < len; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
