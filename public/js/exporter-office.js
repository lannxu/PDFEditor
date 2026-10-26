// 转存 Word (.docx) / PowerPoint (.pptx)：纯原生实现（ZIP 写入器 + OOXML 组装），零第三方依赖
// - docx：按阅读顺序导出可编辑文字（原文运行 + 文字元素，字号/字重/颜色保留）+ 已放置图片
// - pptx：每页一张幻灯片，整页高清栅格图（视觉 100% 保真）
import { state, emit } from './state.js';
import { getSource, ensureSourceLayer, rasterRegion } from './pdfview.js';
import { hasCJK, download } from './util.js';
import { toast } from './ui.js';

// ================= ZIP（STORE 存储，CRC32） =================
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// files: [name, Uint8Array][]；DOS 时间取固定值 2026-01-01 00:00
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, data] of files) {
    const nb = enc.encode(name);
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0, true);         // flags
    lv.setUint16(8, 0, true);         // method: STORE
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nb, 30);
    parts.push(lh, data);

    const ch = new Uint8Array(46 + nb.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nb, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  let cdSize = 0;
  central.forEach((c) => (cdSize += c.length));
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

// ================= XML 基础 =================
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlBytes = (s) => new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + s);
const hexNo = (hex) => String(hex || '#111111').replace('#', '').slice(0, 6).toUpperCase();

// 开发期校验：XML 不合法立即抛错（防止产出损坏文件）
function checkXml(name, xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(`XML 校验失败: ${name}`);
  }
  return xmlBytes(xmlStr);
}

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

async function dataUrlBytes(dataUrl) {
  return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
}

