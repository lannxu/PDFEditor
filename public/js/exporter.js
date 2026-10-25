// 导出：pdf-lib 将全部编辑写回 PDF（中文字体子集嵌入）
import { state, emit } from './state.js';
import { pdfPageOf, ensureSourceLayer } from './pdfview.js';
import { loadEmbedFont, standardFont, getFamily, familyAscent, getManifest, pickFamilyForText, ensureFamilyCoverage, charCovered } from './fonts.js';
import { hexToRgb01, rotPt, hasCJK, download } from './util.js';
import { toast } from './ui.js';

const { PDFDocument, degrees, rgb } = window.PDFLib;

// ---------- 文本换行（与显示端一致，用 canvas 度量） ----------
import { cssStack as origCssStack, getOrigFont, coversAll } from './origfonts.js';

let measureCtx = null;
function measureCss(el) {
  const fam = getFamily(el.fontId);
  const base = fam?.css || 'sans-serif';
  const stack = el.customFont ? origCssStack(el.customFont, base) : base;
  return `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : '400 '}${el.size}px ${stack}`;
}
function textWidth(s, css) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = css;
  return measureCtx.measureText(s).width;
}
// CJK 逐字可断，西文按词断
function tokenize(line) {
  const out = [];
  const re = /(\s+|[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+)/gu;
  for (const m of line.matchAll(re)) out.push(m[0]);
  return out;
}
export function wrapLines(el) {
  const css = measureCss(el);
  const maxW = el.w;
  const lines = [];
  for (const para of (el.text || '').split('\n')) {
    if (!para) { lines.push(''); continue; }
    let cur = '';
    for (const tk of tokenize(para)) {
      if (tk.trim() === '' && !cur) continue; // 行首空白丢弃
      const test = cur + tk;
      if (textWidth(test, css) <= maxW || !cur) cur = test;
      else { lines.push(cur.replace(/\s+$/, '')); cur = tk.replace(/^\s+/, ''); }
    }
    if (cur) lines.push(cur.replace(/\s+$/, ''));
  }
  return lines.length ? lines : [''];
}

// 标准字体（WinAnsi）无法编码的字符 → 分段，中文段用黑体
function encodeSegments(line, useStandard) {
  if (!useStandard) return [{ text: line, std: false }];
  const segs = [];
  let buf = '', bufCJK = null;
  const flush = () => {
    if (buf) segs.push({ text: buf, std: bufCJK === false });
    buf = '';
  };
  for (const ch of line) {
    const cjk = hasCJK(ch) || ch.charCodeAt(0) > 0xff;
    if (bufCJK === null || cjk === bufCJK) { buf += ch; bufCJK = cjk; }
    else { flush(); buf = ch; bufCJK = cjk; }
  }
  flush();
  return segs;
}

// ---------- 坐标 ----------
// 显示坐标(pt, y 向下) → PDF 用户空间；空白页无 pdf.js 视口，按无旋转直接换算
function toPdf(pk, x, y) {
  const info = pdfPageOf(pk);
  if (info) {
    const [px, py] = info.viewport.convertToPdfPoint(x, y);
    return { x: px, y: py };
  }
  const d = state.display.find((p) => p.pk === pk);
  if (d) return { x, y: d.h - y };
  return null;
}
function rot0(el) { return ((el.rot || 0) % 360 + 360) % 360; }

const rgbOf = (hex) => { const c = hexToRgb01(hex); return rgb(c.r, c.g, c.b); };

// ---------- 主流程 ----------
export async function exportPdf() {
  if (!state.pdfDoc) return;
  if (state.encrypted) {
    const ok = await confirmModal({
      title: '该文档有密码保护',
      body: '带密码的 PDF 导出后内容可能不完整，建议先另存为无密码版本。是否继续导出？',
      okText: '继续导出',
    });
    if (!ok) return;
  }
  emit('export-start');
  try {
    // 兜底：使用原始嵌入字体的元素，其页面源层必须已构建（字体提取注册才发生）
    const needPks = [...new Set(state.elements.filter((e) => e.customFont).map((e) => e.page))];
    if (needPks.length) await Promise.all(needPks.map((pk) => ensureSourceLayer(pk)));

    const src = await PDFDocument.load(state.docBytes, { ignoreEncryption: true, updateMetadata: false });
    const out = await PDFDocument.create();
    out.registerFontkit(window.fontkit);

    // 1. 按显示顺序组装页面（copyPages 仅创建页对象，必须显式 addPage）
    const outPages = [];
    const origSeq = state.display.filter((d) => d.kind === 'orig');
    const copied = origSeq.length ? await out.copyPages(src, origSeq.map((d) => d.idx)) : [];
    let ci = 0;
    for (const d of state.display) {
      if (d.kind === 'orig') outPages.push(out.addPage(copied[ci++]));
      else outPages.push(out.insertPage(out.getPageCount(), [d.w, d.h]));
    }
    if (!outPages.length) out.addPage([595.28, 841.89]);

    // 2. 嵌入字体/图片缓存
    const fontCache = new Map();
    const fontFor = async (fontId, weight = 400, italic = false) => {
      const key = `${fontId}|${weight}|${italic ? 1 : 0}`;
      if (fontCache.has(key)) return fontCache.get(key);
      let f = await loadEmbedFont(out, fontId, { weight, italic });
      if (!f) f = await out.embedFont(standardFont({ bold: weight >= 600, italic }));
      fontCache.set(key, f);
      return f;
    };
    const imageCache = new Map();
    const imageFor = async (dataUrl) => {
      if (imageCache.has(dataUrl)) return imageCache.get(dataUrl);
      const bytes = await (await fetch(dataUrl)).arrayBuffer();
      const img = /^data:image\/jpeg/.test(dataUrl) ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      imageCache.set(dataUrl, img);
      return img;
    };
    // 原始文档内嵌字体：原样嵌入（子集化），保证字形/字宽与原文一致
    const origFontCache = new Map();
    const fontForOrig = async (realName, bytes) => {
      if (origFontCache.has(realName)) return origFontCache.get(realName);
      const f = await out.embedFont(bytes.slice(0), { subset: true });
      origFontCache.set(realName, f);
      return f;
    };

    // 3. 逐元素绘制（数组顺序 = z 序）
    for (const el of state.elements) {
      const di = state.display.findIndex((d) => d.pk === el.page);
      if (di < 0) continue;
      const page = outPages[di];
      if (!page) continue;
      await drawElement(page, el, { fontFor, imageFor, fontForOrig });
    }

    // 4. 元数据并保存
    const base = (state.docName || 'document').replace(/\.pdf$/i, '');
    out.setTitle(base);
    out.setProducer('PDF 在线编辑器');
    out.setModificationDate(new Date());
    const bytes = await out.save({ useObjectStreams: false });
    download(new Blob([bytes], { type: 'application/pdf' }), `${base}-已编辑.pdf`);
    toast(`已导出 ${base}-已编辑.pdf`);
  } catch (e) {
    console.error(e);
    toast('导出失败: ' + (e.message || e), 'err');
  } finally {
    emit('export-end');
  }
}

// ---------- 元素绘制 ----------
async function drawElement(page, el, ctx) {
  const pk = el.page;
  const r = rot0(el);
  switch (el.type) {
    case 'whiteout':
    case 'highlight':
    case 'rect': {
      const opts = {
        opacity: el.type === 'highlight' ? (el.opacity ?? 0.45) : el.type === 'rect' ? (el.opacity ?? 1) : 1,
      };
      if (el.type === 'highlight') opts.color = rgbOf(el.color);
      else if (el.type === 'whiteout') opts.color = rgbOf(el.color || '#ffffff');
      else {
        if (el.fill && el.fill !== 'none') opts.color = rgbOf(el.fill);
        if (el.stroke && el.strokeWidth > 0) {
          opts.borderColor = rgbOf(el.stroke);
          opts.borderWidth = el.strokeWidth;
        }
        // 既无填充也无描边：显示端透明，导出端跳过（pdf-lib 默认黑填充会凭空出现黑块）
        if (!opts.color && !opts.borderColor) break;
      }
      if (r === 0) {
        const a = toPdf(pk, el.x, el.y), b = toPdf(pk, el.x + el.w, el.y + el.h);
        page.drawRectangle({
          ...opts,
          x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
        });
      } else {
        // 旋转矩形：锚点 = 旋转后的左上角；drawSvgPath 路径坐标 y 向下，与显示坐标一致
        const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
        const tl = rotPt({ x: el.x, y: el.y }, c, el.rot || 0);
        const a = toPdf(pk, tl.x, tl.y);
        const d = `M 0 0 L ${el.w} 0 L ${el.w} ${el.h} L 0 ${el.h} Z`;
        page.drawSvgPath(d, {
          x: a.x, y: a.y, rotate: degrees(-r),
          ...(opts.color ? { color: opts.color } : {}),
          ...(opts.borderColor ? { borderColor: opts.borderColor, borderWidth: opts.borderWidth } : {}),
          opacity: opts.opacity,
        });
      }
      break;
    }
    case 'ellipse': {
      const rx = el.w / 2, ry = el.h / 2;
      const opts = {
        opacity: el.opacity ?? 1,
        ...(el.fill && el.fill !== 'none' ? { color: rgbOf(el.fill) } : {}),
        ...(el.stroke && el.strokeWidth > 0 ? { borderColor: rgbOf(el.stroke), borderWidth: el.strokeWidth } : {}),
      };
      // 既无填充也无描边：跳过绘制（避免 pdf-lib 默认黑填充）
      if (!opts.color && !opts.borderColor) break;
      const cPdf = toPdf(pk, el.x + el.w / 2, el.y + el.h / 2);
      if (r === 0) {
        page.drawEllipse({ x: cPdf.x, y: cPdf.y, xScale: rx, yScale: ry, ...opts });
      } else {
        // 旋转椭圆：多边形近似（相对元素中心）
        const N = 40;
        let d = '';
        for (let i = 0; i <= N; i++) {
          const t = (i / N) * Math.PI * 2;
          const px = Math.cos(t) * rx, py = Math.sin(t) * ry;
          d += `${i ? 'L' : 'M'} ${px.toFixed(2)} ${py.toFixed(2)} `;
        }
        d += 'Z';
        page.drawSvgPath(d, { x: cPdf.x, y: cPdf.y, rotate: degrees(-r), ...opts });
      }
      break;
    }
    case 'line':
    case 'arrow': {
      const pts = el.pts || [{ x: 0, y: 0 }, { x: el.w, y: el.h }];
      const a = toPdf(pk, el.x + pts[0].x, el.y + pts[0].y);
      const b = toPdf(pk, el.x + pts[1].x, el.y + pts[1].y);
      const opts = { thickness: el.strokeWidth, color: rgbOf(el.stroke), opacity: el.opacity ?? 1 };
      page.drawLine({ start: a, end: b, ...opts });
      if (el.type === 'arrow') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const L = 6 + el.strokeWidth * 2.4;
        for (const da of [Math.PI * 0.82, -Math.PI * 0.82]) {
          page.drawLine({ start: b, end: { x: b.x + Math.cos(ang + da) * L, y: b.y + Math.sin(ang + da) * L }, ...opts });
        }
      }
      break;
    }
    case 'ink': {
      if (!el.pts || el.pts.length < 2) break;
      const a = toPdf(pk, el.x, el.y);
      const d = el.pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
      page.drawSvgPath(d, {
        x: a.x, y: a.y,
        borderColor: rgbOf(el.stroke), borderWidth: el.strokeWidth,
        borderLineCap: 1, // round
        opacity: el.opacity ?? 1,
      });
      break;
    }
    case 'image': {
      const img = await ctx.imageFor(el.src);
      const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
      const rot = el.rot || 0;
      // pdf-lib 以（旋转前的）左下角为锚点并绕其旋转；换算等价锚点
      const blDisp = rot === 0
        ? { x: el.x, y: el.y + el.h }
        : rotPt({ x: el.x, y: el.y + el.h }, c, rot);
      const a = toPdf(pk, blDisp.x, blDisp.y);
      page.drawImage(img, {
        x: a.x, y: a.y, width: el.w, height: el.h,
        ...(rot ? { rotate: degrees(-rot) } : {}),
        opacity: el.opacity ?? 1,
      });
      break;
    }
    case 'text': {
      await drawText(page, el, ctx);
      break;
    }
    default: break;
  }
}

