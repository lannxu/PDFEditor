// 编辑元素：模型工厂 + DOM 渲染同步
import { state, on, emit, getElement, updateElement } from './state.js';
import { uid, hexDist, pickContrast } from './util.js';
import { getFamily } from './fonts.js';
import { cssStack as origCssStack } from './origfonts.js';
import { getPageView, getSource, markRunsConsumed, sampleColors } from './pdfview.js';

// ---------- 工厂 ----------
export function makeElement(type, page, x, y, w, h, extra = {}) {
  const def = state.defaults[type] || {};
  const el = {
    id: uid(), page, type,
    x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
    w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10,
    rot: 0,
    ...JSON.parse(JSON.stringify(def)),
    ...extra,
  };
  return el;
}

// 图片导入统一规范化为 dataURL，限制最大边长
export async function normalizeImageFile(file, maxSide = 2000) {
  const url = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  const need = Math.max(img.width, img.height) > maxSide;
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const scale = need ? maxSide / Math.max(img.width, img.height) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { src: c.toDataURL(type, 0.92), natW: img.width, natH: img.height };
}

// ---------- DOM 渲染 ----------
export function elementDom(el) {
  const pv = getPageView(el.page);
  return pv ? pv.elLayer.querySelector(`.el[data-id="${el.id}"]`) : null;
}

export function renderElement(el) {
  const pv = getPageView(el.page);
  if (!pv) return;
  let dom = pv.elLayer.querySelector(`.el[data-id="${el.id}"]`);
  if (!dom) {
    dom = document.createElement('div');
    dom.dataset.id = el.id;
    pv.elLayer.appendChild(dom);
  }
  dom.className = `el el-${el.type}`;
  dom.style.left = el.x + 'px';
  dom.style.top = el.y + 'px';
  dom.style.width = el.w + 'px';
  dom.style.height = el.h + 'px';
  // 编辑中的文字：宽度 auto（打字实时生长），上限 = 页面右缘——不提前折行压住下一行
  if (el.type === 'text' && state.editingTextId === el.id) {
    const d = state.display.find((p) => p.pk === el.page);
    dom.style.width = 'auto';
    dom.style.maxWidth = Math.max(40, (d ? d.w : 600) - el.x - 8) + 'px';
    dom.style.height = 'auto';
  }
  dom.classList.toggle('sel', state.selection?.type === 'element' && state.selection.id === el.id);

  const z = 100 + state.elements.indexOf(el);
  dom.style.zIndex = z;
  // 通用变换：旋转 + 宽度比例补偿（还原原文水平压缩/加宽）
  const sx = el.scaleX && Math.abs(el.scaleX - 1) > 0.01 ? el.scaleX : 0;
  if (el.rot && sx) {
    dom.style.transform = `scaleX(${sx}) rotate(${el.rot}deg)`;
    dom.style.transformOrigin = '0 50%';
  } else if (el.rot) {
    dom.style.transform = `rotate(${el.rot}deg)`;
    dom.style.transformOrigin = '';
  } else if (sx) {
    dom.style.transform = `scaleX(${sx})`;
    dom.style.transformOrigin = '0 50%';
  } else {
    dom.style.transform = '';
    dom.style.transformOrigin = '';
  }

  switch (el.type) {
    case 'text': {
      const famCss = getFamily(el.fontId)?.css || 'sans-serif';
      dom.style.fontFamily = el.customFont ? origCssStack(el.customFont, famCss) : famCss;
      dom.style.fontSize = el.size + 'px';
      dom.style.color = el.color;
      dom.style.fontWeight = String(el.weight || (el.bold ? 700 : 400));
      dom.style.fontStyle = el.italic ? 'italic' : 'normal';
      dom.style.textAlign = el.align || 'left';
      dom.style.lineHeight = String(el.lh || 1.3);
      const editing = state.editingTextId === el.id;
      dom.setAttribute('contenteditable', editing ? 'true' : 'false');
      dom.classList.toggle('editing', editing);
      // 编辑中高度自适应内容，属性（字体/字号等）调整即时生效
      dom.style.height = editing ? 'auto' : el.h + 'px';
      if (!editing) {
        dom.textContent = '';
        if (!el.text) {
          dom.classList.add('hidden');
        } else {
          dom.classList.remove('hidden');
          if (el.adv && el.advText === el.text) {
            // 逐项字距还原：每段按各自比例横向缩放（未编辑原文时启用）
            el.adv.forEach((seg) => {
              const sp = document.createElement('span');
              sp.textContent = seg.s;
              sp.style.display = 'inline-block';
              sp.style.transformOrigin = '0 50%';
              if (seg.k && Math.abs(seg.k - 1) > 0.01) sp.style.transform = `scaleX(${seg.k})`;
              dom.appendChild(sp);
            });
          } else {
            dom.textContent = el.text;
          }
        }
      }
      break;
    }
    case 'image': {
      dom.innerHTML = '';
      const img = document.createElement('img');
      img.src = el.src;
      img.draggable = false;
      dom.style.opacity = el.opacity ?? 1;
      dom.appendChild(img);
      break;
    }
    case 'rect':
    case 'ellipse': {
      dom.style.border = `${el.strokeWidth}px solid ${el.stroke}`;
      dom.style.background = el.fill === 'none' ? 'transparent' : el.fill;
      if (el.type === 'ellipse') dom.style.borderRadius = '50%';
      dom.style.opacity = el.opacity ?? 1;
      break;
    }
    case 'highlight': {
      dom.style.background = el.color;
      dom.style.opacity = el.opacity ?? 0.45;
      break;
    }
    case 'whiteout': {
      dom.style.background = el.color || '#ffffff';
      break;
    }
    case 'line':
    case 'arrow': {
      dom.innerHTML = lineSvg(el);
      dom.style.opacity = el.opacity ?? 1;
      break;
    }
    case 'ink': {
      dom.innerHTML = inkSvg(el);
      dom.style.opacity = el.opacity ?? 1;
      break;
    }
    default: break;
  }
}

