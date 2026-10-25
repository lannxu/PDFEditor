// 选中元素的手柄层（px 坐标，不随 zoom 缩放）
import { state, on, getElement } from './state.js';
import { getPageView } from './pdfview.js';
import { rotPt } from './util.js';

const HD_LIST = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function updateHandles() {
  document.querySelectorAll('.handles-layer').forEach((l) => (l.innerHTML = ''));
  const sel = state.selection;
  if (!sel || sel.type !== 'element' || state.editingTextId) return;
  const el = getElement(sel.id);
  if (!el) return;
  const pv = getPageView(el.page);
  if (!pv) return;
  const z = state.zoom;

  const layer = pv.handles;
  const box = document.createElement('div');
  box.className = 'handles-box';
  const cx = (el.x + el.w / 2) * z, cy = (el.y + el.h / 2) * z;
  box.style.left = el.x * z + 'px';
  box.style.top = el.y * z + 'px';
  box.style.width = el.w * z + 'px';
  box.style.height = el.h * z + 'px';
  if (el.rot) {
    box.style.transformOrigin = '50% 50%';
    box.style.transform = `rotate(${el.rot}deg)`;
  }
  box.style.border = '1.2px solid #2563eb';

  const isLine = el.type === 'line' || el.type === 'arrow';
  if (isLine) {
    // 端点手柄
    const pts = el.pts || [{ x: 0, y: 0 }, { x: el.w, y: el.h }];
    const center = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    pts.forEach((p, i) => {
      const wp = rotPt({ x: el.x + p.x, y: el.y + p.y }, center, el.rot || 0);
      const hd = document.createElement('div');
      hd.className = 'hd hd-dot';
      hd.dataset.hd = i === 0 ? 'p1' : 'p2';
      hd.style.left = wp.x * z - 5 + 'px';
      hd.style.top = wp.y * z - 5 + 'px';
      box.appendChild(hd);
    });
  } else {
    // 文本仅左右两个手柄（调宽度，高度随内容自适应）
    const handlesFor = el.type === 'text' ? ['e', 'w'] : HD_LIST;
    for (const h of handlesFor) {
      const hd = document.createElement('div');
      hd.className = 'hd hd-' + h;
      hd.dataset.hd = h;
      const sz = 9;
      const pos = {
        nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50],
        se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50],
      }[h];
      hd.style.left = `calc(${pos[0]}% - ${sz / 2}px)`;
      hd.style.top = `calc(${pos[1]}% - ${sz / 2}px)`;
      box.appendChild(hd);
    }
    if (el.type !== 'text') {
      const rot = document.createElement('div');
      rot.className = 'hd-rotate';
      rot.dataset.hd = 'rot';
      rot.style.left = '50%';
      rot.style.top = '-26px';
      box.appendChild(rot);
    }
  }
  layer.appendChild(box);
}

on('selection-changed', updateHandles);
on('element-updated', () => updateHandles());
on('zoom-changed', () => updateHandles());
on('tool-changed', updateHandles);
