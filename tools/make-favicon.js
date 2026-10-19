/* =============================================================
 * make-favicon.js  —  把线稿 PNG 做成 logo 预览 + favicon 全套
 *
 * 用法：node tools/make-favicon.js 输入.png [输出目录]
 * 产出：favicon.svg / favicon-16.png / favicon-32.png / favicon-48.png
 *      favicon.ico（内嵌 16/32/48）/ logo-preview.png（自检用大图）
 *
 * 关键：不依赖浏览器，直接用提取到的中心线 + 圆头描边做超采样光栅化，
 * 所以小尺寸下不会糊。
 * ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { decodePNG, encodePNG, encodeICO, flattenOnWhite, contentBox } = require('./png-io.js');

const OPT = {
  threshold: 0, prune: 3.4, gap: 2.8, minlen: 3.8, turn: 145,
  eps: 0.06, smooth: 0.9, corner: 55, residual: 1.2,
  color: [0, 0, 0],      // 纯黑
  swScale: 2.0        // 描边加粗倍数（相对估计线宽 W）
};

function loadAlgo() {
  const sandbox = { console, Math, Date, Map, Set, performance: { now: () => Date.now() } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['geom', 'skeleton', 'merge', 'svg'].forEach((m) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', m + '.js'), 'utf8'), sandbox, { filename: m + '.js' });
  });
  return sandbox;
}

let G = null;   // LineGeom，main() 里注入

/* ---------- 超采样光栅化 ---------- */
function rasterize(paths, size, opts) {
  const S = opts.ss || 3;                       // 超采样倍数
  const N = size * S;
  const acc = new Float32Array(N * N);
  const scale = opts.scale, ox = opts.ox, oy = opts.oy;
  const r = opts.radius * scale * S;            // 半径（像素，S 倍空间）
  const r2 = r * r;

  const stamp = (cx, cy) => {
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(N - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(N - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy, dy2 = dy * dy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy2;
        if (d2 <= r2) {
          const i = y * N + x;
          if (acc[i] < 1) acc[i] = 1;
        }
      }
    }
  };

  for (const p of paths) {
    const pts = p.pts;
    for (let i = 0; i < pts.length; i++) {
      const cx = (pts[i].x - opts.bx) * scale * S + ox * S;
      const cy = (pts[i].y - opts.by) * scale * S + oy * S;
      stamp(cx, cy);
      if (i > 0) {                             // 线段之间按 0.5px 步长补点，避免虚线
        const px = (pts[i - 1].x - opts.bx) * scale * S + ox * S;
        const py = (pts[i - 1].y - opts.by) * scale * S + oy * S;
        const d = Math.hypot(cx - px, cy - py);
        const steps = Math.max(1, Math.ceil(d / (0.5 * S)));
        for (let k = 1; k < steps; k++) stamp(px + (cx - px) * k / steps, py + (cy - py) * k / steps);
      }
    }
  }

  // 盒式降采样 + 输出 RGBA
  const out = new Uint8ClampedArray(size * size * 4);
  const inv = 1 / (S * S);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) sum += acc[(y * S + j) * N + (x * S + i)];
      }
      const a = Math.min(1, sum * inv);
      const o = (y * size + x) * 4;
      out[o] = OPT.color[0]; out[o + 1] = OPT.color[1]; out[o + 2] = OPT.color[2];
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function makeSvgDoc(paths, box, color, strokeW, simplify, dec) {
  const pad = strokeW;
  const w = box.w + pad * 2, h = box.h + pad * 2;
  const mul = Math.pow(10, dec || 1);
  const f = (v) => Math.round(v * mul) / mul;
  let d = '';
  for (const p of paths) {
    let pts = p.pts;
    if (simplify > 0) pts = G.simplify(pts, simplify);
    if (pts.length < 2) continue;
    d += 'M' + f(pts[0].x - box.minX + pad) + ',' + f(pts[0].y - box.minY + pad);
    for (let i = 1; i < pts.length; i++) {
      d += 'L' + f(pts[i].x - box.minX + pad) + ',' + f(pts[i].y - box.minY + pad);
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + f(w) + ' ' + f(h) +
    '" width="' + f(w) + '" height="' + f(h) + '" fill="none" stroke="' + color +
    '" stroke-width="' + f(strokeW) + '" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="' + d + '"/></svg>';
}

function main() {
  const inFile = process.argv[2];
  const outDir = process.argv[3] || path.join(ROOT, 'assets');
  if (!inFile) { console.error('用法: node tools/make-favicon.js 输入.png [输出目录]'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });

  const algo = loadAlgo();
  const { Skeleton, LineMerge, LineGeom } = algo;
  G = LineGeom;
  const img = flattenOnWhite(decodePNG(fs.readFileSync(inFile)));
  const box = contentBox(img, 128);

  const sk = Skeleton.build(img, {
    threshold: OPT.threshold, polarity: 'auto', minComponentArea: 4,
    widthOverride: 0, residual: OPT.residual, pruneK: OPT.prune
  });
  const welded = LineMerge.weld(sk.graph, {
    width: sk.width, gapK: OPT.gap, minLenK: OPT.minlen,
    throughJunction: true, maxTurn: OPT.turn, tMode: 'snap', facing: false
  });
  // 供光栅化用的稠密折线（先平滑去台阶）
  const paths = welded.paths.map((p) => ({ pts: LineGeom.smooth(p.pts, 1) }));

  const W = sk.width;
  console.log('内容包围盒', box.w + '×' + box.h, ' 线宽 W =', W.toFixed(2));

  /* ---- favicon.svg（矢量图标：加粗一点，16px 下更清晰）---- */
  const iconPad = W * 0.18;
  const svgIcon = makeSvgDoc(paths, box, '#000000', W * OPT.swScale, W * 0.12, 1);
  fs.writeFileSync(path.join(outDir, 'favicon.svg'), svgIcon, 'utf8');

  /* ---- PNG 与 ICO ---- */
  const icos = [];
  [16, 32, 48].forEach((size) => {
    const inner = size * 0.88;                       // 四周留 6% 边距
    const scale = inner / Math.max(box.w, box.h);
    const bw = box.w * scale, bh = box.h * scale;
    const ox = (size - bw) / 2, oy = (size - bh) / 2;
    // 小尺寸下按比例缩放会让线细到几乎看不见，这里给一个 1.3px 的下限
    const radius = Math.max(W * OPT.swScale / 2, 0.65 / scale);   // 原图单位，下限 1.3px
    const rgba = rasterize(paths, size, {
      ss: size <= 32 ? 6 : 4,
      scale, ox, oy, bx: box.minX, by: box.minY,
      radius: radius
    });
    const png = encodePNG(size, size, rgba);
    fs.writeFileSync(path.join(outDir, 'favicon-' + size + '.png'), png);
    icos.push({ size, png });
    console.log('  favicon-' + size + '.png', png.length, 'B');
  });
  fs.writeFileSync(path.join(outDir, 'favicon.ico'), encodeICO(icos));

  /* ---- 自检大图 ---- */
  const P = 480, ip = P * 0.1;
  const scale = (P - ip * 2) / Math.max(box.w, box.h);
  const rgba = rasterize(paths, P, {
    ss: 3, scale, ox: (P - box.w * scale) / 2, oy: (P - box.h * scale) / 2,
    bx: box.minX, by: box.minY, radius: W * OPT.swScale / 2
  });
  fs.writeFileSync(path.join(outDir, 'logo-preview.png'), encodePNG(P, P, rgba));
  console.log('  logo-preview.png 480×480');
  console.log('完成 ->', outDir);
}

main();