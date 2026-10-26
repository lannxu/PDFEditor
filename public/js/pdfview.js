// pdf.js 渲染管理 + 原文层（文字运行 / 图片热区）+ 栅格化 + 取色
import { state, on, emit } from './state.js';
import { matMul, matApply, aabbOfQuad, rgbToHex, clamp } from './util.js';

const pdfjs = window.pdfjsLib;
pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

const $ = (sel) => document.querySelector(sel);
const pagesEl = () => $('#pages');

// pk -> { dom, canvas, rendered, renderScale, renderTask, srcBuilt }
const pageViews = new Map();
// pk -> { runs: [], imgs: [] }
const sourceCache = new Map();
// origIdx -> { page(pdf.js), viewport(scale1) }
const pdfPages = new Map();

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const MAX_CANVAS = 5200; // 单边像素上限，防止超大缩放爆内存

let io = null; // 页面可见性观察

// ================= 文档 =================
export async function openPdfBytes(bytes, { password } = {}) {
  const task = pdfjs.getDocument({
    data: bytes.slice(0),
    cMapUrl: 'vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    password,
    isEvalSupported: false,
  });
  let neededPassword = false;
  task.onPassword = (updatePassword, reason) => {
    neededPassword = true;
    const isRetry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    window._pendingPassword = { updatePassword, isRetry }; // ui 模块负责弹窗
    emit('password-needed', { updatePassword, isRetry });
  };
  const pdfDoc = await task.promise;
  return { pdfDoc, encrypted: neededPassword };
}

export function readPagesMeta() {
  state.pages = [];
  pdfPages.clear();
  for (let i = 0; i < state.pdfDoc.numPages; i++) state.pages.push({ idx: i });
  state.display = state.pages.map((p) => ({ kind: 'orig', pk: 'o' + p.idx, idx: p.idx, w: 0, h: 0 }));
}

// 预取全部页面尺寸（并发）
export async function loadAllPageSizes() {
  const jobs = state.display.filter((d) => d.kind === 'orig').map(async (d) => {
    const page = await state.pdfDoc.getPage(d.idx + 1);
    const vp = page.getViewport({ scale: 1 });
    pdfPages.set(d.pk, { page, viewport: vp });
    d.w = vp.width; d.h = vp.height;
  });
  await Promise.all(jobs);
  // 空白页若尚无尺寸，取最后一页
  for (const d of state.display) {
    if (d.kind === 'blank' && (!d.w || !d.h)) {
      const last = [...state.display].reverse().find((p) => p.w && p.h);
      d.w = last ? last.w : 595.28; d.h = last ? last.h : 841.89;
    }
  }
}

export function pdfPageOf(pk) { return pdfPages.get(pk) || null; }

// ================= 页面 DOM =================
export function buildPageDom() {
  const root = pagesEl();
  root.innerHTML = '';
  pageViews.clear();
  for (const d of state.display) {
    const outer = document.createElement('div');
    outer.className = 'page-outer';
    outer.dataset.pk = d.pk;
    outer.style.width = d.w * state.zoom + 'px';
    outer.style.height = d.h * state.zoom + 'px';

    const paper = document.createElement('div');
    paper.className = 'page-paper';
    if (d.kind === 'orig') {
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      paper.appendChild(canvas);
    } else {
      const blank = document.createElement('div');
      blank.className = 'blank-page';
      paper.appendChild(blank);
    }
    const editLayer = document.createElement('div');
    editLayer.className = 'edit-layer';
    editLayer.style.width = d.w + 'px';
    editLayer.style.height = d.h + 'px';
    editLayer.style.transform = `scale(${state.zoom})`;
    const srcLayer = document.createElement('div');
    srcLayer.className = 'src-layer';
    const elLayer = document.createElement('div');
    elLayer.className = 'el-layer';
    editLayer.append(srcLayer, elLayer);
    paper.appendChild(editLayer);

    const handles = document.createElement('div');
    handles.className = 'handles-layer';
    outer.append(paper, handles);
    root.appendChild(outer);

    pageViews.set(d.pk, {
      dom: outer, paper, editLayer, srcLayer, elLayer, handles,
      canvas: d.kind === 'orig' ? paper.querySelector('canvas') : null,
      rendered: false, renderTask: null, srcBuilt: false,
    });
    io.observe(outer);
  }
  kickVisible();
}

