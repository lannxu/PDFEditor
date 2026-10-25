// 交互控制器：工具状态机、绘制、拖动、缩放、旋转、文字编辑、原文操作
import { state, on, emit, setTool, setSelection, snapshot, commit, addElements, removeElement, getElement, updateElement } from './state.js';
import { makeElement, normalizeImageFile, renderElement, whiteoutRectForRun, rebuildCoveredTexts, elementDom, bringForward, sendBackward, styleFromRun } from './elements.js';
import { getPageView, getSource, rasterRegion, ensureSourceLayer } from './pdfview.js';
import { clamp, uid } from './util.js';
import { toast } from './ui.js';

const pagesEl = () => document.getElementById('pages');

let op = null; // 当前指针操作

// ---------- 坐标 ----------
function pkFromEvent(e) {
  const outer = e.target.closest?.('.page-outer');
  return outer?.dataset.pk || null;
}
function layerPt(e, pk) {
  const pv = getPageView(pk);
  const r = pv.dom.getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.zoom, y: (e.clientY - r.top) / state.zoom };
}
function pageOf(pk) { return state.display.find((p) => p.pk === pk); }

// ---------- 初始化 ----------
export function initInteractions() {
  const root = pagesEl();
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('dblclick', onDblClick);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  on('tool-changed', () => { document.getElementById('app').dataset.tool = state.tool; });
  document.getElementById('app').dataset.tool = state.tool;
}

// ---------- 指针按下 ----------
function onPointerDown(e) {
  if (e.button !== 0) return;
  const isEditable = e.target.closest?.('[contenteditable="true"]');
  const pk = pkFromEvent(e);
  if (!pk) { setSelection(null); return; }
  const tool = state.tool;

  // 手柄（选择工具）
  const hd = e.target.closest?.('.hd, .hd-rotate');
  if (hd && tool === 'select') {
    const sel = state.selection;
    if (sel?.type === 'element') {
      const el = getElement(sel.id);
      if (el) {
        e.preventDefault();
        if (hd.dataset.hd === 'rot') startRotate(e, el);
        else if (hd.dataset.hd === 'p1' || hd.dataset.hd === 'p2') startEndpoint(e, el, hd.dataset.hd === 'p1' ? 0 : 1);
        else startResize(e, el, hd.dataset.hd);
        return;
      }
    }
  }

  if (tool === 'select') {
    // 元素
    const elDom = e.target.closest?.('.el');
    if (elDom) {
      const el = getElement(elDom.dataset.id);
      if (el) {
        if (state.editingTextId && state.editingTextId !== el.id) commitTextEdit();
        setSelection({ type: 'element', id: el.id });
        if (!(el.type === 'text' && state.editingTextId === el.id)) {
          e.preventDefault();
          startMove(e, el);
        }
        return;
      }
    }
    // 原文文字运行
    const runSpan = e.target.closest?.('.src-run');
    if (runSpan) {
      const run = getSource(pk).runs.find((r) => r.key === runSpan.dataset.key);
      if (run) {
        setSelection({ type: 'run', pk, run });
        showMiniBarForRun(pk, run);
        e.preventDefault();
        return;
      }
    }
    // 原图热区
    const hot = e.target.closest?.('.img-hot');
    if (hot) {
      const img = getSource(pk).imgs.find((m) => m.key === hot.dataset.key);
      if (img) {
        setSelection({ type: 'image', pk, img });
        showMiniBarForImage(pk, img);
        e.preventDefault();
        return;
      }
    }
    setSelection(null);
    return;
  }

  if (tool === 'text') {
    if (isEditable) return;
    createTextAt(e, pk);
    return;
  }

  if (tool === 'image') {
    pendingImage = { pk, pt: layerPt(e, pk) };
    document.getElementById('fileImg').click();
    return;
  }

  if (tool === 'ink') { startInk(e, pk); return; }

  // 形状类
  if (['rect', 'ellipse', 'highlight', 'whiteout', 'line', 'arrow'].includes(tool)) {
    startDraw(e, pk, tool);
    return;
  }
}