async function drawText(page, el, ctx) {
  // 原始嵌入字体优先（字形/字宽与原文完全一致），不可用或覆盖不全时回退内置字体
  let font = null;
  let useStandard = false;
  if (el.customFont) {
    const rec = getOrigFont(el.customFont);
    if (rec && rec.ok && coversAll(el.customFont, el.text)) {
      try {
        font = await ctx.fontForOrig(el.customFont, rec.bytes);
      } catch { font = null; }
    }
  }
  const weight = el.weight || (el.bold ? 700 : 400);
  // 智能选族：所选族缺字形时按覆盖性分段（英文段保原族，缺字形段换全覆盖族）
  let fontId = el.fontId;
  let mixedFont = null; // 缺字形段的替代字体
  if (!font) {
    await ensureFamilyCoverage(el.fontId);
    let allCovered = true;
    for (const ch of el.text || '') {
      if (!charCovered(el.fontId, ch)) { allCovered = false; break; }
    }
    if (!allCovered) {
      const altId = await pickFamilyForText(el.fontId, el.text);
      if (altId !== el.fontId) {
        mixedFont = await ctx.fontFor(altId, weight, el.italic);
      } else {
        fontId = altId; // 无更好替代时保持原族（标准字体走分段兜底）
      }
    }
  }
  const famInfo = getFamily(fontId);
  useStandard = !font && !mixedFont && famInfo && !famInfo.file; // 无字体文件 → 标准字体
  if (!font) font = await ctx.fontFor(fontId, weight, el.italic);
  const cjkFont = useStandard ? await ctx.fontFor('simhei', 400, false) : null;

  const size = el.size;
  const lh = el.lh || 1.3;
  // 原始字体使用其自身度量基准，内置字体用字体族 ascent
  const ascent = el.customFont && font
    ? (async () => {
        try {
          const fk = window.fontkit.create(new Uint8Array(getOrigFont(el.customFont).bytes.slice(0)));
          if (fk?.unitsPerEm && isFinite(fk.ascent)) return fk.ascent / fk.unitsPerEm;
        } catch { /* 回退 */ }
        return familyAscent(fontId);
      })()
    : familyAscent(fontId);
  const asc = await ascent;
  const halfLead = size * (lh - 1) / 2;
  const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const rot = el.rot || 0;
  const sx = el.scaleX && Math.abs(el.scaleX - 1) > 0.01 ? el.scaleX : 0;
  // 合成粗体：无粗体变体文件的字体族（如 CJK），用双向微偏移叠绘模拟笔画加粗
  let fauxBold = false;
  if (!el.customFont && weight >= 550) {
    const m = await getManifest();
    fauxBold = !(m.variants && m.variants[fontId] && m.variants[fontId].bold);
  }

  // 逐项字距还原：未修改的原文按每项各自比例绘制（保持单行原版式，不重排）
  if (el.adv && el.advText === el.text) {
    const baselineY = el.y + halfLead + asc * size;
    const pick = (t) => (useStandard && !/^[\x00-\xFF\s]*$/.test(t) ? cjkFont : font);
    let total = 0;
    const segWidths = el.adv.map((seg) => {
      let w = 0;
      for (const ch of seg.s) w += pick(ch).widthOfTextAtSize(ch, size) * (seg.k || 1);
      return w;
    });
    segWidths.forEach((w) => (total += w));
    let x = el.x;
    if (el.align === 'center') x = el.x + (el.w - total) / 2;
    else if (el.align === 'right') x = el.x + el.w - total;
    el.adv.forEach((seg, i) => {
      let cx = x;
      for (const ch of seg.s) {
        const f = pick(ch);
        const cw = f.widthOfTextAtSize(ch, size);
        drawChar(page, el, ch, cx, baselineY, f, size, rot, center, fauxBold);
        cx += cw * (seg.k || 1);
      }
      x += segWidths[i];
    });
    return;
  }

  // 行内分段：标准字体按中西文分段；混合覆盖场景按字形覆盖分段（缺字形段用替代字体）
  const buildLineSegs = (line) => {
    if (useStandard) {
      return encodeSegments(line, true).map((s) => ({ text: s.text, font: s.std ? font : cjkFont }));
    }
    if (mixedFont) {
      const segs = [];
      let buf = '', bufOk = null;
      const flush = () => { if (buf) segs.push({ text: buf, font: bufOk ? font : mixedFont }); buf = ''; };
      for (const ch of line) {
        const ok = charCovered(el.fontId, ch);
        if (bufOk === null || ok === bufOk) { buf += ch; bufOk = ok; }
        else { flush(); buf = ch; bufOk = ok; }
      }
      flush();
      return segs.length ? segs : [{ text: line, font }];
    }
    return [{ text: line, font }];
  };

  const lines = wrapLines(el);
  lines.forEach((line, li) => {
    if (!line) return;
    const lineTop = el.y + li * size * lh;
    const baselineY = lineTop + halfLead + asc * size;

    const segs = buildLineSegs(line);
    let total = 0;
    const widths = segs.map((s) => {
      const w = s.font.widthOfTextAtSize(s.text, size);
      total += w;
      return w;
    });
    let x0 = el.x;
    if (el.align === 'center') x0 = el.x + (el.w - total) / 2;
    else if (el.align === 'right') x0 = el.x + el.w - total;

    let x = x0;
    segs.forEach((s, i) => {
      const f = s.font;
      if (sx) {
        // 宽度补偿：逐字绘制，横向步进按比例缩放（与显示端 scaleX 一致）
        let cx = x;
        for (const ch of s.text) {
          const cw = f.widthOfTextAtSize(ch, size);
          drawChar(page, el, ch, cx, baselineY, f, size, rot, center, fauxBold);
          cx += cw * sx;
        }
      } else {
        drawChar(page, el, s.text, x, baselineY, f, size, rot, center, fauxBold);
      }
      x += widths[i];
    });
  });
}

function drawChar(page, el, txt, x, y, font, size, rot, center, fauxBold) {
  const draw = (dx, dy) => {
    const anchorDisp = rot === 0 ? { x: x + dx, y: y + dy } : rotPt({ x: x + dx, y: y + dy }, center, rot);
    const p = toPdf(el.page, anchorDisp.x, anchorDisp.y);
    page.drawText(txt, {
      x: p.x, y: p.y, size,
      font,
      color: rgbOf(el.color),
      ...(rot ? { rotate: degrees(-rot) } : {}),
    });
  };
  draw(0, 0);
  if (fauxBold) {
    const d = size * 0.022; // 横向 + 纵向各叠一次，加粗两个笔画方向
    draw(d, 0);
    draw(0, d);
  }
}

// confirmModal 由 ui.js 提供全局（避免循环导入时的加载顺序问题）
async function confirmModal(opts) {
  const m = await import('./ui.js');
  return m.confirmModal(opts);
}
