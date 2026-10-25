// 生成示例 PDF：含中文标题/正文/彩色文字/内嵌图片，用于功能验证
// 用法: node scripts/make-sample-pdf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'public', 'samples', 'sample.pdf');
const FONT = path.join(ROOT, 'public', 'assets', 'fonts', 'simhei.ttf');

const imgCandidates = [
  'C:/Windows/Web/Wallpaper/Windows/img0.jpg',
  'C:/Windows/Web/Wallpaper/Theme1/img1.jpg',
  'C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg',
];
const imgPath = imgCandidates.find((p) => fs.existsSync(p));

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(fs.readFileSync(FONT), { subset: true });
const kaiFont = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', 'simkai.ttf')), { subset: true });
const sunFont = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', 'simsun.ttf')), { subset: true });
const yhFont = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', 'msyh.ttf')), { subset: true });
const yhBold = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', 'msyhbd.ttf')), { subset: true });
// Times 以完整嵌入（保留 cmap 表），用于验证"原始字体程序复用"路径
const timesFont = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', 'times.ttf')), { subset: false });
const timesItalic = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', 'ariali.ttf')), { subset: true });
const helv = await doc.embedFont(StandardFonts.Helvetica);
// 英文字体矩阵
const EF = {};
for (const [name, file] of Object.entries({
  calibri: 'calibri.ttf', calibriBold: 'calibrib.ttf', calibriLight: 'calibril.ttf',
  segoe: 'segoeui.ttf', segoeItalic: 'segoeuii.ttf', consolas: 'consola.ttf',
  georgia: 'georgia.ttf', georgiaBold: 'georgiab.ttf', cambria: 'cambria.ttf',
  verdana: 'verdana.ttf', tahoma: 'tahoma.ttf', trebuchet: 'trebuc.ttf', impact: 'impact.ttf',
})) {
  EF[name] = await doc.embedFont(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'fonts', file)), { subset: true });
}

const W = 595.28, H = 841.89;