// ---------- 移动 ----------
function startMove(e, el) {
  const pk = el.page;
  const p0 = layerPt(e, pk);
  op = {
    kind: 'move', el, pk, p0, orig: { x: el.x, y: el.y }, moved: false,
    ctrl: e.ctrlKey || e.metaKey,
  };
}
function doMove(e) {
  const { el, p0, orig, pk } = op;
  const p = layerPt(e, pk);
  let dx = p.x - p0.x, dy = p.y - p0.y;
  if (e.shiftKey) { // 锁轴
    if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
  }
  const pg = pageOf(pk);
  const nx = clamp(orig.x + dx, -el.w + 12, pg.w - 12);
  const ny = clamp(orig.y + dy, -el.h + 12, pg.h - 12);
  Object.assign(el, { x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 });
  renderElement(el);
  emit('element-updated', { id: el.id, live: true });
}

// ---------- 缩放 ----------
function startResize(e, el, handle) {
  op = {
    kind: 'resize', el, pk: el.page, handle,
    p0: layerPt(e, el.page),
    orig: { x: el.x, y: el.y, w: el.w, h: el.h, rot: el.rot || 0 },
  };
}
function doResize(e) {
  const { el, handle, p0, orig } = op;
  const isText = el.type === 'text';
  const p = layerPt(e, el.page);
  const rot = orig.rot;
  const rad = -rot * Math.PI / 180;
  const dxw = (p.x - p0.x) * Math.cos(rad) - (p.y - p0.y) * Math.sin(rad);
  const dyw = (p.x - p0.x) * Math.sin(rad) + (p.y - p0.y) * Math.cos(rad);

  let l = orig.x, r = orig.x + orig.w, t = orig.y, b = orig.y + orig.h;
  // 拖动侧边线，最小 6pt，禁止越过对侧（避免翻转/跟随指针）
  if (handle.includes('w')) l = Math.min(l + dxw, r - 6);
  if (handle.includes('e')) r = Math.max(r + dxw, l + 6);
  if (handle.includes('n')) t = Math.min(t + dyw, b - 6);
  if (handle.includes('s')) b = Math.max(b + dyw, t + 6);

  let w1 = r - l, h1 = b - t;
  // 文本：仅调宽度（高度随内容自适应）
  if (isText) { h1 = orig.h; if (handle.includes('n') || handle.includes('s')) return; t = orig.y; b = orig.y + h1; }
  // 等比（图片角点 + Shift）
  if (e.shiftKey && el.type === 'image' && handle.length === 2) {
    const ar = orig.w / Math.max(1e-6, orig.h);
    h1 = w1 / ar;
    if (handle.includes('n')) t = b - h1; else b = t + h1;
  }

  // 固定对侧锚点，反推新中心
  const c0 = { x: orig.x + orig.w / 2, y: orig.y + orig.h / 2 };
  const radR = rot * Math.PI / 180;
  const R = (v) => ({ x: v.x * Math.cos(radR) - v.y * Math.sin(radR), y: v.x * Math.sin(radR) + v.y * Math.cos(radR) });
  let anchorLocal, anchorLocalNew;
  const cxNewLocal = l + w1 / 2, cyNewLocal = t + h1 / 2;
  const opp = {
    nw: [r, b], n: [orig.x + orig.w / 2, b], ne: [l, b], e: [l, orig.y + orig.h / 2],
    se: [l, t], s: [orig.x + orig.w / 2, t], sw: [r, t], w: [r, orig.y + orig.h / 2],
  }[handle];
  anchorLocal = { x: opp[0], y: opp[1] };
  anchorLocalNew = { x: opp[0], y: opp[1] }; // 对侧点在新盒中位置不变（坐标同）
  const A = rotPtLocal(anchorLocal, c0, rot);
  const dLocalNew = { x: anchorLocalNew.x - cxNewLocal, y: anchorLocalNew.y - cyNewLocal };
  const dRot = R(dLocalNew);
  const C1 = { x: A.x - dRot.x, y: A.y - dRot.y };

  Object.assign(el, {
    x: Math.round((C1.x - w1 / 2) * 10) / 10,
    y: Math.round((C1.y - h1 / 2) * 10) / 10,
    w: Math.round(w1 * 10) / 10,
    h: Math.round(h1 * 10) / 10,
  });
  renderElement(el);
  emit('element-updated', { id: el.id, live: true });
}
function rotPtLocal(p, c, deg) {
  const r = deg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

// ---------- 旋转 ----------
function startRotate(e, el) {
  op = { kind: 'rotate', el, c: { x: el.x + el.w / 2, y: el.y + el.h / 2 } };
}
function doRotate(e) {
  const { el, c } = op;
  const p = layerPt(e, el.page);
  let ang = Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI + 90;
  if (e.shiftKey) ang = Math.round(ang / 15) * 15;
  else { const near = Math.round(ang / 90) * 90; if (Math.abs(ang - near) < 4) ang = near; }
  el.rot = Math.round(ang * 10) / 10;
  renderElement(el);
  emit('element-updated', { id: el.id, live: true });
}

// ---------- 线端点 ----------
function startEndpoint(e, el, idx) {
  op = { kind: 'endpoint', el, idx };
}
function doEndpoint(e) {
  const { el, idx } = op;
  const p = layerPt(e, el.page);
  const pts = [...(el.pts || [{ x: 0, y: 0 }, { x: el.w, y: el.h }])];
  pts[idx] = p;
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  el.x = Math.round(x * 10) / 10; el.y = Math.round(y * 10) / 10;
  el.w = Math.round((Math.max(...xs) - x) * 10) / 10;
  el.h = Math.round((Math.max(...ys) - y) * 10) / 10;
  el.pts = pts.map((q) => ({ x: Math.round((q.x - x) * 10) / 10, y: Math.round((q.y - y) * 10) / 10 }));
  renderElement(el);
  emit('element-updated', { id: el.id, live: true });
}

// ---------- 绘制新元素 ----------
function startDraw(e, pk, tool) {
  e.preventDefault();
  const p = layerPt(e, pk);
  const el = makeElement(tool, pk, p.x, p.y, 0, 0);
  if (tool === 'line' || tool === 'arrow') el.pts = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  op = { kind: 'draw', el, pk, p0: p, ghost: true };
  el._ghost = true;
  renderElement(el);
  elementDom(el)?.classList.add('el-ghost');
}

function doDraw(e) {
  const { el, pk, p0 } = op;
  const p = layerPt(e, pk);
  if (el.type === 'line' || el.type === 'arrow') {
    const pts = [{ x: p0.x, y: p0.y }, { x: p.x, y: p.y }];
    if (e.shiftKey) { // 锁 45°
      const dx = p.x - p0.x, dy = p.y - p0.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      pts[1] = { x: p0.x + Math.cos(ang) * len, y: p0.y + Math.sin(ang) * len };
    }
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    el.x = x; el.y = y;
    el.w = Math.max(...xs) - x; el.h = Math.max(...ys) - y;
    el.pts = pts.map((q) => ({ x: q.x - x, y: q.y - y }));
  } else {
    let x1 = p0.x, y1 = p0.y, x2 = p.x, y2 = p.y;
    if (e.shiftKey) { const s = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1)); x2 = x1 + Math.sign(x2 - x1) * s; y2 = y1 + Math.sign(y2 - y1) * s; }
    el.x = Math.min(x1, x2); el.y = Math.min(y1, y2);
    el.w = Math.abs(x2 - x1); el.h = Math.abs(y2 - y1);
  }
  renderElement(el);
}

