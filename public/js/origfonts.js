// 原始文档内嵌字体提取：直接解析 PDF 的 FontFile2/FontFile3 字体流，
// 显示（@font-face）与导出（pdf-lib 嵌入）复用同一份字体程序，
// 使编辑后的文字与原文在字形、字宽上完全一致。
// 以字体的基础名（如 "KaiTi"，去掉子集前缀与 pdf.js 的数字后缀）为键，跨会话稳定。

const registry = new Map(); // baseName -> { family, bytes, fontObj, ok }
let extractPromise = null;

// 规范化字体基础名：去掉 "ABCDEF+" 子集前缀与 "-123" 后缀
export function fontBaseName(name) {
  return String(name || '')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/-\d+$/, '')
    .trim();
}

// 解析整个文档的内嵌字体流（每个文档只做一次；切换文档时须先 reset）
export function resetDocFonts() {
  extractPromise = null;
}

export function ensureDocFonts(docBytes) {
  if (extractPromise) return extractPromise;
  extractPromise = (async () => {
    const { PDFDocument, PDFName, PDFDict, PDFArray } = window.PDFLib;
    const found = new Map(); // baseName -> Uint8Array
    try {
      const doc = await PDFDocument.load(docBytes, { ignoreEncryption: true, updateMetadata: false });
      for (const page of doc.getPages()) {
        const resources = page.node.Resources();
        if (!(resources instanceof PDFDict)) continue;
        const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
        if (!fonts) continue;
        for (const [, ref] of fonts.entries()) {
          try {
            const font = doc.context.lookupMaybe(ref, PDFDict);
            if (!font) continue;
            const baseRaw = font.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.asString?.() || '';
            const base = fontBaseName(baseRaw.replace(/\//g, ''));
            if (!base || found.has(base)) continue;
            const bytes = readFontStream(doc, font) || readDescendantFontStream(doc, font);
            if (bytes && bytes.length > 200) found.set(base, bytes);
          } catch { /* 单个字体失败不影响其余 */ }
        }
      }
    } catch (e) {
      console.warn('内嵌字体提取失败', e);
    }
    // 注册为可用 Web 字体
    const jobs = [];
    found.forEach((bytes, base) => jobs.push(registerOrigFont(base, bytes)));
    await Promise.all(jobs);
    return found.size;
  })();
  return extractPromise;
}

// 普通 TrueType：FontDescriptor → FontFile2 / FontFile3
function readFontStream(doc, font) {
  const { PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = window.PDFLib;
  const desc = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  if (!desc) return null;
  for (const key of ['FontFile2', 'FontFile3']) {
    try {
      const stream = desc.lookupMaybe(PDFName.of(key), PDFRawStream);
      if (stream) {
        // 流内容可能带 Flate 等过滤器，必须解码后才是字体程序
        const contents = decodePDFRawStream(stream).decode();
        if (contents && contents.length) return contents;
      }
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

// Type0/组合字体：DescendantFonts[0] → FontDescriptor → FontFile2
function readDescendantFontStream(doc, font) {
  const { PDFName, PDFDict, PDFArray } = window.PDFLib;
  const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  if (!descendants) return null;
  try {
    const child = descendants.lookupMaybe(0, PDFDict);
    if (child) return readFontStream(doc, child);
  } catch { /* 忽略 */ }
  return null;
}

// 规范化 sfnt 魔数：部分子集化工具写入 'true'(0x74727565)，
// 浏览器 FontFace 与 fontkit 仅认 0x00010000 / 'OTTO'，改写后完全等价
function normalizeSfnt(bytes) {
  if (bytes.length > 4 && bytes[0] === 0x74 && bytes[1] === 0x72 && bytes[2] === 0x75 && bytes[3] === 0x65) {
    const out = bytes.slice(0);
    out[0] = 0x00; out[1] = 0x01; out[2] = 0x00; out[3] = 0x00;
    return out;
  }
  return bytes;
}

export async function registerOrigFont(baseName, bytes) {
  if (!baseName || !bytes || !bytes.length) return null;
  if (registry.has(baseName)) return registry.get(baseName);
  bytes = normalizeSfnt(bytes);
  const family = 'PFO' + registry.size + baseName.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  const rec = { family, bytes, fontObj: null, ok: false };
  registry.set(baseName, rec); // 先占位避免并发重复注册
  try {
    const face = new FontFace(family, bytes.slice(0));
    await face.load();
    document.fonts.add(face);
    try {
      rec.fontObj = window.fontkit.create(bytes.slice(0));
    } catch { rec.fontObj = null; }
    rec.ok = true;
  } catch (e) {
    // 无法作为 Web 字体加载（如裸 CFF / Type3），保持 ok=false，调用方回退内置字体
    console.warn('原始字体注册失败:', baseName, e.message);
    rec.ok = false;
  }
  return rec;
}

export function getOrigFont(baseName) {
  return baseName ? registry.get(fontBaseName(baseName)) || null : null;
}

// 文本的全部字符是否都在该字体（子集）中
export function coversAll(baseName, text) {
  const rec = getOrigFont(baseName);
  if (!rec || !rec.ok || !rec.fontObj) return false;
  for (const ch of text || '') {
    const cp = ch.codePointAt(0);
    if (cp <= 0x20 || cp === 0xa0) continue; // 空白无需字形
    try {
      if (!rec.fontObj.hasGlyphForCodePoint(cp)) return false;
    } catch { return false; }
  }
  return true;
}

// 显示字体栈：原始字体优先，内置字体兜底
export function cssStack(baseName, fallbackCss) {
  const rec = getOrigFont(baseName);
  return rec && rec.ok ? `"${rec.family}", ${fallbackCss || 'sans-serif'}` : (fallbackCss || 'sans-serif');
}

export function origFontReady(baseName) {
  const rec = getOrigFont(baseName);
  return !!(rec && rec.ok);
}