// ================= Word (.docx) =================
export async function exportDocx() {
  if (!state.pdfDoc) return;
  emit('export-start', '正在生成 Word…');
  try {
    // 保证全部原文层已提取（阅读顺序数据）
    await Promise.all(state.display.map((d) => ensureSourceLayer(d.pk)));

    const files = [];
    const usedImages = []; // { rid, bytes, ext }
    const paragraphs = [];

    for (let pageIdx = 0; pageIdx < state.display.length; pageIdx++) {
      const d = state.display[pageIdx];
      const consumed = new Set(state.consumedRuns[d.pk] || []);
      const items = [];
      // 原文运行（未被涂白覆盖）
      for (const r of getSource(d.pk).runs) {
        if (consumed.has(r.key)) continue;
        items.push({
          kind: 'text', y: r.bbox?.y ?? r.vy, x: r.vx,
          text: r.str, size: r.fs, bold: !!(r.bold || (r.weight || 400) >= 600), italic: !!r.italic, color: '#111111',
        });
      }
      // 文字与图片元素
      for (const el of state.elements) {
        if (el.page !== d.pk) continue;
        if (el.type === 'text' && el.text) {
          items.push({
            kind: 'text', y: el.y, x: el.x, text: el.text, size: el.size,
            bold: !!(el.bold || (el.weight || 400) >= 600), italic: !!el.italic, color: el.color,
          });
        } else if (el.type === 'image' && el.src?.startsWith('data:image/')) {
          items.push({ kind: 'img', y: el.y, x: el.x, src: el.src, w: el.w, h: el.h });
        }
      }
      // 阅读顺序：y 聚簇（8pt）后按 x
      items.sort((a, b) => (Math.round(a.y / 8) - Math.round(b.y / 8)) || (a.x - b.x));

      if (pageIdx > 0) {
        paragraphs.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
      }
      for (const it of items) {
        if (it.kind === 'img') {
          const ext = /^data:image\/jpeg/.test(it.src) ? 'jpeg' : 'png';
          const bytes = await dataUrlBytes(it.src);
          const rid = `rIdImg${usedImages.length + 1}`;
          usedImages.push({ rid, bytes, ext });
          const cx = Math.max(1, Math.round(Math.min(it.w, d.w) * 12700));
          const cy = Math.max(1, Math.round(it.h * (Math.min(it.w, d.w) / it.w) * 12700));
          const picId = usedImages.length;
          paragraphs.push(
            `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
            `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
            `<wp:docPr id="${picId}" name="Picture ${picId}"/>` +
            `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
            `<a:graphic xmlns:a="${A_NS}"><a:graphicData uri="${PIC_NS}">` +
            `<pic:pic xmlns:pic="${PIC_NS}">` +
            `<pic:nvPicPr><pic:cNvPr id="${picId}" name="image${picId}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
            `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
            `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
          );
          continue;
        }
        const halfPt = Math.max(4, Math.round(it.size * 2));
        const rPr =
          `<w:rPr>${it.bold ? '<w:b/>' : ''}${it.italic ? '<w:i/>' : ''}` +
          `${hasCJK(it.text) ? '<w:rFonts w:hint="eastAsia"/>' : ''}` +
          `<w:color w:val="${hexNo(it.color)}"/><w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/></w:rPr>`;
        // 多行文字元素按行拆段
        const lines = String(it.text).split('\n');
        for (let li = 0; li < lines.length; li++) {
          if (!lines[li]) { paragraphs.push('<w:p/>'); continue; }
          paragraphs.push(
            `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>` +
            `<w:r>${rPr}<w:t xml:space="preserve">${esc(lines[li])}</w:t></w:r></w:p>`
          );
        }
      }
    }

    const first = state.display[0] || { w: 595.28, h: 841.89 };
    const pageW = Math.round(first.w * 20), pageH = Math.round(first.h * 20);
    const documentXml =
      `<w:document xmlns:w="${W_NS}" xmlns:wp="${WP_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">` +
      `<w:body>${paragraphs.join('')}` +
      `<w:sectPr><w:pgSz w:w="${pageW}" w:h="${pageH}"/>` +
      `<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>` +
      `</w:body></w:document>`;

    const contentTypes =
      `<?xml?>`.replace('<?xml?>', '') +
      `<Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      (usedImages.some((i) => i.ext === 'png') ? `<Default Extension="png" ContentType="image/png"/>` : '') +
      (usedImages.some((i) => i.ext === 'jpeg') ? `<Default Extension="jpeg" ContentType="image/jpeg"/>` : '') +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`;
    const rootRels =
      `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="word/document.xml"/></Relationships>`;
    const docRels =
      `<Relationships xmlns="${RELS_NS}">` +
      usedImages.map((i) => `<Relationship Id="${i.rid}" Type="${R_NS}/image" Target="media/image${i.rid.replace('rIdImg', '')}.${i.ext}"/>`).join('') +
      `</Relationships>`;

    files.push(['[Content_Types].xml', checkXml('[Content_Types].xml', contentTypes)]);
    files.push(['_rels/.rels', checkXml('_rels/.rels', rootRels)]);
    files.push(['word/document.xml', checkXml('word/document.xml', documentXml)]);
    files.push(['word/_rels/document.xml.rels', checkXml('word/_rels/document.xml.rels', docRels)]);
    usedImages.forEach((i, idx) => files.push([`word/media/image${idx + 1}.${i.ext}`, i.bytes]));

    const base = (state.docName || 'document').replace(/\.pdf$/i, '');
    download(makeZip(files), `${base}.docx`);
    toast(`已导出 ${base}.docx`);
  } catch (e) {
    console.error(e);
    toast('导出 Word 失败: ' + (e.message || e), 'err');
  } finally {
    emit('export-end');
  }
}

