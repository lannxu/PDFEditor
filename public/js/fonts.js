// 字体清单：屏幕显示（@font-face）与导出（pdf-lib 嵌入）共用
import { hasCJK } from './util.js';

let manifest = null;
const fontBytesCache = new Map(); // file -> ArrayBuffer

export async function initFonts() {
  // 注入 @font-face（含细体等字重变体），保证显示与导出使用同一份字体文件
  const m = await getManifest();
  const css = m.families.map((f) => {
    if (!f.file) return '';
    let s = `@font-face { font-family: 'PF-${f.id}'; src: url('../assets/fonts/${f.file}') format('truetype'); font-display: swap; }`;
    const light = m.variants?.[f.id]?.light;
    if (light) {
      s += `\n@font-face { font-family: 'PF-${f.id}'; src: url('../assets/fonts/${light}') format('truetype'); font-weight: 300; font-display: swap; }`;
    }
    return s;
  }).join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

export async function getManifest() {
  if (manifest) return manifest;
  try {
    const r = await fetch('../assets/fonts/fonts.json');
    manifest = await r.json();
  } catch {
    manifest = { families: [], variants: {} };
  }
  return manifest;
}

export function getFamily(id) {
  return manifest.families.find((f) => f.id === id) || manifest.families[0];
}
export function families() {
  return manifest ? manifest.families : [];
}

async function loadFontFile(file) {
  if (!fontBytesCache.has(file)) {
    const r = await fetch(`../assets/fonts/${file}`);
    if (!r.ok) throw new Error('font 404: ' + file);
    fontBytesCache.set(file, await r.arrayBuffer());
  }
  return fontBytesCache.get(file);
}

// 根据文本内容与字体能力选择家族：西文字体遇中文自动回退黑体
export function resolveFamily(fontId, text) {
  const fam = getFamily(fontId);
  if (fam && hasCJK(text) && !fam.cjk) {
    return getFamily('simhei') || fam;
  }
  return fam;
}

// ---- 智能选字：按字形覆盖挑选字体族 ----
const coverageCache = new Map(); // fontId -> { ok, fontObj }
async function familyCoverage(fontId) {
  if (coverageCache.has(fontId)) return coverageCache.get(fontId);
  let rec = { ok: false, fontObj: null };
  const fam = getFamily(fontId);
  if (fam && fam.file) {
    try {
      const bytes = await loadFontFile(fam.file);
      rec = { ok: true, fontObj: window.fontkit.create(new Uint8Array(bytes)) };
    } catch { rec = { ok: false, fontObj: null }; }
  }
  coverageCache.set(fontId, rec);
  return rec;
}
async function familyCovers(fontId, text) {
  const fam = getFamily(fontId);
  if (!fam || !fam.file) return true; // 标准字体走导出分段兜底
  const rec = await familyCoverage(fontId);
  if (!rec.ok || !rec.fontObj) return true;
  for (const ch of text || '') {
    const cp = ch.codePointAt(0);
    if (cp <= 0x20 || cp === 0xa0) continue;
    try { if (!rec.fontObj.hasGlyphForCodePoint(cp)) return false; } catch { return false; }
  }
  return true;
}
// 优先原家族；缺字形时在常用全量覆盖族中挑选（宋体 GBK 全覆盖优先）
export async function pickFamilyForText(fontId, text) {
  if (await familyCovers(fontId, text)) return fontId;
  for (const alt of ['simsun', 'msyh', 'simhei']) {
    if (alt !== fontId && (await familyCovers(alt, text))) return alt;
  }
  return fontId;
}
// 预热某族的覆盖缓存（之后 charCovered 可同步查询）
export async function ensureFamilyCoverage(fontId) {
  await familyCoverage(fontId);
}
// 单字符覆盖查询（同步；未缓存视作覆盖）
export function charCovered(fontId, ch) {
  const rec = coverageCache.get(fontId);
  if (!rec || !rec.ok || !rec.fontObj) return true;
  const cp = ch.codePointAt(0);
  if (cp <= 0x20 || cp === 0xa0) return true;
  try { return rec.fontObj.hasGlyphForCodePoint(cp); } catch { return true; }
}

// 导出用：取得可嵌入的字体（CustomFont 或 StandardFont）
// 按字重与斜体挑选变体文件：粗斜 → 粗 → 斜 → 细(≤350) → 常规
// pdfDoc 已 registerFontkit；返回 null 表示无可用字体文件（用 StandardFonts 兜底）
export async function loadEmbedFont(pdfDoc, fontId, { weight = 400, italic = false, bold } = {}) {
  const m = await getManifest();
  const fam = getFamily(fontId);
  if (!fam) return null;
  const boldFlag = bold !== undefined ? !!bold : weight >= 600;
  let file = fam.file;
  const v = m.variants[fam.id];
  if (v) {
    if (boldFlag && italic) file = v.bolditalic || v.bold || file;
    else if (boldFlag) file = v.bold || file;
    else if (italic) file = v.italic || file;
    else if (weight <= 350) file = v.light || file;
  }
  if (!file) return null; // helv 等标准字体
  try {
    const bytes = await loadFontFile(file);
    return await pdfDoc.embedFont(bytes, { subset: true });
  } catch (e) {
    console.warn('嵌入字体失败，回退黑体', file, e);
    if (fam.id !== 'simhei') {
      try { return await pdfDoc.embedFont(await loadFontFile('simhei.ttf'), { subset: true }); } catch { /* 忽略 */ }
    }
    return null;
  }
}

export function standardFont({ bold = false, italic = false } = {}) {
  const { StandardFonts } = window.PDFLib;
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

// 字体的 ascent 比例（用于显示/导出的基线一致）
const ascentCache = new Map();
export async function familyAscent(fontId) {
  if (ascentCache.has(fontId)) return ascentCache.get(fontId);
  let v = 0.78;
  try {
    const fam = getFamily(fontId);
    if (fam && fam.file) {
      const bytes = await loadFontFile(fam.file);
      const fk = window.fontkit.create(new Uint8Array(bytes));
      if (fk && fk.unitsPerEm && isFinite(fk.ascent)) v = fk.ascent / fk.unitsPerEm;
    }
  } catch { /* 保持默认 */ }
  ascentCache.set(fontId, v);
  return v;
}
