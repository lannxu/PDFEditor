// 应用状态 + 事件总线 + 撤销/重做 + 自动保存调度
import { uid, debounce } from './util.js';
import { store } from './store.js';

// ---- 事件总线 ----
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt)?.delete(fn);
}
export function emit(evt, arg) {
  listeners.get(evt)?.forEach((fn) => { try { fn(arg); } catch (e) { console.error(evt, e); } });
}

// ---- 状态 ----
export const state = {
  docId: null,
  docName: '',
  docBytes: null,       // ArrayBuffer（原始 PDF）
  pdfDoc: null,         // pdf.js 文档
  encrypted: false,     // 打开时是否需要过密码
  pages: [],            // 原始页：{ idx, w, h } （显示 pt，即 scale=1 视口尺寸）
  display: [],          // 显示页序：{kind:'orig', idx} | {kind:'blank', id, w, h}
  elements: [],         // 编辑元素（数组顺序即 z 序）
  consumedRuns: {},     // pageKey -> [runKey...] 已被涂白覆盖的原文文字运行
  tool: 'select',
  zoom: 1,
  selection: null,      // {type:'element', id} | {type:'run', pk, run} | {type:'image', pk, img}
  editingTextId: null,  // 正在编辑文字的元素
  defaults: {           // 新元素默认属性（属性栏可改）
    text: { fontId: 'simhei', size: 14, color: '#111111', bold: false, italic: false, align: 'left', lh: 1.3, autoFit: true },
    image: { opacity: 1 },
    rect: { stroke: '#e5484d', strokeWidth: 1.5, fill: 'none', opacity: 1 },
    ellipse: { stroke: '#e5484d', strokeWidth: 1.5, fill: 'none', opacity: 1 },
    line: { stroke: '#e5484d', strokeWidth: 1.5, opacity: 1 },
    arrow: { stroke: '#e5484d', strokeWidth: 1.5, opacity: 1 },
    highlight: { color: '#ffe066', opacity: 0.45 },
    whiteout: { color: '#ffffff' },
    ink: { stroke: '#2563eb', strokeWidth: 2, opacity: 1 },
  },
};

export function pageSize(pk) {
  const d = state.display.find((p) => p.pk === pk);
  return d ? { w: d.w, h: d.h } : null;
}
export function displayAt(i) { return state.display[i]; }
export function displayIndexOf(pk) { return state.display.findIndex((p) => p.pk === pk); }

// ---- 历史栈（快照式） ----
const hist = { stack: [], idx: -1, cap: 80 };

function serialize() {
  return JSON.stringify({
    elements: state.elements,
    consumedRuns: state.consumedRuns,
    display: state.display,
  });
}
function restore(json) {
  const d = JSON.parse(json);
  state.elements = d.elements;
  state.consumedRuns = d.consumedRuns;
  state.display = d.display;
  state.selection = null;
  state.editingTextId = null;
  emit('restored');
  emit('selection-changed');
  emit('history-changed');
  commit('history');
}

// 修改完成后调用：记录当前快照（后置快照，撤销恢复到上一条目）
export function snapshot() {
  hist.stack = hist.stack.slice(0, hist.idx + 1);
  hist.stack.push(serialize());
  if (hist.stack.length > hist.cap) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  emit('history-changed');
}
export function undo() {
  if (hist.idx <= 0) return;
  hist.idx--;
  restore(hist.stack[hist.idx]);
  commit('undo');
}
export function redo() {
  if (hist.idx >= hist.stack.length - 1) return;
  hist.idx++;
  restore(hist.stack[hist.idx]);
  commit('redo');
}
export const canUndo = () => hist.idx > 0;
export const canRedo = () => hist.idx < hist.stack.length - 1;