// ---------- 画笔 ----------
function startInk(e, pk) {
  e.preventDefault();
  const p = layerPt(e, pk);
  const el = makeElement('ink', pk, p.x, p.y, 0, 0, { pts: [{ x: 0, y: 0 }] });
  op = { kind: 'ink', el, pk, last: p };
  el._ghost = true;
  renderElement(el);
}
function doInk(e) {
  const { el, pk, last } = op;
  const p = layerPt(e, pk);
  if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) return;
  op.last = p;
  const pad = el.strokeWidth;
  // 以世界坐标记录点，再整体归一化到 bbox
  const world = el.pts.map((q) => ({ x: q.x + el.x, y: q.y + el.y }));
  world.push(p);
  const xs = world.map((q) => q.x), ys = world.map((q) => q.y);
  el.x = Math.min(...xs) - pad; el.y = Math.min(...ys) - pad;
  el.w = Math.max(...xs) - Math.min(...xs) + pad * 2;
  el.h = Math.max(...ys) - Math.min(...ys) + pad * 2;
  el.pts = world.map((q) => ({ x: q.x - el.x, y: q.y - el.y }));
  renderElement(el);
}

// ---------- 文字 ----------
function createTextAt(e, pk) {
  e.preventDefault();
  const d = state.defaults.text;
  const pg = pageOf(pk);
  const p = layerPt(e, pk);
  // 默认宽度不超出页面右缘（防呆：文本溢出页外的部分在显示与导出中均不可见）
  const defW = Math.max(60, Math.min(300, pg.w - p.x - 20));
  const el = makeElement('text', pk, p.x, p.y - d.size * 0.8, defW, d.size * d.lh, {
    text: '', lh: d.lh,
  });
  addElements([el]);
  setSelection({ type: 'element', id: el.id });
  enterTextEdit(el, { selectAll: false });
}