// ---------- 第 1 页 ----------
{
  const pg = doc.addPage([W, H]);
  pg.drawText('产品技术报告（示例文档）', { x: 60, y: H - 80, size: 22, font, color: rgb(0.1, 0.12, 0.16) });
  pg.drawLine({ start: { x: 60, y: H - 92 }, end: { x: W - 60, y: H - 92 }, thickness: 1.2, color: rgb(0.15, 0.39, 0.92) });

  let y = H - 130;
  const para = (txt, { size = 11, color = rgb(0.13, 0.15, 0.18), x = 60, lh = 20 } = {}) => {
    for (const line of txt.split('\n')) {
      pg.drawText(line, { x, y, size, font, color });
      y -= lh;
    }
  };

  para('一、项目概述');
  para('本文档用于演示 PDF 在线编辑器的各项编辑能力，包括对原始文字的修改、删除，\n对原始图片的替换、剪切与提取，以及添加新的文字、图片和图形批注。');
  y -= 8;
  para('二、关键数据');
  para('版本号：V2.4.1（发布日期：2026-10-20）');
  pg.drawText('本行文字为红色重点内容，可点击编辑替换。', { x: 60, y, size: 12, font, color: rgb(0.85, 0.1, 0.1) });
  y -= 24;
  // 字体识别测试：楷体 / 宋体 / 雅黑 / Times / 斜体 / Helvetica
  pg.drawText('楷体测试行：这句话使用楷体书写。', { x: 60, y, size: 11.5, font: kaiFont, color: rgb(0.1, 0.1, 0.1) });
  y -= 22;
  pg.drawText('宋体测试行：这句话使用宋体书写。', { x: 60, y, size: 11, font: sunFont, color: rgb(0.1, 0.1, 0.1) });
  y -= 22;
  pg.drawText('雅黑测试行：这句话使用微软雅黑书写。', { x: 60, y, size: 11, font: yhFont, color: rgb(0.1, 0.1, 0.1) });
  y -= 22;
  pg.drawText('雅黑粗体行：这句话使用微软雅黑粗体书写。', { x: 60, y, size: 11, font: yhBold, color: rgb(0.1, 0.1, 0.1) });
  y -= 22;
  pg.drawText('Times serif line for font detection.', { x: 60, y, size: 11, font: timesFont, color: rgb(0.1, 0.1, 0.1) });
  y -= 22;
  pg.drawText('Italic style line: slanted text sample.', { x: 60, y, size: 11, font: timesItalic, color: rgb(0.2, 0.2, 0.5) });
  y -= 24;
  para('三、图表示意', { size: 11 });
  y -= 4;

  if (imgPath) {
    const img = await doc.embedJpg(fs.readFileSync(imgPath));
    const iw = 300, ih = iw * (img.height / img.width);
    pg.drawImage(img, { x: 60, y: y - ih, width: iw, height: ih });
    pg.drawText('图 1-1 系统架构示意图（点击可删除 / 替换 / 剪切）', { x: 60, y: y - ih - 16, size: 9, font, color: rgb(0.35, 0.38, 0.42) });
    y = y - ih - 40;
  }
  pg.drawText('English mixed line: Hello PDF Editor 2026!', { x: 60, y, size: 11, font: helv, color: rgb(0.1, 0.3, 0.1) });
  y -= 24;
  pg.drawRectangle({ x: 60, y: y - 60, width: 180, height: 60, borderColor: rgb(0.55, 0.1, 0.1), borderWidth: 1.5, opacity: 0 });
  pg.drawText('表格/边框区域', { x: 70, y: y - 38, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
}

// ---------- 第 2 页 ----------
{
  const pg = doc.addPage([W, H]);
  pg.drawText('附录：编辑说明', { x: 60, y: H - 80, size: 18, font, color: rgb(0.1, 0.12, 0.16) });
  let y = H - 120;
  const lines = [
    '1. 选择工具下，单击原文文字即可选中，支持编辑、删除、复制。',
    '2. 单击原文图片区域，可删除、替换、剪切为可移动图片或提取 PNG。',
    '3. 顶部工具栏可添加：文字、图片、矩形、椭圆、直线、箭头、高亮、涂白、画笔。',
    '4. 涂白覆盖区域上的原有文字会自动重绘，保持文档可读。',
    '5. 编辑完成后点击「导出 PDF」生成新文件，字体将子集化嵌入。',
    '6. 所有处理均在本地浏览器完成，文档不会上传服务器。',
  ];
  for (const l of lines) {
    pg.drawText(l, { x: 60, y, size: 11.5, font, color: rgb(0.13, 0.15, 0.18) });
    y -= 26;
  }
  // 英文字体矩阵
  y -= 8;
  pg.drawText('English font matrix:', { x: 60, y, size: 12, font, color: rgb(0.1, 0.12, 0.16) });
  y -= 20;
  const efLines = [
    ['calibri', 'Calibri: the quick brown fox jumps over 12345.'],
    ['calibriBold', 'Calibri Bold: THE QUICK BROWN FOX 67890.'],
    ['calibriLight', 'Calibri Light: light weight sample text.'],
    ['segoe', 'Segoe UI: Windows interface typeface 24680.'],
    ['segoeItalic', 'Segoe UI Italic: slanted sample line.'],
    ['consolas', 'Consolas: monospaced code font {0x1F};'],
    ['georgia', 'Georgia: serif designed for screens.'],
    ['georgiaBold', 'Georgia Bold: heavy serif headline.'],
    ['cambria', 'Cambria: Office serif typeface sample.'],
    ['verdana', 'Verdana: wide humanist sans-serif.'],
    ['tahoma', 'Tahoma: compact UI sans-serif text.'],
    ['trebuchet', 'Trebuchet MS: friendly web font.'],
    ['impact', 'IMPACT: display headline font.'],
  ];
  for (const [k, s] of efLines) {
    pg.drawText(s, { x: 60, y, size: 10.5, font: EF[k], color: rgb(0.13, 0.15, 0.18) });
    y -= 17;
  }
  // 旋转文字
  pg.drawText('旋转 90° 的原始文字', { x: W - 60, y: H - 420, size: 12, font, color: rgb(0.2, 0.2, 0.6), rotate: degrees(90) });
  // 空白留白区（用于测试新增元素）
  pg.drawText('（下方空白区域用于添加新元素）', { x: 60, y: H - 340, size: 10, font, color: rgb(0.6, 0.6, 0.6) });
  pg.drawRectangle({ x: 60, y: 120, width: W - 120, height: 280, borderColor: rgb(0.8, 0.83, 0.86), borderWidth: 1, borderDashArray: [4, 4], opacity: 0 });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, await doc.save());
console.log(`示例已生成: ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB，图片: ${imgPath ? '已嵌入' : '无'}）`);
