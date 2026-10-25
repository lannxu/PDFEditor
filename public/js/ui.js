// UI：工具栏、缩略图、欢迎页/最近文件、缩放、toast、弹窗、加载、拖放/粘贴
import { state, on, emit, setTool, setZoom, undo, redo, canUndo, canRedo, resetDoc, docOpened, insertBlankAfter, deletePage, displayIndexOf, snapshot, persistBytes } from './state.js';
import { openPdfBytes, readPagesMeta, loadAllPageSizes, buildPageDom, initPageObserver, rebuildPages, pdfPageOf, scrollToPage, currentPagePk, getPageView, kickVisible } from './pdfview.js';
import { renderAllElements, elementsOnPage } from './elements.js';
import { placeImageFile, resetPendingImage } from './interactions.js';
import { exportPdf } from './exporter.js';
import { store } from './store.js';
import { hashBytes, fmtTime, clamp, debounce } from './util.js';

const $ = (s) => document.querySelector(s);

// ================= 工具栏 =================
const TOOLS = [
  { id: 'select', label: '选择', key: 'V', icon: '<path fill="currentColor" d="M7 2l12 11h-7l4 8-3 1.5-4-8L7 19V2z" transform="scale(0.86) translate(1.5,1.5)"/>' },
  { id: 'text', label: '文字', key: 'T', icon: '<text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor" font-family="Georgia">T</text>' },
  { id: 'image', label: '图片', key: 'I', icon: '<path fill="currentColor" d="M5 4h14v16H5V4zm2 12l3.5-4.5 2.5 3 3.5-5L19 15H7zm2.5-6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" transform="scale(0.9) translate(1.2,1.2)"/>' },
  { id: 'rect', label: '矩形', key: 'R', icon: '<rect x="4" y="6" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>' },
  { id: 'ellipse', label: '椭圆', key: 'O', icon: '<ellipse cx="12" cy="12" rx="8" ry="6.5" fill="none" stroke="currentColor" stroke-width="2"/>' },
  { id: 'line', label: '直线', key: 'L', icon: '<path d="M5 19L19 5" stroke="currentColor" stroke-width="2" fill="none"/>' },
  { id: 'arrow', label: '箭头', key: 'A', icon: '<path d="M5 19L17 7M17 7h-6M17 7v6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>' },
  { id: 'highlight', label: '高亮', key: 'H', icon: '<path fill="currentColor" d="M14 3l7 7-8 8H8l-3 3-2-2 3-3v-5l8-8zM6 14h6" transform="scale(0.9) translate(1,1)"/>' },
  { id: 'whiteout', label: '涂白', key: 'W', icon: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>' },
  { id: 'ink', label: '画笔', key: 'P', icon: '<path fill="currentColor" d="M3 17.2V21h3.8L18 9.8 14.2 6 3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0L15 5.2 18.8 9l1.9-1.9z"/>' },
];

export function initUi() {
  const tb = $('#toolButtons');
  TOOLS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'tb-btn tool';
    b.dataset.toolId = t.id;
    b.title = `${t.label} (${t.key})`;
    b.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17">${t.icon}</svg><span>${t.label}</span>`;
    b.addEventListener('click', () => setTool(t.id));
    tb.appendChild(b);
  });
  on('tool-changed', () => {
    document.querySelectorAll('#toolButtons .tb-btn').forEach((b) => b.classList.toggle('active', b.dataset.toolId === state.tool));
  });
  document.querySelector('#toolButtons .tb-btn').classList.add('active');

  $('#btnOpen').addEventListener('click', () => $('#filePdf').click());
  $('#wlOpen').addEventListener('click', () => $('#filePdf').click());
  $('#filePdf').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openPdfFile(f); });
  $('#fileImg').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) placeImageFile(f);
    else resetPendingImage(); // 取消选择：清除待放置位置
  });
  $('#wlSample').addEventListener('click', openSample);

  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  on('history-changed', () => {
    $('#btnUndo').disabled = !canUndo();
    $('#btnRedo').disabled = !canRedo();
  });

  $('#btnExport').addEventListener('click', exportPdf);
  on('export-start', () => showLoading('正在导出 PDF…'));
  on('export-end', hideLoading);

  initZoom();
  initDragDrop();
  initViewerEvents();
  initPasswordPrompt();
  initGlobalKeys();
  refreshRecents();
}