let textDirty = false;
export function enterTextEdit(el, { selectAll = true } = {}) {
  commitTextEdit();
  state.editingTextId = el.id;
  textDirty = false;
  renderElement(el);
  setSelection({ type: 'element', id: el.id });
  const dom = elementDom(el);
  if (!dom) return;
  // 非编辑态可能渲染为逐项字距 span（adv）——编辑前重置为纯文本，避免 contenteditable 操作 span 节点
  if (dom.children.length > 0) dom.textContent = el.text || '';
  dom.style.height = 'auto';
  dom.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(dom);
  if (!selectAll) range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  dom.addEventListener('input', onTextInput);
  dom.addEventListener('blur', onTextBlur);
  dom.addEventListener('keydown', onTextKeydown);
  dom.addEventListener('paste', onTextPaste);
}

// 文字编辑中拦截粘贴：仅插入纯文本；粘贴图片则转为图片元素（避免 base64 <img> 混入 contenteditable）
function onTextPaste(e) {
  e.preventDefault();
  e.stopPropagation();
  const dt = e.clipboardData;
  const text = dt?.getData('text/plain');
  if (text) {
    document.execCommand('insertText', false, text);
    return;
  }
  const item = [...(dt?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    const f = item.getAsFile();
    if (f) {
      e.target.dispatchEvent(new FocusEvent('blur')); // 先提交文字
      placeImageFile(f);
      toast('已粘贴为图片元素');
    }
  }
}

function onTextInput() {
  textDirty = true;
}
function onTextKeydown(e) {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    e.target.blur();
  }
}
function onTextBlur(e) {
  commitTextEdit();
}
export async function commitTextEdit() {
  const id = state.editingTextId;
  if (!id) return;
  const el = getElement(id);
  const dom = el && elementDom(el);
  if (el && dom) {
    dom.removeEventListener('input', onTextInput);
    dom.removeEventListener('blur', onTextBlur);
    dom.removeEventListener('keydown', onTextKeydown);
    dom.removeEventListener('paste', onTextPaste);
    const txt = (dom.innerText || '').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
    el.text = txt;
    el.h = Math.max(el.size * el.lh, Math.round(dom.offsetHeight * 10) / 10);
    dom.style.height = '';
  }
  state.editingTextId = null;
  if (el && !el.text) {
    removeElement(id);
  } else if (el) {
    // 原始字体为子集：新输入的字符可能无字形 → 回退到内置字体族
    if (el.customFont) {
      const m = await import('./origfonts.js');
      if (!m.coversAll(el.customFont, el.text)) {
        el.customFont = null;
        toast('部分新字符不在原字体子集内，已改用内置字体显示');
      }
    }
    // 文本已修改 → 逐项字距数据失效（项边界不再对应新文本）
    if (textDirty && el.adv && el.text !== el.advText) el.adv = null;
    if (textDirty) snapshot(); // 文字提交后的状态入栈，保证重做可恢复
    renderElement(el);
    commit('text-commit');
  }
}
on('restored', () => {
  // 撤销/重做恢复了全新状态：丢弃进行中的指针操作，避免把旧修改写回（元素对象已被替换）
  op = null;
  state.editingTextId = null;
  textDirty = false;
});