// 直接按几何关系渲染视口附近页面（兜底：初始 IO 回调可能不送达）
export function kickVisible() {
  const viewer = document.getElementById('viewer');
  if (!viewer) return;
  const vr = viewer.getBoundingClientRect();
  pageViews.forEach((pv, pk) => {
    const r = pv.dom.getBoundingClientRect();
    const near = r.bottom > vr.top - 700 && r.top < vr.bottom + 700;
    if (!near) return;
    pv.visible = true;
    if (pv.canvas && (!pv.rendered || Math.abs((pv.renderScale || 0) - state.zoom) > 0.01)) renderPage(pk);
    ensureSourceLayer(pk);
  });
}

export function getPageView(pk) { return pageViews.get(pk); }

export function ensureVisibleRender() {
  pageViews.forEach((pv, pk) => {
    if (pv.visible) renderPage(pk);
  });
}

// 每页渲染串行化：避免取消/重启竞态导致 "same canvas" 静默失败
const renderChains = new Map();
export function renderPage(pk) {
  const prev = renderChains.get(pk) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => doRender(pk));
  renderChains.set(pk, next);
  next.finally(() => { if (renderChains.get(pk) === next) renderChains.delete(pk); });
  return next;
}

async function doRender(pk) {
  const d = state.display.find((p) => p.pk === pk);
  const pv = pageViews.get(pk);
  if (!d || !pv || d.kind !== 'orig') return;
  const info = pdfPages.get(pk);
  if (!info) return;
  const z = state.zoom;
  const scale = Math.min(z, MAX_CANVAS / Math.max(d.w, d.h));
  if (pv.rendered && Math.abs((pv.renderScale || 0) - z) < 0.01) return;
  const vp = info.page.getViewport({ scale });

  if (pv.renderTask) { try { pv.renderTask.cancel(); } catch { /* noop */ } }
  const canvas = pv.canvas;
  canvas.style.width = d.w * z + 'px';
  canvas.style.height = d.h * z + 'px';
  canvas.width = Math.floor(vp.width * DPR);
  canvas.height = Math.floor(vp.height * DPR);
  const ctx = canvas.getContext('2d');
  pv.renderTask = info.page.render({
    canvasContext: ctx,
    viewport: vp,
    transform: [DPR, 0, 0, DPR, 0, 0],
  });
  try {
    await pv.renderTask.promise;
    pv.rendered = true;
    pv.renderScale = z;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.warn('渲染失败', pk, e);
  }
}

// 缩放时立即调整 DOM 尺寸，随后（去抖）重渲染可见页
let rerenderTimer = null;
export function applyZoom() {
  pageViews.forEach((pv, pk) => {
    const d = state.display.find((p) => p.pk === pk);
    if (!d) return;
    pv.dom.style.width = d.w * state.zoom + 'px';
    pv.dom.style.height = d.h * state.zoom + 'px';
    if (pv.canvas) {
      // 先拉伸已有画面，等待重渲染替换
      pv.canvas.style.width = d.w * state.zoom + 'px';
      pv.canvas.style.height = d.h * state.zoom + 'px';
    }
  });
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(ensureVisibleRender, 140);
}

// ================= 原文层 =================
const ASC_FALLBACK = 0.88;
const DESC_FALLBACK = 0.24;

export async function ensureSourceLayer(pk) {
  const pv = pageViews.get(pk);
  if (!pv || pv.srcBuilt) return;
  const info = pdfPages.get(pk);
  if (!info) { pv.srcBuilt = true; return; }
  pv.srcBuilt = true;
  try {
    const [runs, imgs] = await Promise.all([extractRuns(pk, info), extractImages(pk, info)]);
    await resolveRunFonts(info, runs); // 字体名解析 + 内嵌字体提取注册（含样式精细还原）
    sourceCache.set(pk, { runs, imgs });
    renderSourceDom(pk);
  } catch (e) {
    console.warn('原文层构建失败', pk, e);
    sourceCache.set(pk, { runs: [], imgs: [] });
  }
}

