// 上下文属性栏：随选中元素 / 当前工具变化
import { state, on, getElement, updateElement, snapshot, commit, removeElement } from './state.js';
import { renderElement, bringForward, sendBackward, elementDom } from './elements.js';
import { families, getFamily } from './fonts.js';
import { enterTextEdit, duplicateElement } from './interactions.js';
import { toast } from './ui.js';

const bar = () => document.getElementById('propsBar');

on('selection-changed', renderPropsBar);
on('tool-changed', renderPropsBar);
on('element-updated', ({ live } = {}) => { if (!live) renderPropsBar(); });

function el() {
  const sel = state.selection;
  return sel?.type === 'element' ? getElement(sel.id) : null;
}
// 目标：选中元素，或当前工具的默认值
function target() {
  const e = el();
  if (e) return { kind: 'element', e, props: e };
  if (state.defaults[state.tool]) return { kind: 'default', e: null, props: state.defaults[state.tool] };
  return null;
}

function apply(patch, { live = false } = {}) {
  const t = target();
  if (!t) return;
  Object.assign(t.props, patch);
  if (t.kind === 'element') {
    // 字体/字号变化：逐项字距比例与原始字体程序随之失效
    if (t.e.type === 'text') {
      if (patch.fontId) t.e.customFont = null;
      if (patch.fontId || patch.size) t.e.adv = null;
    }
    renderElement(t.e);
    if (!live) { snapshot(); commit('props'); } // 后置快照
  } else {
    renderPropsBar(); // 默认值即时回显
  }
}

// ---------- 控件 ----------
function group(...children) {
  const g = document.createElement('span');
  g.className = 'pb-group';
  children.forEach((c) => c && g.appendChild(c));
  return g;
}
function label(text) {
  const s = document.createElement('span');
  s.className = 'pb-label';
  s.textContent = text;
  return s;
}
function sep() { const s = document.createElement('span'); s.className = 'pb-sep'; return s; }

function colorCtl(val, title, onLive, onCommit) {
  const i = document.createElement('input');
  i.type = 'color';
  i.value = val || '#000000';
  i.title = title;
  i.addEventListener('input', () => onLive(i.value));
  i.addEventListener('change', () => onCommit(i.value));
  return i;
}
function numCtl(val, { min = 0, max = 400, step = 1, title = '', onChange }) {
  const i = document.createElement('input');
  i.type = 'number';
  i.value = val;
  i.min = min; i.max = max; i.step = step;
  i.title = title;
  i.addEventListener('change', () => onChange(Number(i.value)));
  return i;
}
function rangeCtl(val, { min = 0, max = 1, step = 0.05, title = '', onLive, onCommit }) {
  const i = document.createElement('input');
  i.type = 'range';
  i.value = val; i.min = min; i.max = max; i.step = step;
  i.title = title;
  i.addEventListener('input', () => onLive(Number(i.value)));
  i.addEventListener('change', () => onCommit(Number(i.value)));
  return i;
}
function selectCtl(val, options, onChange) {
  const s = document.createElement('select');
  options.forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    s.appendChild(o);
  });
  s.value = val;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function btn(text, { title = '', onClick, toggle = false, on = false, danger = false, keepFocus = false } = {}) {
  const b = document.createElement('button');
  b.className = 'pb-btn' + (on ? ' on' : '') + (danger ? ' danger' : '');
  b.textContent = text;
  b.title = title;
  if (keepFocus) b.addEventListener('pointerdown', (e) => e.preventDefault()); // 不抢走文字编辑焦点
  b.addEventListener('click', onClick);
  return b;
}