// ================= 缩放 =================
function initZoom() {
  const sel = $('#zoomSelect');
  const setZ = (z) => {
    const clamped = clamp(z, 0.25, 4);
    sel.value = String(Math.round(clamped * 100) / 100);
    setZoom(clamped);
  };
  sel.addEventListener('change', () => {
    if (sel.value === 'fit') setZ(fitWidthZoom());
    else setZ(Number(sel.value));
  });
  $('#btnZoomIn').addEventListener('click', () => setZ(state.zoom * 1.25));
  $('#btnZoomOut').addEventListener('click', () => setZ(state.zoom / 1.25));
  $('#viewer').addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const old = state.zoom;
    const nz = clamp(old * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.25, 4);
    // 以指针为锚点缩放
    const viewer = $('#viewer');
    const r = viewer.getBoundingClientRect();
    const ox = e.clientX - r.left + viewer.scrollLeft;
    const oy = e.clientY - r.top + viewer.scrollTop;
    setZoom(nz);
    viewer.scrollLeft = ox * (nz / old) - (e.clientX - r.left);
    viewer.scrollTop = oy * (nz / old) - (e.clientY - r.top);
    sel.value = String(Math.round(nz * 100) / 100);
  }, { passive: false });
}
export function fitWidthZoom() {
  const w = Math.max(...state.display.map((d) => d.w), 1);
  return clamp(($('#viewer').clientWidth - 56) / w, 0.25, 4);
}

// ================= 事件：状态栏 / 缩略图 =================
function initViewerEvents() {
  const viewer = $('#viewer');
  const onScroll = debounce(() => { updateStatus(); kickVisible(); }, 150);
  viewer.addEventListener('scroll', onScroll);
  on('commit', updateStatus);
  on('autosaved', (ts) => { $('#stRight').querySelector('.st-save') && ($('#stRight').querySelector('.st-save').textContent = `已自动保存 ${fmtTime(ts).slice(6)}`); });
  on('badges-changed', updateThumbsBadges);
  on('pages-changed', () => { rebuildPages(); buildThumbs(); });
}

export function updateStatus() {
  const cur = currentPagePk();
  const idx = cur ? displayIndexOf(cur) + 1 : '-';
  $('#stLeft').innerHTML = state.pdfDoc
    ? `<span>${state.docName}</span><span>第 ${idx} / ${state.display.length} 页</span><span>${state.elements.length} 处编辑</span>`
    : '';
  let saveEl = $('#stRight .st-save');
  if (!saveEl) {
    saveEl = document.createElement('span');
    saveEl.className = 'st-save';
    $('#stRight').appendChild(saveEl);
    const tip = document.createElement('span');
    tip.textContent = '点击原文文字/图片可直接编辑 · 所有处理均在本地完成';
    $('#stRight').appendChild(tip);
  }
}

export function buildThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  box.classList.remove('hidden');
  $('#sidebarEmpty').classList.add('hidden');
  const cur = currentPagePk();
  state.display.forEach((d, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (d.pk === cur ? ' current' : '');
    t.dataset.pk = d.pk;
    const c = document.createElement('canvas');
    c.width = 148; c.height = Math.round((d.h / d.w) * 148);
    c.getContext('2d').fillStyle = '#fff';
    c.getContext('2d').fillRect(0, 0, c.width, c.height);
    t.appendChild(c);
    const label = document.createElement('div');
    label.className = 'th-label';
    label.textContent = `${i + 1}${d.kind === 'blank' ? ' (空白)' : ''}`;
    t.appendChild(label);
    const menu = document.createElement('button');
    menu.className = 'th-menu';
    menu.textContent = '⋯';
    menu.title = '页面操作';
    menu.addEventListener('click', (e) => { e.stopPropagation(); pageMenu(d.pk); });
    t.appendChild(menu);
    t.addEventListener('click', () => scrollToPage(d.pk));
    box.appendChild(t);
    if (d.kind === 'orig') renderThumb(d, c);
    else { const bl = document.createElement('div'); bl.className = 'th-blank'; bl.style.height = c.height + 'px'; t.replaceChild(bl, c); }
  });
  updateThumbsBadges();
}

