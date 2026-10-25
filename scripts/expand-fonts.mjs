// TTC（TrueType Collection）→ 独立 TTF 抽取：纯 Node 实现，无外部依赖
// 用法: node scripts/expand-fonts.mjs
// 把系统 TTC 字体（宋体/微软雅黑）抽取为可嵌入、可 @font-face 的单 TTF，
// 输出到 public/assets/fonts/，供字体库扩充使用。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'fonts');

const JOBS = [
  { src: 'C:/Windows/Fonts/simsun.ttc', fontNumber: 0, out: 'simsun.ttf', label: '宋体' },
  { src: 'C:/Windows/Fonts/msyh.ttc', fontNumber: 0, out: 'msyh.ttf', label: '微软雅黑' },
  { src: 'C:/Windows/Fonts/msyhbd.ttc', fontNumber: 0, out: 'msyhbd.ttf', label: '微软雅黑 粗体' },
  { src: 'C:/Windows/Fonts/cambria.ttc', fontNumber: 0, out: 'cambria.ttf', label: 'Cambria' },
];

function extractTTC(buf, fontNumber) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = buf.toString('latin1', 0, 4);
  if (tag !== 'ttcf') throw new Error('不是 TTC 文件');
  const numFonts = dv.getUint32(8);
  if (fontNumber >= numFonts) throw new Error(`字体序号越界（共 ${numFonts} 个）`);
  const fontOffset = dv.getUint32(12 + fontNumber * 4);

  // 该字体的 sfnt 表目录
  const sfntVersion = dv.getUint32(fontOffset);
  const numTables = dv.getUint16(fontOffset + 4);
  const records = [];
  for (let i = 0; i < numTables; i++) {
    const p = fontOffset + 12 + i * 16;
    const tagBytes = buf.subarray(p, p + 4);
    records.push({
      tag: String.fromCharCode(...tagBytes),
      checkSum: dv.getUint32(p + 4),
      offset: dv.getUint32(p + 8), // TTC 中为绝对偏移
      length: dv.getUint32(p + 12),
    });
  }

  // 组装独立 TTF：新文件头 + 表目录 + 表数据（4 字节对齐）
  const headerSize = 12 + 16 * numTables;
  let dataOffset = headerSize;
  const layout = records.map((r) => {
    const rec = { ...r, newOffset: dataOffset };
    dataOffset += (r.length + 3) & ~3; // 对齐
    return rec;
  });
  const total = dataOffset;
  const out = Buffer.alloc(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, sfntVersion);
  odv.setUint16(4, numTables);
  // searchRange / entrySelector / rangeShift 按标准公式重算
  let maxPow2 = 1, search = 16;
  while (search * 2 <= numTables * 16) { search *= 2; maxPow2 *= 2; }
  odv.setUint16(6, search);
  odv.setUint16(8, Math.log2(maxPow2));
  odv.setUint16(10, numTables * 16 - search);
  layout.forEach((r, i) => {
    const p = 12 + i * 16;
    out.write(r.tag, p, 'latin1');
    odv.setUint32(p + 4, r.checkSum);
    odv.setUint32(p + 8, r.newOffset);
    odv.setUint32(p + 12, r.length);
    buf.copy(out, r.newOffset, r.offset, r.offset + r.length);
  });

  // 重算 head.checkSumAdjustment（整文件 uint32 求模和应为 0xB1B0AFBA）
  const head = layout.find((r) => r.tag === 'head');
  if (head) {
    const adjPos = head.newOffset + 8;
    odv.setUint32(adjPos, 0);
    let sum = 0;
    for (let i = 0; i < total; i += 4) sum = (sum + odv.getUint32(i)) >>> 0;
    odv.setUint32(adjPos, (0xb1b0afba - sum) >>> 0);
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const job of JOBS) {
  try {
    if (!fs.existsSync(job.src)) { console.log(`跳过（不存在）: ${job.src}`); continue; }
    const buf = fs.readFileSync(job.src);
    const ttf = extractTTC(buf, job.fontNumber);
    const outPath = path.join(OUT_DIR, job.out);
    fs.writeFileSync(outPath, ttf);
    console.log(`已抽取 ${job.label}: ${job.out}（${(ttf.length / 1024 / 1024).toFixed(1)} MB）`);
  } catch (e) {
    console.error(`失败 ${job.label}: ${e.message}`);
  }
}