// 文本内容高度同步（宽度变化导致折行变化后调用）
function syncTextHeight(el) {
  const dom = elementDom(el);
  if (!dom) return;
  const prev = dom.style.height;
  dom.style.height = 'auto';
  el.h = Math.max(el.size * el.lh, Math.round(dom.offsetHeight * 10) / 10);
  dom.style.height = prev;
  renderElement(el);
}

// ---------- 指针移动/抬起 ----------
function onPointerMove(e) {
  if (!op) return;
  if (op.kind === 'move') {
    op.moved = true;
    doMove(e);
  } else if (op.kind === 'resize') doResize(e);
  else if (op.kind === 'rotate') doRotate(e);
  else if (op.kind === 'endpoint') doEndpoint(e);
  else if (op.kind === 'draw') doDraw(e);
  else if (op.kind === 'ink') doInk(e);
}

function onPointerUp() {
  if (!op) return;
  const o = op;
  op = null;
  const el = o.el;
  if (o.kind === 'draw' || o.kind === 'ink') {
    delete el._ghost;
    elementDom(el)?.classList.remove('el-ghost');
    const isArea = ['highlight', 'whiteout', 'rect', 'ellipse'].includes(el.type);
    let tooSmall =
      (el.type === 'line' || el.type === 'arrow')
        ? Math.hypot(el.w, el.h) < 4
        : el.type === 'ink'
          ? el.pts.length < 2
          : Math.max(el.w, el.h) < (isArea ? 4 : 3);
    if (!tooSmall && isArea) {
      // 扁平拖拽（沿文字行划过）时补默认厚度/宽度，居中于拖拽线
      if (el.h < 4) { el.y -= 5; el.h = 10; }
      if (el.w < 4) { el.x -= 5; el.w = 10; }
    }
    if (tooSmall) {
      elementDom(el)?.remove();
    } else {
      el.x = Math.round(el.x * 10) / 10; el.y = Math.round(el.y * 10) / 10;
      el.w = Math.round(el.w * 10) / 10; el.h = Math.round(el.h * 10) / 10;
      state.elements.push(el);
      emit('elements-changed', { added: [el.id] });
      setSelection({ type: 'element', id: el.id });
      // 涂白后自动重建被覆盖的原文文字，保持可读（重建完成后统一入栈）
      if (el.type === 'whiteout') {
        rebuildCoveredTexts(el.page, el).then((covered) => {
          if (covered.length) {
            covered.forEach((c) => state.elements.push(c));
            emit('elements-changed', { added: covered.map((c) => c.id) });
          }
          snapshot();
          commit('draw');
        });
      } else {
        snapshot();
        commit('draw');
      }
      if (state.tool !== 'select' && el.type !== 'highlight' && el.type !== 'whiteout' && el.type !== 'ink') {
        setTool('select'); // 画完形状自动回到选择
      }
    }
  } else if (o.kind === 'move' && o.moved) {
    snapshot();
    commit('move');
  } else if (o.kind === 'resize' || o.kind === 'rotate' || o.kind === 'endpoint') {
    // 文本宽度变化会改变折行数——按新内容同步高度，保持选中框/手柄与内容一致
    if (o.kind === 'resize' && el.type === 'text') syncTextHeight(el);
    snapshot();
    commit(o.kind);
  }
  emit('element-updated', { id: el.id });
}