async function renderThumb(d, canvas) {
  const info = pdfPageOf(d.pk);
  if (!info) return;
  try {
    const scale = canvas.width / d.w;
    const vp = info.page.getViewport({ scale });
    canvas.height = Math.floor(vp.height);
    await info.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch { /* 忽略缩略图错误 */ }
}

function updateThumbsBadges() {
  document.querySelectorAll('.thumb').forEach((t) => {
    const n = elementsOnPage(t.dataset.pk).length;
    let b = t.querySelector('.th-badge');
    if (n && !b) { b = document.createElement('span'); b.className = 'th-badge'; t.appendChild(b); }
    if (b) b.textContent = n || '';
    if (!n && b) b.remove();
  });
}

async function pageMenu(pk) {
  const n = elementsOnPage(pk).length;
  const action = await menuModal([
    { key: 'blank', label: '➕ 在此后插入空白页' },
    { key: 'del', label: `🗑 删除此页${n ? `（含 ${n} 处编辑）` : ''}`, danger: true },
  ]);
  if (action === 'blank') insertBlankAfter(pk);
  else if (action === 'del') {
    const ok = await confirmModal({ title: `删除第 ${displayIndexOf(pk) + 1} 页？`, body: n ? `该页上的 ${n} 处编辑将一并删除。` : '', okText: '删除' });
    if (ok) deletePage(pk);
  }
}

// ================= 打开文档 =================
export async function openPdfFile(file) {
  const bytes = await file.arrayBuffer();
  await openDoc(bytes, file.name, { fromFile: true });
}

export async function openDoc(bytes, name, { fromFile } = {}) {
  showLoading('正在解析文档…');
  resetDoc();
  try {
    const id = hashBytes(bytes) + '-' + bytes.byteLength;
    let pdfDoc, encrypted = false;
    try {
      const r = await openPdfBytes(bytes);
      pdfDoc = r.pdfDoc; encrypted = r.encrypted;
    } catch (e) {
      hideLoading();
      if (e?.name === 'PasswordException') {
        toast('该文档需要密码，请在弹窗中输入', 'err');
        const pw = await promptModal({ title: '文档已加密', body: '请输入打开密码：', type: 'password' });
        if (pw == null) return;
        showLoading('正在解析文档…');
        const r2 = await openPdfBytes(bytes, { password: pw });
        pdfDoc = r2.pdfDoc; encrypted = true;
      } else throw e;
    }
    state.docId = id; state.docName = name; state.docBytes = bytes;
    state.pdfDoc = pdfDoc; state.encrypted = encrypted;
    readPagesMeta();
    showLoading('正在读取页面…');
    await loadAllPageSizes();

    // 恢复上次的编辑
    let meta = null;
    try { meta = await store.getMeta(id); } catch { /* 忽略 */ }
    if (meta?.edits && (meta.edits.elements?.length || meta.edits.display?.length !== state.display.length)) {
      const ok = await confirmModal({
        title: '发现上次的编辑',
        body: `此文档在 ${fmtTime(meta.updatedAt)} 编辑过（${meta.edits.elements?.length || 0} 处修改）。是否恢复继续编辑？`,
        okText: '恢复编辑', cancelText: '重新开始',
      });
      if (ok) {
        state.elements = meta.edits.elements || [];
        state.consumedRuns = meta.edits.consumedRuns || {};
        if (Array.isArray(meta.edits.display) && meta.edits.display.length) state.display = meta.edits.display;
      }
    }

    docOpened({ id, name, bytes, pdfDoc, encrypted });
    persistBytes();

    $('#welcome').classList.add('hidden');
    initPageObserver();
    buildPageDom();
    renderAllElements();
    buildThumbs();
    updateStatus();
    if (state.display.length === 1) { const z = fitWidthZoom(); if (z < state.zoom) setZoom(z); }
    $('#zoomSelect').value = String(Math.round(state.zoom * 100) / 100);
    toast(`已打开 ${name} · 点击原文文字或图片即可编辑`);
  } catch (e) {
    console.error(e);
    toast('无法打开文档: ' + (e?.message || '文件损坏或格式不支持'), 'err');
  } finally {
    hideLoading();
  }
}

async function openSample() {
  try {
    const r = await fetch('samples/sample.pdf');
    if (!r.ok) throw new Error('示例文档不存在，请先运行 npm run make:sample');
    const bytes = await r.arrayBuffer();
    await openDoc(bytes, 'sample.pdf');
  } catch (e) {
    toast(e.message || '打开示例失败', 'err');
  }
}

// ================= 拖放 / 粘贴 =================
function initDragDrop() {
  const dz = $('#dropZone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) openPdfFile(f);
    else if (f.type.startsWith('image/')) {
      const outer = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-outer');
      if (outer && state.pdfDoc) {
        const pv = getPageView(outer.dataset.pk);
        const r = pv.dom.getBoundingClientRect();
        placeImageFile(f, outer.dataset.pk, { x: (e.clientX - r.left) / state.zoom, y: (e.clientY - r.top) / state.zoom });
      } else toast('请将图片拖到文档页面上', 'err');
    }
  });
  window.addEventListener('paste', async (e) => {
    if (!state.pdfDoc) return;
    // 焦点在输入框/文字编辑中：粘贴交给目标本身处理，不插入图片元素
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      const f = item.getAsFile();
      if (f) { placeImageFile(f); toast('已粘贴图片'); }
    }
  });
}

// ================= 密码 =================
function initPasswordPrompt() {
  on('password-needed', async ({ updatePassword, isRetry }) => {
    const pw = await promptModal({
      title: '文档已加密',
      body: (isRetry ? '密码不正确，请重试：' : '请输入打开密码：'),
      type: 'password',
    });
    updatePassword(pw || '');
  });
}

