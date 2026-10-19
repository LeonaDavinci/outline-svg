/* Node 端最小验证：不依赖浏览器，直接跑算法核心。
 * 用法： node test/run-node-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { console, performance: { now: () => Date.now() }, Math, Date, Map, Set };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['js/geom.js', 'js/skeleton.js', 'js/merge.js', 'js/svg.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}

const { Skeleton, LineMerge, SvgBuilder } = sandbox;

/* ---------- 合成一张均匀线宽线稿 ---------- */
const W = 420, H = 320, LW = 5;
const data = new Uint8ClampedArray(W * H * 4).fill(255);

function ink(px, py, v) {
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const i = (py * W + px) * 4;
  data[i] = data[i + 1] = data[i + 2] = v;
}
function stroke(x1, y1, x2, y2) {
  const half = LW / 2;
  const minx = Math.floor(Math.min(x1, x2) - half - 1);
  const maxx = Math.ceil(Math.max(x1, x2) + half + 1);
  const miny = Math.floor(Math.min(y1, y2) - half - 1);
  const maxy = Math.ceil(Math.max(y1, y2) + half + 1);
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      let t = ((x - x1) * dx + (y - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + dx * t, py = y1 + dy * t;
      const d = Math.hypot(x - px, y - py);
      // 按覆盖率生成连续灰度，模拟真实抗锯齿
      const cov = Math.max(0, Math.min(1, half + 0.5 - d));
      if (cov > 0) {
        const v = Math.round(255 * (1 - cov));
        const i = (y * W + x) * 4;
        const old = data[i];
        const nv = Math.min(old, v);   // 多条线叠加取更黑的
        data[i] = data[i + 1] = data[i + 2] = nv;
      }
    }
  }
}

// 方框
stroke(40, 40, 190, 40); stroke(190, 40, 190, 150);
stroke(190, 150, 40, 150); stroke(40, 150, 40, 40);
// 十字（穿过方框）
stroke(15, 100, 380, 100);
stroke(110, 20, 110, 290);
// T 型
stroke(250, 60, 370, 60);
stroke(310, 60, 310, 200);
// 缺口（应被焊接）
stroke(250, 230, 290, 250);
stroke(300, 255, 350, 272);

const imgData = { width: W, height: H, data };

/* ---------- 跑流水线 ---------- */
const t0 = Date.now();
const sk = Skeleton.build(imgData, {
  threshold: 0, polarity: 'auto', minComponentArea: 4,
  widthOverride: 0, residual: 1.2, pruneK: 1.2
});
const t1 = Date.now();
const welded = LineMerge.weld(sk.graph, {
  width: sk.width, gapK: 1.0, minLenK: 1.0, throughJunction: true, maxTurn: 45, tMode: 'weld', facing: true
});
const t2 = Date.now();
const eps = Math.max(0.25, 0.06 * sk.width);
const out = SvgBuilder.build(welded.paths, {
  w: sk.w, h: sk.h, eps, smooth: 0.9, cornerDeg: 55,
  strokeWidth: +sk.width.toFixed(2), color: '#111', padding: 4, decimals: 2, singlePath: false
});
const t3 = Date.now();

console.log('--- 结果 -------------------------------------------------');
console.log('图像            :', W + '×' + H, '真实线宽', LW);
console.log('Otsu 阈值       :', sk.threshold);
console.log('估计线宽 W      :', sk.width.toFixed(2), ' 误差', (sk.width - LW).toFixed(2));
console.log('线宽 p10/p90    :', sk.widthStats.p10.toFixed(2), '/', sk.widthStats.p90.toFixed(2),
  sk.widthStats.uniform ? '(均匀)' : '(不均匀)');
console.log('骨架像素        :', sk.centerCount);
console.log('节点 / 边       :', sk.graph.nodes.length, '/', welded.stats.input);
console.log('过节点合并后    :', welded.stats.afterJoin);
console.log('缺口焊接后      :', welded.stats.afterBridge);
console.log('T 型焊接后      :', welded.stats.afterAttach);
console.log('最终路径        :', welded.stats.output, '  SVG path', out.pathCount);
console.log('总长度          :', welded.stats.totalLength.toFixed(1), 'px');
console.log('耗时(骨架/焊接) :', t1 - t0, '/', t2 - t1, 'ms');
console.log('SVG 字节        :', out.svg.length);
console.log('SVG 头          :', out.svg.slice(0, 160).replace(/\n/g, ' '));

/* ---------- 断言 ---------- */
const fail = [];
if (Math.abs(sk.width - LW) > 1.2) fail.push(`线宽估计偏差过大: ${sk.width.toFixed(2)} vs ${LW}`);
if (welded.stats.output < 3) fail.push('路径数过少，可能被误合并');
if (welded.stats.output > 30) fail.push(`路径数过多 (${welded.stats.output})，合并/焊接失效`);
if (out.pathCount < 3) fail.push('SVG path 数量异常');
if (!/^<svg[\s\S]*<\/svg>$/.test(out.svg.trim())) fail.push('SVG 结构异常');
if (/NaN|Infinity|undefined/.test(out.svg)) fail.push('SVG 中含 NaN/Infinity/undefined');

if (fail.length) {
  console.error('\n[FAIL]');
  fail.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('\n[PASS] 全部检查通过');