// ---------- 双击 ----------
function onDblClick(e) {
  const pk = pkFromEvent(e);
  if (!pk) return;
  const elDom = e.target.closest?.('.el');
  if (elDom && elDom.classList.contains('el-text')) {
    const el = getElement(elDom.dataset.id);
    if (el && state.editingTextId !== el.id) {
      setSelection({ type: 'element', id: el.id });
      enterTextEdit(el);
    }
    return;
  }
  const runSpan = e.target.closest?.('.src-run');
  if (runSpan) {
    const run = getSource(pk).runs.find((r) => r.key === runSpan.dataset.key);
    if (run) { editRun(pk, run); return; }
  }
}

// ---------- 原文操作 ----------
async function runToTextElement(pk, run) {
  const style = await styleFromRun(run); // 字体族/原始嵌入字体/宽度补偿/字号/粗斜体
  const lh = 1.15;
  const el = makeElement('text', pk, run.vx, run.vy - (run.asc + (lh - 1) / 2) * run.fs, Math.max(run.w + style.size * 0.6, style.size * 2), run.fs * lh * 1.2, {
    text: run.str.replace(/\s+$/, ''),
    ...style,
    lh, rot: run.angle,
  });
  return el;
}

async function editRun(pk, run) {
  hideMiniBar();
  const wo = whiteoutRectForRun(pk, run);
  const { markRunsConsumed } = await import('./pdfview.js');
  const color = (await import('./pdfview.js')).sampleColor(pk, run.bbox);
  markRunsConsumed(pk, [run.key]);
  const textEl = await runToTextElement(pk, run);
  textEl.color = color;
  const covered = await rebuildCoveredTexts(pk, wo);
  addElements([makeElement('whiteout', pk, wo.x, wo.y, wo.w, wo.h), ...covered, textEl]);
  setSelection({ type: 'element', id: textEl.id });
  enterTextEdit(textEl, { selectAll: false });
  // 光标置于末尾
  const dom = elementDom(textEl);
  if (dom) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(dom);
    range.collapse(false);
    sel.removeAllRanges(); sel.addRange(range);
  }
}

async function deleteRun(pk, run) {
  hideMiniBar();
  const wo = whiteoutRectForRun(pk, run);
  const { markRunsConsumed } = await import('./pdfview.js');
  markRunsConsumed(pk, [run.key]);
  const covered = await rebuildCoveredTexts(pk, wo);
  addElements([makeElement('whiteout', pk, wo.x, wo.y, wo.w, wo.h), ...covered]);
  toast('已删除该段文字');
}

async function deleteImage(pk, img) {
  hideMiniBar();
  const wo = { x: img.x, y: img.y, w: img.w, h: img.h };
  const covered = await rebuildCoveredTexts(pk, wo);
  addElements([makeElement('whiteout', pk, wo.x, wo.y, wo.w, wo.h), ...covered]);
  toast('已删除图片');
}

async function replaceImage(pk, img) {
  hideMiniBar();
  const file = await pickImageFile();
  if (!file) return;
  const { src, natW, natH } = await normalizeImageFile(file);
  const wo = { x: img.x, y: img.y, w: img.w, h: img.h };
  const covered = await rebuildCoveredTexts(pk, wo);
  const s = Math.min(img.w / natW, img.h / natH);
  const w = natW * s, h = natH * s;
  const imgEl = makeElement('image', pk, img.x + (img.w - w) / 2, img.y + (img.h - h) / 2, w, h, { src, natW, natH });
  addElements([makeElement('whiteout', pk, wo.x, wo.y, wo.w, wo.h), ...covered, imgEl]);
  setSelection({ type: 'element', id: imgEl.id });
  toast('已替换图片');
}