// ================= 全局快捷键 =================
function initGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#filePdf').click(); }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); exportPdf(); }
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(clamp(state.zoom * 1.25, 0.25, 4)); $('#zoomSelect').value = String(state.zoom); }
    if (ctrl && e.key === '-') { e.preventDefault(); setZoom(clamp(state.zoom / 1.25, 0.25, 4)); $('#zoomSelect').value = String(state.zoom); }
    if (ctrl && e.key === '0') { e.preventDefault(); const z = fitWidthZoom(); setZoom(z); $('#zoomSelect').value = String(z); }
  });
}

// ================= 最近文件 =================
export async function refreshRecents() {
  const box = $('#recentList');
  try {
    const list = await store.listMeta();
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div style="color:#8a939c;font-size:12px;padding:4px 2px">暂无最近文件</div>';
      return;
    }
    list.slice(0, 8).forEach((m) => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      // 文件名来自磁盘，不可拼进 innerHTML（防注入）
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '22'); icon.setAttribute('height', '22');
      icon.style.cssText = 'color:#2563eb;flex:none';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('d', 'M6 2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z');
      icon.appendChild(path);
      const name = document.createElement('span');
      name.className = 'ri-name';
      name.textContent = m.name;
      const meta = document.createElement('span');
      meta.className = 'ri-meta';
      meta.textContent = `${m.elements || 0} 处编辑 · ${fmtTime(m.updatedAt)}`;
      const del = document.createElement('button');
      del.className = 'ri-del';
      del.title = '从最近列表移除';
      del.textContent = '✕';
      item.append(icon, name, meta, del);
      item.addEventListener('click', async (e) => {
        if (e.target.closest('.ri-del')) {
          e.stopPropagation();
          await store.remove(m.id);
          refreshRecents();
          return;
        }
        const rec = await store.getFile(m.id);
        if (!rec?.bytes) { toast('文件数据缺失', 'err'); return; }
        openDoc(rec.bytes, m.name);
      });
      box.appendChild(item);
    });
  } catch { box.innerHTML = ''; }
}

// ================= Toast / 弹窗 / 加载 =================
export function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'err' ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => t.remove(), 2600);
}

export function showLoading(text) {
  $('#ldText').textContent = text || '处理中…';
  $('#loading').classList.remove('hidden');
}
export function hideLoading() { $('#loading').classList.add('hidden'); }

function buildModal({ title, body }) {
  $('#modalRoot').innerHTML = '';
  $('#modalRoot').classList.remove('hidden');
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<h3></h3><div class="md-body"></div><div class="md-row"></div>`;
  m.querySelector('h3').textContent = title || '';
  m.querySelector('.md-body').textContent = body || '';
  $('#modalRoot').appendChild(m);
  return m;
}

export function confirmModal({ title, body, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const m = buildModal({ title, body });
    const row = m.querySelector('.md-row');
    const close = (v) => { $('#modalRoot').classList.add('hidden'); resolve(v); };
    const c = document.createElement('button');
    c.className = 'md-btn'; c.textContent = cancelText;
    c.addEventListener('click', () => close(false));
    const ok = document.createElement('button');
    ok.className = 'md-btn ' + (danger ? 'danger' : 'primary');
    ok.textContent = okText;
    ok.addEventListener('click', () => close(true));
    row.append(c, ok);
    ok.focus();
  });
}

export function promptModal({ title, body, type = 'text', value = '' }) {
  return new Promise((resolve) => {
    const m = buildModal({ title, body });
    const bodyEl = m.querySelector('.md-body');
    const input = document.createElement('input');
    input.type = type;
    input.value = value;
    bodyEl.appendChild(input);
    setTimeout(() => input.focus(), 30);
    const row = m.querySelector('.md-row');
    const close = (v) => { $('#modalRoot').classList.add('hidden'); resolve(v); };
    const c = document.createElement('button');
    c.className = 'md-btn'; c.textContent = '取消';
    c.addEventListener('click', () => close(null));
    const ok = document.createElement('button');
    ok.className = 'md-btn primary'; ok.textContent = '确定';
    ok.addEventListener('click', () => close(input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
    row.append(c, ok);
  });
}

function menuModal(items) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = '';
    root.classList.remove('hidden');
    const m = document.createElement('div');
    m.className = 'modal';
    const close = (v) => { root.classList.add('hidden'); resolve(v); };
    items.forEach((it) => {
      const b = document.createElement('button');
      b.className = 'md-btn';
      b.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:6px;' + (it.danger ? 'color:#d93025;' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => close(it.key));
      m.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.className = 'md-btn';
    cancel.style.cssText = 'display:block;width:100%;text-align:center;';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => close(null));
    m.appendChild(cancel);
    root.appendChild(m);
    root.onmousedown = (e) => { if (e.target === root) close(null); };
  });
}