// ---- 原始字体识别 ----
// 把 PDF 内嵌字体名（如 "ABCDEF+TimesNewRomanPSMT-BoldItalicMT"）映射到内置字体族
// 顺序敏感：仿宋先于宋体（"仿宋"含"宋"字）；专有英文字族先于通用衬线/无衬线规则
const FONT_NAME_MAP = [
  ['simkai', /kai|楷/],
  ['simfang', /fang|仿宋/],
  ['simsun', /simsun|nsimsun|song|宋/],
  ['simhei', /simhei|黑体/],
  ['msyh', /yahei|雅黑|msyh/],
  ['dengxian', /deng|等线/],
  ['calibri', /calibri|carlito/],
  ['cambria', /cambria|caladea/],
  ['consolas', /consol/],
  ['courier', /courier|mono/],
  ['georgia', /georgia/],
  ['verdana', /verdana|dejavu/i],
  ['tahoma', /tahoma/],
  ['trebuchet', /trebuchet/],
  ['impact', /impact/],
  ['segoeui', /segoe|selawik/],
  ['times', /times|roman|tinos|liberation serif|serif/i],
  ['arial', /arial|helvetica|liberation|arimo|nimbus|open ?sans|roboto|lato|sans/i],
];
// 字体名识别失败时按 pdf.js 泛型族兜底
const GENERIC_FALLBACK = { 'sans-serif': 'arial', serif: 'times', monospace: 'courier' };