async function cutImage(pk, img) {
  hideMiniBar();
  const src = await rasterRegion(pk, img, { type: 'image/png' });
  if (!src) return toast('剪切失败', 'err');
  const wo = { x: img.x, y: img.y, w: img.w, h: img.h };
  // 栅格内已包含区域内文字，完全在区域内的文字不再重建
  const covered = await rebuildCoveredTexts(pk, wo, { skipFullyInside: true });
  const imgEl = makeElement('image', pk, img.x, img.y, img.w, img.h, { src, natW: img.w, natH: img.h });
  addElements([makeElement('whiteout', pk, wo.x, wo.y, wo.w, wo.h), ...covered, imgEl]);
  setSelection({ type: 'element', id: imgEl.id });
  toast('已剪切为可移动图片');
}

async function extractImage(pk, img) {
  hideMiniBar();
  const src = await rasterRegion(pk, img, { type: 'image/png' });
  if (!src) return toast('提取失败', 'err');
  const bin = await (await fetch(src)).blob();
  const { download } = await import('./util.js');
  download(bin, `image-${img.key.replace(/[^a-z0-9]/gi, '_')}.png`);
  toast('已提取图片');
}

function pickImageFile() {
  return new Promise((resolve) => {
    const inp = document.getElementById('fileImg');
    const done = () => {
      const f = inp.files?.[0];
      inp.value = '';
      inp.removeEventListener('change', done);
      resolve(f || null);
    };
    inp.addEventListener('change', done);
    inp.click();
  });
}

// ---------- 图片放置 ----------
let pendingImage = null;
// 取消文件选择时清除待放置位置（避免残留到后续粘贴）
export function resetPendingImage() { pendingImage = null; }
export async function placeImageFile(file, atPk, atPt) {
  if (!file) return;
  let pk = atPk || pendingImage?.pk;
  let pt = atPt || pendingImage?.pt;
  pendingImage = null;
  if (!pk) {
    // 放到当前视图中央
    const cur = document.querySelector('.page-outer');
    pk = cur?.dataset.pk || state.display[0]?.pk;
    const pg = pageOf(pk);
    pt = pg ? { x: pg.w / 2, y: pg.h / 3 } : null;
  }
  if (!pk || !pt) return;
  const { src, natW, natH } = await normalizeImageFile(file);
  const pg = pageOf(pk);
  const maxW = pg.w * 0.45, maxH = pg.h * 0.6;
  const s = Math.min(maxW / natW, maxH / natH, 1);
  const w = natW * s, h = natH * s;
  const el = makeElement('image', pk, pt.x - w / 2, pt.y - h / 2, w, h, { src, natW, natH });
  addElements([el]);
  setSelection({ type: 'element', id: el.id });
  setTool('select');
}

// ---------- 浮动小工具条 ----------
let miniBar = null;
function hideMiniBar() { miniBar?.remove(); miniBar = null; }
function syncPicked() {
  document.querySelectorAll('.src-run.picked, .img-hot.picked').forEach((n) => n.classList.remove('picked'));
  const sel = state.selection;
  if (sel?.type === 'run') document.querySelector(`.src-run[data-key="${sel.run.key}"]`)?.classList.add('picked');
  if (sel?.type === 'image') document.querySelector(`.img-hot[data-key="${sel.img.key}"]`)?.classList.add('picked');
}
on('selection-changed', () => { syncPicked(); if (!state.selection || state.selection.type === 'element') hideMiniBar(); });
on('tool-changed', hideMiniBar);
on('zoom-changed', () => {
  if (miniBar && state.selection && state.selection.type !== 'element') {
    const sel = state.selection;
    if (sel.type === 'run') positionMiniBar(sel.pk, sel.run.bbox);
    else if (sel.type === 'image') positionMiniBar(sel.pk, sel.img);
  }
});