// ---- 元素 API ----
export function addElement(el) { addElements([el]); }
export function addElements(els, { snapshot: snap = true } = {}) {
  els.forEach((e) => state.elements.push(e));
  emit('elements-changed', { added: els.map((e) => e.id) });
  if (snap) snapshot();
  commit('add');
}
export function getElement(id) { return state.elements.find((e) => e.id === id); }
export function removeElement(id) {
  const i = state.elements.findIndex((e) => e.id === id);
  if (i >= 0) {
    state.elements.splice(i, 1);
    if (state.selection?.id === id) setSelection(null);
    emit('elements-changed', { removed: [id] });
    snapshot();
    commit('remove');
  }
}
export function updateElement(id, patch) {
  const el = getElement(id);
  if (!el) return;
  Object.assign(el, patch);
  emit('element-updated', { id, patch });
}
// 交互结束/属性修改完成时调用：触发自动保存与状态栏刷新
export function commit(reason) {
  emit('commit', reason);
}

export function setTool(t) {
  if (state.tool === t) return;
  state.tool = t;
  emit('tool-changed', t);
}
export function setSelection(sel) {
  const same =
    (!sel && !state.selection) ||
    (sel && state.selection && sel.type === state.selection.type &&
      sel.id === state.selection.id && sel.pk === state.selection.pk &&
      (sel.type === 'element' || sel.run === state.selection.run || sel.img === state.selection.img));
  if (same) return;
  state.selection = sel;
  emit('selection-changed');
}
export function setZoom(z, anchorEvt) {
  state.zoom = z;
  emit('zoom-changed', { zoom: z, anchorEvt });
  emit('commit', 'zoom');
}

// ---- 页面操作 ----
export function blankPageDefaults() {
  const last = state.display[state.display.length - 1];
  return last ? { w: last.w, h: last.h } : { w: 595.28, h: 841.89 };
}
export function insertBlankAfter(pk) {
  const i = displayIndexOf(pk);
  const { w, h } = blankPageDefaults();
  const blank = { kind: 'blank', pk: 'b' + uid(), w, h };
  if (i < 0) state.display.push(blank);
  else state.display.splice(i + 1, 0, blank);
  emit('pages-changed');
  snapshot();
  commit('insert-blank');
  return blank.pk;
}
export function deletePage(pk) {
  const removedEls = state.elements.filter((e) => e.page === pk);
  state.elements = state.elements.filter((e) => e.page !== pk);
  state.display = state.display.filter((p) => p.pk !== pk);
  if (removedEls.length) emit('elements-changed', { removed: removedEls.map((e) => e.id) });
  if (state.selection && state.selection.pk === pk) setSelection(null);
  emit('pages-changed');
  snapshot();
  commit('delete-page');
}

// ---- 文档打开 / 关闭 ----
export function resetDoc() {
  // 释放旧 pdf.js 文档（终止 worker，防止反复开关文档累积泄漏）
  if (state.pdfDoc?.destroy) { try { state.pdfDoc.destroy(); } catch { /* 忽略 */ } }
  state.docId = null; state.docName = ''; state.docBytes = null; state.pdfDoc = null;
  state.pages = []; state.display = []; state.elements = []; state.consumedRuns = {};
  state.selection = null; state.editingTextId = null; state.encrypted = false;
  hist.stack = []; hist.idx = -1;
  import('./origfonts.js').then((m) => m.resetDocFonts()).catch(() => {});
  emit('doc-closed');
  emit('history-changed');
}

export function docOpened({ id, name, bytes, pdfDoc, encrypted }) {
  state.docId = id; state.docName = name; state.docBytes = bytes;
  state.pdfDoc = pdfDoc; state.encrypted = !!encrypted;
  snapshot(); // 初始空快照
  emit('doc-opened');
}

// ---- 自动保存 ----
async function saveNow() {
  if (!state.docId || !state.pdfDoc) return;
  const meta = {
    id: state.docId,
    name: state.docName,
    updatedAt: Date.now(),
    pageCount: state.display.length,
    elements: state.elements.length,
    edits: JSON.parse(serialize()),
  };
  try {
    await store.putMeta(meta);
    emit('autosaved', meta.updatedAt);
  } catch (e) {
    console.warn('自动保存失败', e);
  }
}
const scheduleSave = debounce(saveNow, 900);
export function persistBytes() {
  if (state.docId && state.docBytes) store.putFile(state.docId, state.docBytes).catch((e) => console.warn(e));
}
on('commit', () => {
  if (state.pdfDoc) scheduleSave();
});
