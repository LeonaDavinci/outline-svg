/* 回归测试：交汇点被切开的两条分支必须接回成一条。
 *
 * 复现场景（单线兔）：一条连续线在自交叉处被骨架提取拆成两段，
 * 两个自由端相距约 3px，但切线互相背离（都从交汇点向外指）。
 * 旧逻辑：bridgeGaps 的朝向检查直接拒绝 → 输出两段。
 * 期望：兜底焊接生效 → 输出一根连续路径。
 *
 * 用法： node test/weld-crossing-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { console, Math, Date, Map, Set, performance: { now: () => Date.now() } };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of ['js/geom.js', 'js/merge.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const { LineMerge, LineGeom: Geom } = sandbox;

function polyLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Geom.dist(pts[i - 1], pts[i]);
  return s;
}

/* 场景：A 段末端在 (267.5,423.5)（切线朝 +x），B 段起点在 (270.5,423.5)
 * （切线朝右上）。两点相距 3px ≤ gapK·W，但 B 的切线背离 A → 旧逻辑拒焊。 */
const graph = {
  nodes: [],
  edges: [
    { pts: [ {x:200,y:424}, {x:230,y:423.8}, {x:250,y:423.7},
             {x:260,y:424}, {x:265,y:423.6}, {x:267.5,y:423.5} ], a: null, b: null, closed: false },
    { pts: [ {x:270.5,y:423.5}, {x:272,y:423.2}, {x:275,y:422},
             {x:280,y:420}, {x:300,y:380}, {x:340,y:300} ], a: null, b: null, closed: false }
  ]
};

const lenA = polyLen(graph.edges[0].pts);
const lenB = polyLen(graph.edges[1].pts);

const r = LineMerge.weld(graph, {
  width: 1.4, gapK: 2.8, minLenK: 0,
  tMode: 'snap', facing: true, throughJunction: false
});

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failed++;
}

check('输出 1 条连续路径', r.paths.length === 1, '实际 ' + r.paths.length);
if (r.paths.length === 1) {
  const p = r.paths[0];
  const endA = p.pts[0], endB = p.pts[p.pts.length - 1];
  const endsAtOrigins =
    (Geom.dist(endA, {x:200,y:424}) < 2 && Geom.dist(endB, {x:340,y:300}) < 2) ||
    (Geom.dist(endB, {x:200,y:424}) < 2 && Geom.dist(endA, {x:340,y:300}) < 2);
  check('两端保留原始远端', endsAtOrigins);
  // 不允许来回折返：总长不得明显超过 lenA + lenB + 缺口
  check('无折返（长度守恒）', r.stats.totalLength < lenA + lenB + 6,
        '总长 ' + r.stats.totalLength.toFixed(1) + ' vs 上限 ' + (lenA + lenB + 6).toFixed(1));
}

process.exit(failed ? 1 : 0);