// ================= PowerPoint (.pptx) =================
export async function exportPptx() {
  if (!state.pdfDoc) return;
  emit('export-start', '正在生成 PPT…');
  try {
    const files = [];
    const slides = [];
    const first = state.display[0] || { w: 595.28, h: 841.89 };
    const cx = Math.round(first.w * 12700), cy = Math.round(first.h * 12700);

    for (let i = 0; i < state.display.length; i++) {
      const d = state.display[i];
      // 整页栅格（空白页得到白底图）
      const dataUrl = await rasterRegion(d.pk, { x: 0, y: 0, w: d.w, h: d.h }, { type: 'image/png', maxW: 1600 });
      if (!dataUrl) continue;
      const bytes = await dataUrlBytes(dataUrl);
      const isJpeg = false;
      files.push([`ppt/media/slide${i + 1}.png`, bytes]);
      const scx = Math.round(d.w * 12700), scy = Math.round(d.h * 12700);
      const slideXml =
        `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
        `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${scx}" cy="${scy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
        `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
      files.push([`ppt/slides/slide${i + 1}.xml`, checkXml(`slide${i + 1}.xml`, slideXml)]);
      files.push([
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        checkXml(`slide${i + 1}.rels`, `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${R_NS}/image" Target="../media/slide${i + 1}.png"/></Relationships>`),
      ]);
      slides.push(`<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`);
    }

    const presentationXml =
      `<p:presentation xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}" saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slides.join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
    const presRels =
      `<Relationships xmlns="${RELS_NS}">` +
      `<Relationship Id="rId1" Type="${R_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
      slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${R_NS}/slide" Target="slides/slide${i + 1}.xml"/>`).join('') +
      `</Relationships>`;
    const masterRels =
      `<Relationships xmlns="${RELS_NS}">` +
      `<Relationship Id="rId1" Type="${R_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${R_NS}/theme" Target="theme/theme1.xml"/>` +
      `</Relationships>`;
    const layoutRels =
      `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${R_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
    const emptySpTree =
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`;
    const masterXml =
      `<p:sldMaster xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
      `<p:cSld><p:spTree>${emptySpTree}</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
    const layoutXml =
      `<p:sldLayout xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}" type="blank" preserve="1">` +
      `<p:cSld name="Blank"><p:spTree>${emptySpTree}</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
    const themeXml =
      `<a:theme xmlns:a="${A_NS}" name="Office"><a:themeElements>` +
      `<a:clrScheme name="Office">` +
      `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
      `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
      [1, 2, 3, 4, 5, 6].map((n) => `<a:accent${n}><a:srgbClr val="4472C4"/></a:accent${n}>`).join('') +
      `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
      `</a:clrScheme>` +
      `<a:fontScheme name="Office">` +
      `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
      `</a:fontScheme>` +
      `<a:fmtScheme name="Office">` +
      `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
      `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
      `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
      `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
      `</a:fmtScheme></a:themeElements></a:theme>`;

    const contentTypes =
      `<Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
      `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      files
        .filter(([n]) => n.startsWith('ppt/slides/slide') && n.endsWith('.xml'))
        .map(([n]) => `<Override PartName="/${n}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
        .join('') +
      `</Types>`;

    files.unshift(
      ['[Content_Types].xml', checkXml('[Content_Types].xml', contentTypes)],
      ['_rels/.rels', checkXml('_rels/.rels', `<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`)],
      ['ppt/presentation.xml', checkXml('ppt/presentation.xml', presentationXml)],
      ['ppt/_rels/presentation.xml.rels', checkXml('ppt/_rels/presentation.xml.rels', presRels)],
      ['ppt/slideMasters/slideMaster1.xml', checkXml('slideMaster1.xml', masterXml)],
      ['ppt/slideMasters/_rels/slideMaster1.xml.rels', checkXml('slideMaster1.rels', masterRels)],
      ['ppt/slideLayouts/slideLayout1.xml', checkXml('slideLayout1.xml', layoutXml)],
      ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', checkXml('slideLayout1.rels', layoutRels)],
      ['ppt/theme/theme1.xml', checkXml('theme1.xml', themeXml)]
    );

    const base = (state.docName || 'document').replace(/\.pdf$/i, '');
    download(makeZip(files), `${base}.pptx`);
    toast(`已导出 ${base}.pptx`);
  } catch (e) {
    console.error(e);
    toast('导出 PPT 失败: ' + (e.message || e), 'err');
  } finally {
    emit('export-end');
  }
}