function showMiniBarForRun(pk, run) {
  const actions = [
    { label: '✏️ 编辑', fn: () => editRun(pk, run) },
    { label: '🗑 删除', fn: () => deleteRun(pk, run), danger: true },
    { label: '⧉ 复制', fn: async () => { try { await navigator.clipboard.writeText(run.str); toast('已复制文字'); } catch { toast('复制失败', 'err'); } } },
  ];
  buildMiniBar(pk, run.bbox, actions);
}
function showMiniBarForImage(pk, img) {
  const actions = [
    { label: '🗑 删除', fn: () => deleteImage(pk, img), danger: true },
    { label: '🔄 替换', fn: () => replaceImage(pk, img) },
    { label: '✂️ 剪切', fn: () => cutImage(pk, img) },
    { label: '⬇ 提取', fn: () => extractImage(pk, img) },
  ];
  buildMiniBar(pk, img, actions);
}
function buildMiniBar(pk, anchor, actions) {
  hideMiniBar();
  const pv = getPageView(pk);
  if (!pv) return;
  miniBar = document.createElement('div');
  miniBar.className = 'mini-bar';
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.danger) b.classList.add('danger');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); a.fn(); });
    miniBar.appendChild(b);
  });
  pv.dom.appendChild(miniBar);
  positionMiniBar(pk, anchor);
}
function positionMiniBar(pk, anchor) {
  if (!miniBar) return;
  const z = state.zoom;
  miniBar.style.left = (anchor.x + anchor.w / 2) * z + 'px';
  miniBar.style.top = Math.max(4, anchor.y * z - 6) + 'px';
}

// ---------- 键盘 ----------
export function initKeyboard() {
  window.addEventListener('keydown', (e) => {
    const inEditable = e.target.closest?.('[contenteditable="true"]') || e.target.closest?.('input,select,textarea');
    if (inEditable) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); import('./state.js').then((m) => (e.shiftKey ? m.redo() : m.undo())); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); import('./state.js').then((m) => m.redo()); return; }
    if (ctrl && e.key.toLowerCase() === 'd') {
      const sel = state.selection;
      if (sel?.type === 'element') { e.preventDefault(); duplicateElement(sel.id); }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'c') { const sel = state.selection; if (sel?.type === 'element') { clip = JSON.parse(JSON.stringify(getElement(sel.id))); toast('已复制元素'); } return; }
    if (ctrl && e.key.toLowerCase() === 'v') {
      if (clip) {
        e.preventDefault();
        const cp = JSON.parse(JSON.stringify(clip));
        cp.id = uid();
        cp.x += 14; cp.y += 14;
        addElements([cp]);
        setSelection({ type: 'element', id: cp.id });
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = state.selection;
      if (sel?.type === 'element') { e.preventDefault(); removeElement(sel.id); }
      return;
    }
    if (e.key === 'Escape') {
      if (state.selection) setSelection(null);
      else if (state.tool !== 'select') setTool('select');
      return;
    }
    // 方向键微调（连续按压合并为一条历史）
    if (e.key.startsWith('Arrow')) {
      const sel = state.selection;
      if (sel?.type === 'element') {
        e.preventDefault();
        const el = getElement(sel.id);
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        updateElement(el.id, { x: el.x + d[0], y: el.y + d[1] });
        renderElement(el);
        const now = Date.now();
        if (now - lastNudgeAt > 900) snapshot();
        lastNudgeAt = now;
        commit('nudge');
      }
      return;
    }
    // 工具快捷键
    if (!ctrl) {
      const map = { v: 'select', t: 'text', i: 'image', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', h: 'highlight', w: 'whiteout', p: 'ink' };
      const t = map[e.key.toLowerCase()];
      if (t) setTool(t);
    }
  });
}

let clip = null;
let lastNudgeAt = 0;

export function duplicateElement(id) {
  const el = getElement(id);
  if (!el) return;
  const cp = JSON.parse(JSON.stringify(el));
  cp.id = uid();
  cp.x += 14; cp.y += 14;
  addElements([cp]);
  setSelection({ type: 'element', id: cp.id });
}
