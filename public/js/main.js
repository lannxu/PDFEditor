// 入口：初始化各模块
import { initFonts } from './fonts.js';
import { initUi } from './ui.js';
import { initInteractions, initKeyboard } from './interactions.js';
import { on, state } from './state.js';
import * as pdfview from './pdfview.js';
import * as elements from './elements.js';
import * as ui from './ui.js';
import * as propsbar from './propsbar.js';
import * as origfonts from './origfonts.js';
import * as exporter from './exporter.js';
import { updateHandles } from './handles.js';

(async function main() {
  await initFonts();
  initUi();
  initInteractions();
  initKeyboard();

  on('zoom-changed', () => applyZoom());
  on('restored', () => updateHandles());

  // 调试与自动化测试入口
  window.__app = { state, pdfview, elements, exportPdf: exporter.exportPdf, exporter, ui, propsbar, origfonts };

  console.log('%cPDF 编辑器已就绪', 'color:#2563eb;font-weight:bold');
})();
