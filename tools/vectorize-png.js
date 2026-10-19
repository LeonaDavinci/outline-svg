/* =============================================================
 * vectorize-png.js  —  命令行版：PNG 线稿 → SVG 矢量
 *
 * 用法：
 *   node tools/vectorize-png.js 输入.png [输出.svg] [选项]
 *
 * 选项：
 *   --threshold=128        二值化阈值（0 = 自动 Otsu）
 *   --prune=3.4            剪枝长度系数（×线宽）
 *   --gap=2.8              焊接间隙系数（×线宽）
 *   --minlen=3.8           短线段清理系数（×线宽）
 *   --turn=145             最大允许拐角（度）
 *   --eps=0.06             简化精度系数（×线宽）
 *   --smooth=0.9           曲线平滑
 *   --corner=55            尖角判定（度）
 *   --width=0              手动指定线宽，0 = 自动
 *   --color=#111111        描边颜色
 *   --crop                 自动裁剪到内容包围盒
 *   --pad=8                裁剪时四周留白
 *   --stats                打印统计
 *
 * 例：
 *   node tools/vectorize-png.js logo.png assets/logo.svg --crop --stats
 * ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { decodePNG, flattenOnWhite } = require('./png-io.js');

/* 把浏览器端的算法模块加载到 Node 里 */
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

function parseArgs(argv) {
  const opt = {
    threshold: 0, prune: 3.4, gap: 2.8, minlen: 3.8, turn: 145,
    eps: 0.06, smooth: 0.9, corner: 55, width: 0, residual: 1.2,
    color: '#111111', crop: false, pad: 8, stats: false
  };
  const pos = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (k === 'crop') opt.crop = true;
      else if (k === 'stats') opt.stats = true;
      else if (k in opt) opt[k] = Number.isNaN(Number(v)) ? v : Number(v);
    } else pos.push(a);
  }
  return { opt, pos };
}

function main() {
  const { opt, pos } = parseArgs(process.argv.slice(2));
  if (!pos.length) {
    console.error('用法: node tools/vectorize-png.js 输入.png [输出.svg] [--crop] [--stats]');
    process.exit(1);
  }
  const inFile = pos[0];
  const outFile = pos[1] || inFile.replace(/\.png$/i, '') + '.svg';

  const algo = loadAlgo();
  const { Skeleton, LineMerge, SvgBuilder } = algo;

  const img = flattenOnWhite(decodePNG(fs.readFileSync(inFile)));
  const sk = Skeleton.build(img, {
    threshold: opt.threshold, polarity: 'auto', minComponentArea: 4,
    widthOverride: opt.width, residual: opt.residual, pruneK: opt.prune
  });
  const welded = LineMerge.weld(sk.graph, {
    width: sk.width, gapK: opt.gap, minLenK: opt.minlen,
    throughJunction: true, maxTurn: opt.turn, tMode: 'snap', facing: false
  });

  let ox = 0, oy = 0, w = sk.w, h = sk.h;
  if (opt.crop) {
    const { contentBox } = require('./png-io.js');
    const box = contentBox(img, 128);
    const pad = opt.pad;
    ox = box.minX - pad; oy = box.minY - pad;
    w = box.w + pad * 2; h = box.h + pad * 2;
  }

  const eps = Math.max(0.25, opt.eps * sk.width);
  const out = SvgBuilder.build(welded.paths, {
    w, h, eps, smooth: opt.smooth, cornerDeg: opt.corner,
    strokeWidth: +sk.width.toFixed(2), color: opt.color,
    padding: opt.crop ? 0 : 4, decimals: 2, singlePath: true, cuspCorner: true
  });

  // 裁剪时把 d 整体平移，使内容居中
  let svg = out.svg;
  if (opt.crop && (ox || oy)) {
    svg = svg.replace(/ d="([^"]*)"/, (_, d) => ' d="' + translateD(d, -ox, -oy) + '"');
  }
  fs.writeFileSync(outFile, svg, 'utf8');

  if (opt.stats) {
    console.log('线宽 W      :', sk.width.toFixed(2), 'px  (p10', sk.widthStats.p10.toFixed(2), '/ p90', sk.widthStats.p90.toFixed(2) + ')');
    console.log('图节点 / 边 :', sk.graph.nodes.length, '/', welded.stats.input);
    console.log('最终段数    :', out.pathCount, ' 子路径(M):', out.subpaths);
    console.log('总长度      :', welded.stats.totalLength.toFixed(0), 'px');
    console.log('输出        :', outFile, out.svg.length, 'B');
  } else {
    console.log(outFile, '(' + out.pathCount + ' 段,', out.svg.length + ' B)');
  }
}

function translateD(d, dx, dy) {
  return d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) =>
    (Math.round((parseFloat(x) + dx) * 1000) / 1000) + ',' + (Math.round((parseFloat(y) + dy) * 1000) / 1000));
}

main();