function detectFontFamily(rawName) {
  const n = String(rawName || '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
  for (const [id, re] of FONT_NAME_MAP) {
    if (re.test(n)) return id;
  }
  return null;
}
function detectBold(name) { return /bold|black|heavy|semib|粗/i.test(name); }
function detectItalic(name) { return /italic|oblique|斜/i.test(name); }
// 字重识别：Light/Medium/SemiBold/Bold/Black → CSS 数值（400 为常规，不记录）
function detectWeight(name) {
  const n = String(name || '').toLowerCase();
  if (/black|heavy|超粗/.test(n)) return 900;
  if (/semib|demibold|中粗/.test(n)) return 600; // 需先于 bold（"Semibold" 含 "bold"）
  if (/bold|粗/.test(n)) return 700;
  if (/medium|中黑/.test(n)) return 500;
  if (/light|thin|细/.test(n)) return 300;
  return 400;
}

// 从 pdf.js commonObjs 读取字体原始名（getOperatorList 后字体已就绪）；
// 同时提取文档内嵌字体程序（origfonts，按基础名注册）供显示/导出复用
async function resolveRunFonts(info, runs) {
  const commonObjs = info.page.commonObjs;
  const cache = new Map();
  for (const run of runs) {
    const key = run.fontNameRaw;
    if (!key) continue;
    if (!cache.has(key)) {
      let rec = { name: '', generic: '', bold: false, italic: false };
      try {
        if (commonObjs && commonObjs.has(key)) {
          const obj = commonObjs.get(key);
          rec.name = String((obj && (obj.name || obj.fallbackName)) || '');
          rec.generic = String((obj && obj.fallbackName) || '');
          // 标准字体对象直接带 bold/italic 标志
          if (obj && typeof obj.bold === 'boolean') rec.bold = obj.bold;
          if (obj && typeof obj.italic === 'boolean') rec.italic = obj.italic;
        }
      } catch { /* 未就绪则跳过 */ }
      cache.set(key, rec);
    }
    const rec = cache.get(key);
    if (!rec.name && !rec.bold && !rec.italic) continue;
    let famId = detectFontFamily(rec.name);
    if (!famId && rec.generic) famId = GENERIC_FALLBACK[rec.generic] || null; // 泛型族兜底
    if (famId) run.fontId = famId;
    if (rec.bold || detectBold(rec.name)) run.bold = true;
    if (rec.italic || detectItalic(rec.name)) run.italic = true;
    const w = detectWeight(rec.name);
    if (w !== 400) run.weight = w;
    run.fontRealName = rec.name;
  }
  // 提取内嵌字体（文档级，一次），并为可覆盖运行现有文字的字体打标
  try {
    const m = await import('./origfonts.js');
    if (state.docBytes) await m.ensureDocFonts(state.docBytes);
    for (const run of runs) {
      const base = run.fontRealName && m.fontBaseName(run.fontRealName);
      if (base && m.origFontReady(base) && m.coversAll(base, run.str)) {
        run.customFont = base;
      }
    }
  } catch (e) {
    console.warn('内嵌字体提取失败', e);
  }
}

export function getSource(pk) {
  return sourceCache.get(pk) || { runs: [], imgs: [] };
}

// ---- 文字运行 ----
async function extractRuns(pk, info) {
  const tc = await info.page.getTextContent({ disableCombineTextItems: false });
  const vpt = info.viewport;
  const runs = [];
  let cur = null;
  const closeRun = () => { if (cur) { finishRun(cur); runs.push(cur); cur = null; } };

  tc.items.forEach((item, i) => {
    if (!item.str || !item.str.trim()) { if (item.hasEOL) closeRun(); return; }
    const t = item.transform || [10, 0, 0, 10, 0, 0];
    const fs = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const style = tc.styles?.[item.fontName] || {};
    let asc = isFinite(style.ascent) && style.ascent > 0 ? style.ascent : ASC_FALLBACK;
    let desc = isFinite(style.descent) && style.descent > 0 ? style.descent : DESC_FALLBACK;
    asc = clamp(asc, 0.5, 1.2); desc = clamp(desc, 0.1, 0.5);

    const p0 = vpt.convertToViewportPoint(t[4], t[5]);
    const p1 = vpt.convertToViewportPoint(t[4] + Math.cos(0), t[5] + Math.sin(0)); // dir=(1,0) in pdf space
    // 显示空间方向向量
    const dir = norm({ x: p1[0] - p0[0], y: p1[1] - p0[1] });
    const angle = Math.atan2(dir.y, dir.x) * 180 / Math.PI;
    const vx = p0[0], vy = p0[1];
    const w = Math.abs(item.width) || fs;

    const canMerge =
      cur && Math.abs(cur.vy - vy) <= Math.max(1.5, fs * 0.16) &&
      Math.abs(cur.angle - angle) < 2.5 && Math.abs(angle) < 2 && item.dir !== 'rtl' &&
      cur.dirOK && cur.fontNameRaw === (item.fontName || ''); // 同一行内字体变化处断开（混排字体各自识别）
    if (canMerge) {
      const gap = vx - (cur.vx + cur.w);
      if (gap <= Math.max(3, fs * 0.5) && gap >= -fs * 0.9) {
        if (gap > fs * 0.28 && !/\s$/.test(cur.str)) {
          cur.str += ' ';
          // 注入的空格归入前一项（宽度按间隙计）
          if (cur.items) { const p = cur.items[cur.items.length - 1]; p.s += ' '; p.w += Math.max(0, gap); }
        }
        cur.str += item.str;
        cur.w = vx + w - cur.vx;
        cur.endIdx = i;
        if (cur.items) cur.items.push({ s: item.str, w });
        if (item.hasEOL) closeRun();
        return;
      }
    }
    closeRun();
    cur = {
      key: `r${i}`, startIdx: i, endIdx: i,
      str: item.str, vx, vy, w, fs, asc, desc, angle,
      fontNameRaw: item.fontName || '',
      items: [{ s: item.str, w }], // 逐项数据：局部字距还原用
      dirOK: Math.abs(angle) < 2 && item.dir !== 'rtl',
    };
    if (item.hasEOL) closeRun();
  });
  closeRun();
  return runs.filter((r) => r.str.trim());
}

function finishRun(run) {
  // 由基线起止点 + 字高生成 AABB
  const rad = (run.angle * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const up = { x: dir.y, y: -dir.x };
  const A = add2({ x: run.vx, y: run.vy }, mul2(up, run.asc * run.fs));
  const B = add2(add2(A, mul2(dir, run.w)), mul2(up, 0));
  const p1 = add2({ x: run.vx, y: run.vy }, mul2(dir, run.w));
  const C = sub2(p1, mul2(up, run.desc * run.fs));
  const D = sub2({ x: run.vx, y: run.vy }, mul2(up, run.desc * run.fs));
  run.bbox = aabbOfQuad([A, add2(A, mul2(dir, run.w)), C, D]);
}

const norm = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
const add2 = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub2 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul2 = (v, k) => ({ x: v.x * k, y: v.y * k });

// ---- 图片热区 ----
async function extractImages(pk, info) {
  const opList = await info.page.getOperatorList();
  const { OPS } = pdfjs;
  const vpt = info.viewport;
  const pw = vpt.width, ph = vpt.height;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const found = [];
  const seen = new Set();

  const record = (ref) => {
    const quad = [[0, 0], [1, 0], [1, 1], [0, 1]]
      .map(([x, y]) => matApply(ctm, x, y))
      .map(([x, y]) => vpt.convertToViewportPoint(x, y));
    const bb = aabbOfQuad(quad.map(([x, y]) => ({ x, y })));
    // 裁剪到页面范围
    const x0 = Math.max(bb.x, 0), y0 = Math.max(bb.y, 0);
    const x1 = Math.min(bb.x + bb.w, pw), y1 = Math.min(bb.y + bb.h, ph);
    if (x1 - x0 < 3 || y1 - y0 < 3) return; // 过小 / 完全在页面外
    const key = `${ref}|${x0.toFixed(1)},${y0.toFixed(1)},${(x1 - x0).toFixed(1)},${(y1 - y0).toFixed(1)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ key, ref, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };

  opList.fnArray.forEach((fn, i) => {
    const args = opList.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm); break;
      case OPS.restore: ctm = stack.pop() || ctm; break;
      case OPS.transform: ctm = matMul(ctm, args); break;
      case OPS.paintImageXObject: record(args[0]); break;
      case OPS.paintInlineImageXObject: record(`inline${i}`); break;
      case OPS.paintImageMaskXObject: record(`mask${args[0]}`); break;
      case OPS.paintJpegXObject: record(args[0]); break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (args && args[0]) ctm = matMul(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd: ctm = stack.pop() || ctm; break;
      default: break;
    }
  });
  return found;
}

// ---- 原文层 DOM ----
export function renderSourceDom(pk) {
  const pv = pageViews.get(pk);
  if (!pv) return;
  const { runs, imgs } = getSource(pk);
  const consumed = new Set(state.consumedRuns[pk] || []);
  pv.srcLayer.innerHTML = '';
  runs.forEach((r) => {
    const span = document.createElement('span');
    span.className = 'src-run';
    span.dataset.key = r.key;
    if (consumed.has(r.key)) span.classList.add('hidden');
    const b = r.bbox;
    span.style.left = r.vx + 'px';
    span.style.top = r.vy - r.asc * r.fs + 'px';
    span.style.width = r.w + 'px';
    span.style.height = (r.asc + r.desc) * r.fs + 'px';
    span.style.fontSize = r.fs + 'px';
    span.style.transformOrigin = `0 ${r.asc * r.fs}px`;
    span.style.transform = r.angle ? `rotate(${r.angle}deg)` : '';
    span.textContent = r.str;
    pv.srcLayer.appendChild(span);
  });
  imgs.forEach((im) => {
    const div = document.createElement('div');
    div.className = 'img-hot';
    div.dataset.key = im.key;
    div.style.left = im.x + 'px';
    div.style.top = im.y + 'px';
    div.style.width = im.w + 'px';
    div.style.height = im.h + 'px';
    pv.srcLayer.appendChild(div);
  });
}

export function markRunsConsumed(pk, keys) {
  if (!keys.length) return;
  const arr = state.consumedRuns[pk] || (state.consumedRuns[pk] = []);
  keys.forEach((k) => { if (!arr.includes(k)) arr.push(k); });
  // 隐藏对应 span
  const pv = pageViews.get(pk);
  if (pv) pv.srcLayer.querySelectorAll('.src-run').forEach((s) => { if (keys.includes(s.dataset.key)) s.classList.add('hidden'); });
}

// ================= 采样与栅格 =================
// 从已渲染画布取样：背景色（众数）+ 前景色（与背景差异最大的次众数）
// 深色底白字场景：bg=深色（用于覆盖块）、fg=白色（文字原色）——避免"白字盖白块"不可见
export function sampleColors(pk, bbox) {
  const none = { fg: null, bg: null };
  const pv = pageViews.get(pk);
  if (!pv || !pv.canvas || !pv.canvas.width) return none;
  const d = state.display.find((p) => p.pk === pk);
  const kx = pv.canvas.width / d.w, ky = pv.canvas.height / d.h;
  const x0 = clamp(Math.floor(bbox.x * kx), 0, pv.canvas.width - 1);
  const y0 = clamp(Math.floor(bbox.y * ky), 0, pv.canvas.height - 1);
  const x1 = clamp(Math.ceil((bbox.x + bbox.w) * kx), 1, pv.canvas.width);
  const y1 = clamp(Math.ceil((bbox.y + bbox.h) * ky), 1, pv.canvas.height);
  if (x1 - x0 < 2 || y1 - y0 < 2) return none;
  let data;
  try { data = pv.canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data; } catch { return none; }

  const hist = new Map();
  const q = (v) => v >> 4; // 16 级量化
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 40) continue;
    const key = (q(data[i]) << 8) | (q(data[i + 1]) << 4) | q(data[i + 2]);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  if (!hist.size) return none;
  let bgKey = 0, bgN = 0;
  hist.forEach((n, k) => { if (n > bgN) { bgN = n; bgKey = k; } });
  const expand = (k) => [(k >> 8) & 15, (k >> 4) & 15, k & 15].map((v) => v * 16 + 8);
  const bg = expand(bgKey);
  let fgKey = null, fgN = 0;
  hist.forEach((n, k) => {
    const c = expand(k);
    const dist = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
    if (dist > 70 && n > fgN) { fgN = n; fgKey = k; }
  });
  return {
    bg: rgbToHex(bg[0], bg[1], bg[2]),
    fg: fgKey === null ? null : (() => { const c = expand(fgKey); return rgbToHex(c[0], c[1], c[2]); })(),
  };
}

// 兼容旧调用：仅取前景
export function sampleColor(pk, bbox) {
  return sampleColors(pk, bbox).fg || '#111111';
}

// 高清栅格化页面区域 → dataURL（用于剪切原图 / 提取图片）
export async function rasterRegion(pk, bbox, { type = 'image/png', quality = 0.92, maxW = 2400 } = {}) {
  const d = state.display.find((p) => p.pk === pk);
  if (!d) return null;
  if (d.kind === 'blank') {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(bbox.w)); c.height = Math.max(2, Math.round(bbox.h));
    return c.toDataURL(type, quality);
  }
  const info = pdfPages.get(pk);
  if (!info) return null;
  const scale = Math.min(4, Math.max(1.5, maxW / Math.max(8, bbox.w)));
  const vp = info.page.getViewport({ scale });
  const full = document.createElement('canvas');
  full.width = Math.floor(vp.width); full.height = Math.floor(vp.height);
  await info.page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.floor(bbox.w * scale));
  out.height = Math.max(2, Math.floor(bbox.h * scale));
  out.getContext('2d').drawImage(
    full,
    bbox.x * scale, bbox.y * scale, bbox.w * scale, bbox.h * scale,
    0, 0, out.width, out.height
  );
  return out.toDataURL(type, quality);
}

// ================= 视图辅助 =================
export function scrollToPage(pk) {
  const pv = pageViews.get(pk);
  if (pv) pv.dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

export function currentPagePk() {
  const viewer = $('#viewer');
  let best = null, bestTop = Infinity;
  pageViews.forEach((pv, pk) => {
    const r = pv.dom.getBoundingClientRect();
    if (r.bottom < 60 || r.top > viewer.clientHeight) return;
    const top = Math.abs(r.top);
    if (top < bestTop) { bestTop = top; best = pk; }
  });
  return best;
}

export function initPageObserver() {
  io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        const pk = en.target.dataset.pk;
        const pv = pageViews.get(pk);
        if (!pv) return;
        pv.visible = en.isIntersecting;
        if (en.isIntersecting) {
          if (pv.canvas && !pv.rendered) renderPage(pk);
          else if (pv.canvas && Math.abs((pv.renderScale || 0) - state.zoom) > 0.01) renderPage(pk);
          ensureSourceLayer(pk);
        }
      });
    },
    { root: $('#viewer'), rootMargin: '700px 0px' }
  );
}

// 撤销/重做回滚了 consumedRuns 数组，但源层 span 的隐藏状态是 DOM 状态——需按回滚后的数据重渲染
on('restored', () => {
  pageViews.forEach((pv, pk) => {
    if (pv.srcBuilt) renderSourceDom(pk);
  });
});

// 重新构建页面（页面增删后）
export function rebuildPages() {
  io?.disconnect?.();
  buildPageDom();
  kickVisible();
  emit('pages-rendered');
}

// 页面尺寸变化（空白页取尺寸等）
export function refreshPageSizes() {
  pageViews.forEach((pv, pk) => {
    const d = state.display.find((p) => p.pk === pk);
    if (!d) return;
    pv.dom.style.width = d.w * state.zoom + 'px';
    pv.dom.style.height = d.h * state.zoom + 'px';
    pv.editLayer.style.width = d.w + 'px';
    pv.editLayer.style.height = d.h + 'px';
  });
}

on('doc-opened', () => { /* main.js 编排 */ });