function lineSvg(el) {
  const pts = el.pts || [{ x: 0, y: 0 }, { x: el.w, y: el.h }];
  const a = pts[0], b = pts[1];
  const sw = el.strokeWidth;
  const head = (b.x - a.x) * 1e-7; // noop 保留结构
  let inner = `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${el.stroke}" stroke-width="${sw}" stroke-linecap="round" />`;
  if (el.type === 'arrow') {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const L = 6 + sw * 2.4;
    for (const da of [Math.PI * 0.82, -Math.PI * 0.82]) {
      const hx = b.x + Math.cos(ang + da) * L;
      const hy = b.y + Math.sin(ang + da) * L;
      inner += `<line x1="${b.x}" y1="${b.y}" x2="${hx}" y2="${hy}" stroke="${el.stroke}" stroke-width="${sw}" stroke-linecap="round" />`;
    }
  }
  return `<svg width="${el.w}" height="${el.h}" style="overflow:visible">${inner}</svg>`;
}

function inkSvg(el) {
  if (!el.pts || el.pts.length < 2) return '';
  const d = el.pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return `<svg width="${el.w}" height="${el.h}" style="overflow:visible"><path d="${d}" fill="none" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
}

// 元素在数组中的顺序变化（层级）
export function bringForward(id) {
  const i = state.elements.findIndex((e) => e.id === id);
  if (i < 0 || i === state.elements.length - 1) return;
  const [el] = state.elements.splice(i, 1);
  state.elements.splice(i + 1, 0, el);
  rerenderPage(el.page);
}
export function sendBackward(id) {
  const i = state.elements.findIndex((e) => e.id === id);
  if (i <= 0) return;
  const [el] = state.elements.splice(i, 1);
  state.elements.splice(i - 1, 0, el);
  rerenderPage(el.page);
}

export function rerenderPage(pk) {
  state.elements.filter((e) => e.page === pk).forEach(renderElement);
}

export function renderAllElements() {
  document.querySelectorAll('.el-layer').forEach((l) => (l.innerHTML = ''));
  state.elements.forEach(renderElement);
}

// ---------- 文本自适应宽度 ----------
// 元素显示字体栈（与 renderElement 一致）
export function cssStackOf(el) {
  const famCss = getFamily(el.fontId)?.css || 'sans-serif';
  return el.customFont ? origCssStack(el.customFont, famCss) : famCss;
}
// 按当前字体/字号/字重/斜体计算自适应尺寸：宽 = 最长行自然宽，高 = 行数×行高
export function autoFitSize(el, pageW) {
  const css = `${el.italic ? 'italic ' : ''}${el.weight || (el.bold ? 700 : 400)} ${el.size}px ${cssStackOf(el)}`;
  const lines = String(el.text || '').split('\n');
  let max = 0;
  for (const line of lines) max = Math.max(max, measureCssWidth(line, css) || 0);
  const w = Math.min(Math.max(24, Math.ceil(max) + 4), Math.max(40, (pageW || 600) - el.x - 8));
  const h = Math.max(el.size * (el.lh || 1.3), Math.round(lines.length * el.size * (el.lh || 1.3) * 10) / 10);
  return { w: Math.round(w * 10) / 10, h };
}

// 内容驱动的完整重排（编辑原文的转换元素用）：
// 短则收缩、长则先加宽、到页面右缘才折行，高度随行数——返回新尺寸与行数
export function fitTextSize(el, pageW) {
  const css = `${el.italic ? 'italic ' : ''}${el.weight || (el.bold ? 700 : 400)} ${el.size}px ${cssStackOf(el)}`;
  const avail = Math.max(40, (pageW || 600) - el.x - 8);
  const out = [];
  for (const para of String(el.text || '').split('\n')) {
    if (measureCssWidth(para, css) <= avail) { out.push(para); continue; }
    let cur = '';
    for (const ch of para) {
      if (cur && measureCssWidth(cur + ch, css) > avail) { out.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) out.push(cur);
  }
  const max = Math.max(10, ...out.map((l) => measureCssWidth(l, css)));
  const w = Math.min(avail, Math.max(24, Math.ceil(max) + 4));
  const lh = el.lh || 1.3;
  const h = Math.max(el.size * lh, Math.round(out.length * el.size * lh * 10) / 10);
  return { w: Math.round(w * 10) / 10, h, lineCount: out.length };
}

// ---------- 原文样式精细还原 ----------
// 度量文本在指定字体栈下的自然宽度（pt）
let _measureCtx = null;
export function measureCssWidth(text, css) {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  _measureCtx.font = css;
  return _measureCtx.measureText(text).width;
}
export function measureTextWidth(text, cssStackStr, size) {
  return measureCssWidth(text, `${size}px ${cssStackStr}`);
}
// 从文字运行生成元素样式：字体族 / 原始嵌入字体 / 宽度比例补偿 / 字号 / 字重 / 粗斜体
export async function styleFromRun(run) {
  const famId = run.fontId || (/^[\x00-\xFF\s]*$/.test(run.str) ? 'arial' : 'simhei');
  const { cssStack, coversAll, origFontReady } = await import('./origfonts.js');
  let customFont = null;
  if (run.fontRealName && origFontReady(run.fontRealName) && coversAll(run.fontRealName, run.str)) {
    customFont = run.fontRealName;
  }
  const stack = cssStack(customFont, getFamily(famId)?.css || 'sans-serif');
  const natural = measureTextWidth(run.str, stack, run.fs);
  // 宽度补偿：整体比例 + 逐项比例（局部字距差异明显时记录 adv 数组）
  let scaleX = 1;
  let adv = null;
  if (run.items && run.items.length > 1 && natural > 1 && run.w > 1) {
    const nat = run.items.map((it) => measureTextWidth(it.s, stack, run.fs));
    const ratios = run.items.map((it, i) => (nat[i] > 0.5 ? it.w / nat[i] : 1));
    if (ratios.every((r) => r > 0.55 && r < 1.8)) {
      scaleX = Math.round((run.w / natural) * 1000) / 1000;
      const spread = Math.max(...ratios) - Math.min(...ratios);
      if (spread > 0.045) adv = run.items.map((it, i) => ({ s: it.s, k: Math.round(ratios[i] * 1000) / 1000 }));
    }
  } else if (natural > 1 && run.w > 1) {
    const k = run.w / natural;
    if (k > 0.55 && k < 1.8) scaleX = Math.round(k * 1000) / 1000;
  }
  const weight = run.weight || (run.bold ? 700 : 400);
  return {
    fontId: famId,
    customFont,
    scaleX,
    ...(adv ? { adv, advText: run.str } : {}),
    ...(weight !== 400 ? { weight } : {}),
    size: Math.max(4, Math.round(run.fs * 10) / 10),
    bold: !!run.bold || weight >= 600,
    italic: !!run.italic,
  };
}

// ---------- 原文编辑：文字运行 → 涂白 + 新文字元素 ----------
// 覆盖运行区域（涂白）并返回受影响的文字运行（供上层重建）
export function whiteoutRectForRun(pk, run) {
  const b = run.bbox;
  return {
    x: b.x - 1.2, y: b.y - 1.0,
    w: b.w + 2.4, h: b.h + 2.0,
  };
}

export async function runsUnderRect(pk, rect) {
  const { runs } = getSource(pk);
  return runs.filter((r) => {
    const b = r.bbox;
    return b.x < rect.x + rect.w && b.x + b.w > rect.x && b.y < rect.y + rect.h && b.y + b.h > rect.y;
  });
}

// 在涂白操作后自动重建被覆盖的文字（保持文档可读）
// options.skipInside: 完全处于区域内的运行不重建；coverColor: 覆盖块颜色（重建文字需保持可读）
export async function rebuildCoveredTexts(pk, rect, { skipFullyInside = false, coverColor = '#ffffff' } = {}) {
  const consumed = new Set(state.consumedRuns[pk] || []);
  const runs = await runsUnderRect(pk, rect);
  const created = [];
  for (const r of runs) {
    if (consumed.has(r.key)) continue;
    const inside = coverOf(r.bbox, rect);
    if (skipFullyInside && inside > 0.92) { markRunsConsumed(pk, [r.key]); continue; }
    const style = await styleFromRun(r);
    let color = sampleColors(pk, r.bbox).fg || '#111111';
    if (hexDist(color, coverColor) < 60) color = pickContrast(coverColor);
    const asc = r.asc, size = style.size;
    const lh = 1.15;
    const el = makeElement('text', pk, r.vx, r.vy - (asc + (lh - 1) / 2) * r.fs, r.w + size * 0.6, r.fs * lh * 1.35, {
      text: r.str.replace(/\s+$/, ''),
      ...style,
      color, align: 'left', lh, rot: r.angle,
      redrawn: r.key,
    });
    created.push(el);
    markRunsConsumed(pk, [r.key]);
  }
  return created;
}

function coverOf(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-6, a.w * a.h);
}

// ---------- 事件接线 ----------
on('elements-changed', ({ added, removed } = {}) => {
  if (removed) removed.forEach((id) => { const d = elementDom({ id, page: null }); const n = document.querySelector(`.el[data-id="${id}"]`); n?.remove(); });
  if (added) added.forEach((id) => { const el = getElement(id); if (el) renderElement(el); });
  refreshThumbsBadges();
});
on('element-updated', ({ id }) => {
  const el = getElement(id);
  if (el) renderElement(el);
});
on('selection-changed', () => {
  document.querySelectorAll('.el.sel').forEach((n) => n.classList.remove('sel'));
  if (state.selection?.type === 'element') {
    const el = getElement(state.selection.id);
    if (el) {
      const dom = document.querySelector(`.el[data-id="${el.id}"]`);
      dom?.classList.add('sel');
    }
  }
});
on('restored', () => { renderAllElements(); refreshThumbsBadges(); });
on('pages-rendered', () => { renderAllElements(); refreshThumbsBadges(); });

// 缩略图角标（每页编辑元素数）—— 由 ui 提供刷新
function refreshThumbsBadges() { emit('badges-changed'); }

export function elementsOnPage(pk) { return state.elements.filter((e) => e.page === pk); }