// ---------- 主渲染 ----------
export function renderPropsBar() {
  const root = bar();
  root.innerHTML = '';
  root.classList.add('hidden');
  const t = target();
  if (!t) return;
  const p = t.props;
  const isEl = t.kind === 'element';
  root.classList.remove('hidden');

  const title = document.createElement('span');
  title.className = 'pb-title';
  const names = {
    text: '文字', image: '图片', rect: '矩形', ellipse: '椭圆', line: '直线',
    arrow: '箭头', highlight: '高亮', whiteout: '涂白', ink: '画笔',
  };
  title.textContent = isEl ? names[p.type] || '' : `${names[state.tool] || state.tool} · 默认`;
  root.appendChild(title);
  root.appendChild(sep());

  switch (p.type) {
    case 'text': {
      root.appendChild(group(label('字体'),
        selectCtl(p.fontId, families().map((f) => [f.id, f.name]), (v) => apply({ fontId: v }))));
      root.appendChild(group(label('字号'),
        numCtl(p.size, { min: 4, max: 200, step: 0.5, title: '字号 (pt)', onChange: (v) => apply({ size: Math.max(4, v) }) })));
      root.appendChild(group(
        btn('B', {
          title: '粗体', on: !!p.bold, keepFocus: true, onClick: () => {
            // 同步更新字重：开启取 ≥700（保留 Black 900），关闭恢复 400
            const next = !p.bold;
            apply({ bold: next, weight: next ? Math.max(p.weight || 400, 700) : 400 });
          },
        }),
        btn('I', { title: '斜体', on: !!p.italic, keepFocus: true, onClick: () => apply({ italic: !p.italic }) })));
      root.appendChild(group(label('颜色'),
        colorCtl(p.color, '文字颜色', (v) => apply({ color: v }, { live: true }), (v) => apply({ color: v }))));
      root.appendChild(group(
        btn('⯇', { title: '左对齐', on: p.align === 'left', keepFocus: true, onClick: () => apply({ align: 'left' }) }),
        btn('≡', { title: '居中', on: p.align === 'center', keepFocus: true, onClick: () => apply({ align: 'center' }) }),
        btn('⯈', { title: '右对齐', on: p.align === 'right', keepFocus: true, onClick: () => apply({ align: 'right' }) })));
      root.appendChild(group(label('行高'),
        rangeCtl(p.lh, { min: 1, max: 2.4, step: 0.05, title: '行距倍数', onLive: (v) => apply({ lh: v }, { live: true }), onCommit: (v) => apply({ lh: v }) })));
      if (isEl) {
        root.appendChild(group(
          btn('层级▲', { title: '上移一层', onClick: () => { bringForward(p.id); snapshot(); commit('z'); } }),
          btn('层级▼', { title: '下移一层', onClick: () => { sendBackward(p.id); snapshot(); commit('z'); } })));
      }
      break;
    }
    case 'image': {
      root.appendChild(group(label('不透明度'),
        rangeCtl(p.opacity ?? 1, { min: 0.1, max: 1, step: 0.05, title: '不透明度', onLive: (v) => apply({ opacity: v }, { live: true }), onCommit: (v) => apply({ opacity: v }) })));
      if (isEl) {
        root.appendChild(group(
          btn('重置比例', {
            title: '按原始比例缩放', onClick: () => {
              const s = Math.max(p.w / p.natW, p.h / p.natH);
              updateElement(p.id, { w: p.natW * s, h: p.natH * s });
              renderElement(p);
              snapshot();
              commit('reset-ratio');
            }
          })));
        root.appendChild(group(
          btn('层级▲', { title: '上移一层', onClick: () => { bringForward(p.id); snapshot(); commit('z'); } }),
          btn('层级▼', { title: '下移一层', onClick: () => { sendBackward(p.id); snapshot(); commit('z'); } })));
      }
      break;
    }
    case 'rect':
    case 'ellipse': {
      root.appendChild(group(label('描边'),
        colorCtl(p.stroke, '描边颜色', (v) => apply({ stroke: v }, { live: true }), (v) => apply({ stroke: v }))));
      root.appendChild(group(label('粗细'),
        numCtl(p.strokeWidth, { min: 0.25, max: 24, step: 0.25, title: '描边宽度 (pt)', onChange: (v) => apply({ strokeWidth: Math.max(0.25, v) }) })));
      root.appendChild(group(label('填充'),
        btn('无', { title: '无填充', on: p.fill === 'none', onClick: () => apply({ fill: 'none' }) }),
        colorCtl(p.fill === 'none' ? '#ffffff' : p.fill, '填充颜色', (v) => apply({ fill: v }, { live: true }), (v) => apply({ fill: v }))));
      root.appendChild(group(label('不透明度'),
        rangeCtl(p.opacity ?? 1, { min: 0.1, max: 1, step: 0.05, onLive: (v) => apply({ opacity: v }, { live: true }), onCommit: (v) => apply({ opacity: v }) })));
      if (isEl) appendCommon(root, p);
      break;
    }
    case 'line':
    case 'arrow':
    case 'ink': {
      root.appendChild(group(label('颜色'),
        colorCtl(p.stroke, '线条颜色', (v) => apply({ stroke: v }, { live: true }), (v) => apply({ stroke: v }))));
      root.appendChild(group(label('粗细'),
        numCtl(p.strokeWidth, { min: 0.25, max: 24, step: 0.25, title: '线宽 (pt)', onChange: (v) => apply({ strokeWidth: Math.max(0.25, v) }) })));
      if (isEl) appendCommon(root, p);
      break;
    }
    case 'highlight': {
      root.appendChild(group(label('颜色'),
        colorCtl(p.color, '高亮颜色', (v) => apply({ color: v }, { live: true }), (v) => apply({ color: v }))));
      root.appendChild(group(label('不透明度'),
        rangeCtl(p.opacity ?? 0.45, { min: 0.1, max: 1, step: 0.05, onLive: (v) => apply({ opacity: v }, { live: true }), onCommit: (v) => apply({ opacity: v }) })));
      if (isEl) appendCommon(root, p);
      break;
    }
    case 'whiteout': {
      root.appendChild(group(label('颜色'),
        colorCtl(p.color || '#ffffff', '覆盖颜色（默认白色）', (v) => apply({ color: v }, { live: true }), (v) => apply({ color: v }))));
      if (isEl) appendCommon(root, p);
      break;
    }
    default: break;
  }

  if (isEl) {
    root.appendChild(sep());
    const tail = [];
    if (p.type === 'text') {
      tail.push(btn('编辑文字', {
        title: '编辑文字内容', onClick: () => {
          const e = getElement(p.id);
          if (e && e.type === 'text') enterTextEdit(e);
        },
      }));
    }
    tail.push(
      btn('复制', { title: '复制元素 (Ctrl+D)', onClick: () => duplicateElement(p.id) }),
      btn('删除', { title: '删除 (Del)', danger: true, onClick: () => removeElement(p.id) }));
    root.appendChild(group(...tail));
  }
}

function appendCommon(root, p) {
  root.appendChild(group(
    btn('层级▲', { title: '上移一层', onClick: () => { bringForward(p.id); snapshot(); commit('z'); } }),
    btn('层级▼', { title: '下移一层', onClick: () => { sendBackward(p.id); snapshot(); commit('z'); } }),
    btn('复制', { title: '复制元素', onClick: () => duplicateElement(p.id) }),
    btn('删除', { title: '删除', danger: true, onClick: () => removeElement(p.id) })));
}
