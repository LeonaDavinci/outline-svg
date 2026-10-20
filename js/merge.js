/* =============================================================
 * merge.js  —  合并 + 焊接算法（图 → 折线路径）
 *
 * 四个阶段：
 *   A. 过节点合并
 *      - 度为 2 的节点：无条件并成一条（保留拐角）
 *      - 度 >= 3 的节点（交叉/T 型）：按「方向连续性」两两配对，
 *        最接近直线的两条边并成一条 —— 消除交叉处的断点与硬折
 *   B. 缺口焊接：两个悬空端点距离 <= k·W 时接上；朝向不匹配但贴得很近的
 *      （交叉处被切开的分支）作为低优先级兜底，同样接回
 *   C. T 型焊接：端点贴到别的线段上
 *      - 端点贴着目标「端点」时：同一交汇点的两条分支，直接对接成一条
 *      - weld：切分被贴的线，与更顺的一侧接成连续路径（真正焊死）
 *      - snap：只把端点吸附到投影点（几何零损失，路径数不膨胀）
 *   D. 去重 + 短段过滤
 *
 * 所有阈值都以「估计线宽 W」为单位，粗线图自动放宽、细线图自动收紧。
 * ============================================================= */
(function (global) {
  'use strict';

  var Geom = global.LineGeom;
  var Merge = {};

  var FREE = null;       // 悬空端
  var ATTACHED = -1;     // 已焊接/已吸附，不再作为候选

  /* ---------- 工具 ---------- */
  function push(map, key, val) {
    var arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(val);
  }

  function buildIncidence(paths) {
    var m = new Map();
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p.dead) continue;
      if (p.a != null && p.a !== ATTACHED) push(m, p.a, { pi: i, end: 'a' });
      if (p.b != null && p.b !== ATTACHED) push(m, p.b, { pi: i, end: 'b' });
    }
    return m;
  }

  function orientedToNode(path, end) {
    // 返回终点落在节点上的点序列
    return end === 'b' ? path.pts.slice() : path.pts.slice().reverse();
  }

  function otherEnd(path, end) {
    return end === 'a' ? (path.b === undefined ? null : path.b) : (path.a === undefined ? null : path.a);
  }

  /** 把两条在节点处相接的路径并成一条 */
  function joinPair(paths, i1, i2) {
    var p1 = paths[i1.pi], p2 = paths[i2.pi];
    if (!p1 || !p2 || p1.dead || p2.dead || i1.pi === i2.pi) return false;

    var A = orientedToNode(p1, i1.end);            // 末端 = 节点
    var B = orientedToNode(p2, i2.end).reverse();  // 首端 = 节点
    var pts = A.slice();
    for (var i = 0; i < B.length; i++) {
      if (Geom.dist(pts[pts.length - 1], B[i]) < 1e-6) continue;
      pts.push(B[i]);
    }
    if (pts.length < 2) return false;

    var a = otherEnd(p1, i1.end);
    var b = otherEnd(p2, i2.end);
    p1.dead = true; p2.dead = true;
    paths.push({ pts: pts, a: a, b: b, dead: false });
    return true;
  }

  /**
   * 把「度为 1 的节点」上的端点标记为悬空，
   * 这样后面 B/C 阶段只处理真正的自由端。
   */
  function normalizeEnds(paths) {
    var inc = buildIncidence(paths);
    var deg = new Map();
    inc.forEach(function (v, k) { deg.set(k, v.length); });
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p.dead) continue;
      if (p.a != null && p.a !== ATTACHED) {
        var da = deg.get(p.a) || 0;
        if (da <= 1) p.a = FREE;
      }
      if (p.b != null && p.b !== ATTACHED) {
        var db = deg.get(p.b) || 0;
        if (db <= 1) p.b = FREE;
      }
    }
  }

  /* ---------- A. 过节点合并 ---------- */
  function joinThroughNodes(paths, maxTurnDeg) {
    var cosCap = -Math.cos(maxTurnDeg * Math.PI / 180);
    var guard = 0;
    while (guard++ < 6000) {
      var inc = buildIncidence(paths);
      var acted = false;

      // A1：度为 2 的节点必须合并（这是同一条线被切成两段）
      inc.forEach(function (list) {
        if (acted || list.length !== 2) return;
        if (list[0].pi === list[1].pi) return;
        if (joinPair(paths, list[0], list[1])) acted = true;
      });
      if (acted) continue;

      // A2：度 >= 3，找最「直」的一对，逐对合并
      inc.forEach(function (list) {
        if (acted || list.length < 3) return;
        var best = null;
        for (var i = 0; i < list.length; i++) {
          for (var j = i + 1; j < list.length; j++) {
            if (list[i].pi === list[j].pi) continue;
            var p1 = paths[list[i].pi], p2 = paths[list[j].pi];
            if (!p1 || !p2 || p1.dead || p2.dead) continue;
            var d1 = Geom.outDir(p1.pts, list[i].end, 3);
            var d2 = Geom.outDir(p2.pts, list[j].end, 3);
            var dot = d1.x * d2.x + d1.y * d2.y;   // -1 = 完全直通
            if (dot <= cosCap && (!best || dot < best.dot)) best = { i: i, j: j, dot: dot };
          }
        }
        if (best && joinPair(paths, list[best.i], list[best.j])) acted = true;
      });
      if (!acted) break;
    }
    return paths;
  }

  /* ---------- B. 缺口焊接 ---------- */
  function collectEnds(paths) {
    var ends = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p.dead) continue;
      if (p.a === FREE) ends.push({ pi: i, end: 'a', pt: p.pts[0], dir: Geom.outDir(p.pts, 'a', 3) });
      if (p.b === FREE) ends.push({ pi: i, end: 'b', pt: p.pts[p.pts.length - 1], dir: Geom.outDir(p.pts, 'b', 3) });
    }
    return ends;
  }

  function weldTwo(paths, A, B) {
    var pA = paths[A.pi], pB = paths[B.pi];
    if (!pA || !pB || pA.dead || pB.dead) return false;

    if (A.pi === B.pi) {
      // 自己首尾相接 → 闭合成环
      var loop = A.end === 'b' ? pA.pts.slice() : pA.pts.slice().reverse();
      if (Geom.dist(loop[0], loop[loop.length - 1]) > 1e-6) loop.push({ x: loop[0].x, y: loop[0].y });
      pA.dead = true;
      paths.push({ pts: loop, a: ATTACHED, b: ATTACHED, closed: true, dead: false });
      return true;
    }

    var pa = A.end === 'b' ? pA.pts.slice() : pA.pts.slice().reverse(); // 末 = A.pt
    var pb = B.end === 'a' ? pB.pts.slice() : pB.pts.slice().reverse(); // 首 = B.pt
    var pts = pa.slice();
    for (var i = 0; i < pb.length; i++) {
      if (Geom.dist(pts[pts.length - 1], pb[i]) < 1e-6) continue;
      pts.push(pb[i]);
    }
    var a = otherEnd(pA, A.end);
    var b = otherEnd(pB, B.end);
    pA.dead = true; pB.dead = true;
    paths.push({ pts: pts, a: a, b: b, dead: false });
    return true;
  }

  function bridgeGaps(paths, maxGap, facing) {
    if (!(maxGap > 0)) return;
    var guard = 0;
    while (guard++ < 300) {
      var ends = collectEnds(paths);
      if (ends.length < 2) return;

      var cands = [];
      var fallbacks = [];
      for (var i = 0; i < ends.length; i++) {
        for (var j = i + 1; j < ends.length; j++) {
          var A = ends[i], B = ends[j];
          var d = Geom.dist(A.pt, B.pt);
          if (d > maxGap || d < 1e-6) continue;
          var score = d;
          var faceOk = true;
          if (facing) {
            var ux = (B.pt.x - A.pt.x) / d, uy = (B.pt.y - A.pt.y) / d;
            var fa = A.dir.x * ux + A.dir.y * uy;         // A 是否朝 B
            var fb = -(B.dir.x * ux + B.dir.y * uy);      // B 是否朝 A
            if (fa < 0.1 || fb < 0.1) {
              // 切线互相背离：交叉/交汇点被切开的两条分支，端点各自离开交点，
              // 但本来就该在这里接回。距离很近时作为兜底候选，
              // 优先级低于所有朝向匹配的配对（score 加大偏移排到后面）。
              faceOk = false;
            } else {
              score = d * (1.5 - 0.5 * Math.min(fa, fb));
            }
          }
          if (faceOk) cands.push({ i: i, j: j, score: score });
          else fallbacks.push({ i: i, j: j, score: 1000 + d });
        }
      }
      var all = cands.concat(fallbacks);
      if (!all.length) return;
      all.sort(function (p, q) { return p.score - q.score; });

      var ok = false;
      for (var k = 0; k < all.length; k++) {
        if (weldTwo(paths, ends[all[k].i], ends[all[k].j])) { ok = true; break; }
      }
      if (!ok) return;
    }
  }

  /* ---------- C. T 型焊接 ---------- */
  /**
   * 单轮执行：先给所有悬空端找最优目标（快照），再按距离从近到远依次焊接。
   * 不做迭代 —— 焊接会切分目标产生新端点，若反复重扫会与刚生成的段来回吸附，
   * 导致同一段几何被重复追加、路径长度不断膨胀。
   */
  function findBestTarget(paths, E, maxGap, facing) {
    var best = null;
    for (var ti = 0; ti < paths.length; ti++) {
      if (ti === E.pi) continue;
      var tp = paths[ti];
      if (tp.dead || tp.pts.length < 2) continue;
      for (var k = 0; k < tp.pts.length - 1; k++) {
        var r = Geom.pointSeg(E.pt, tp.pts[k], tp.pts[k + 1]);
        if (r.dist > maxGap) continue;
        if (facing && r.dist > 0.6) {
          var ux = r.proj.x - E.pt.x, uy = r.proj.y - E.pt.y;
          var m = Math.sqrt(ux * ux + uy * uy);
          if (m > 1e-6) {
            var f = (E.dir.x * ux + E.dir.y * uy) / m;
            if (f < -0.15) continue;            // 端点背对着目标，别硬连
          }
        }
        if (!best || r.dist < best.dist) best = { ti: ti, k: k, res: r };
      }
    }
    return best;
  }

  function attachEnds(paths, maxGap, mode, facing, width) {
    width = width || 2;
    if (!(maxGap > 0) || mode === 'off') return;

    var ends = collectEnds(paths);       // 快照
    var jobs = [];
    for (var e = 0; e < ends.length; e++) {
      var b0 = findBestTarget(paths, ends[e], maxGap, facing);
      if (b0) jobs.push({ E: ends[e], dist: b0.res.dist });
    }
    jobs.sort(function (a, b) { return a.dist - b.dist; });

    for (var j = 0; j < jobs.length; j++) {
      var E2 = jobs[j].E;
      var p = paths[E2.pi];
      if (!p || p.dead) continue;

      // 目标可能在之前的焊接中已被切分，重新找一次
      var best = findBestTarget(paths, E2, maxGap, facing);
      if (!best) continue;

      var tp2 = paths[best.ti];
      if (tp2.dead) continue;
      var J = best.res.proj;

      /* --- 端点贴着目标的「端点」→ 本就是同一交汇点被切开的两条分支 --- */
      var dHead = Geom.dist(J, tp2.pts[0]);
      var dTail = Geom.dist(J, tp2.pts[tp2.pts.length - 1]);
      var atVertex = (best.res.t < 0.02 || best.res.t > 0.98);
      if (atVertex && Math.min(dHead, dTail) < Math.max(1.6, width * 0.5)) {
        // 不只是吸附：把活动端吸到目标端点后，两条路径端点对接合成一条，
        // 交汇处才真正连续（否则永远差一小截、输出仍是两段）。
        var tEnd = dHead <= dTail ? 'a' : 'b';
        var tpt = tEnd === 'a' ? tp2.pts[0] : tp2.pts[tp2.pts.length - 1];
        if (E2.end === 'a') p.pts[0] = { x: tpt.x, y: tpt.y };
        else p.pts[p.pts.length - 1] = { x: tpt.x, y: tpt.y };
        weldTwo(paths, { pi: E2.pi, end: E2.end }, { pi: best.ti, end: tEnd });
        continue;
      }

      /* --- snap：只吸附端点，不切分主线 --- */
      if (mode === 'snap') {
        if (E2.end === 'a') { p.pts[0] = { x: J.x, y: J.y }; p.a = ATTACHED; }
        else { p.pts[p.pts.length - 1] = { x: J.x, y: J.y }; p.b = ATTACHED; }
        continue;
      }

      /* --- weld：切分目标线，与更顺的一侧接成连续路径 --- */
      var tpts = tp2.pts;
      var kk = Math.min(best.k, tpts.length - 2);
      if (kk < 0) continue;

      var left = tpts.slice(0, kk + 1).concat([{ x: J.x, y: J.y }]);
      var right = [{ x: J.x, y: J.y }].concat(tpts.slice(kk + 1));

      // 分支进入 J 的方向
      var vinx = -E2.dir.x, viny = -E2.dir.y;
      var dlx = tpts[kk].x - J.x, dly = tpts[kk].y - J.y;
      var drx = tpts[kk + 1].x - J.x, dry = tpts[kk + 1].y - J.y;
      var ml = Math.sqrt(dlx * dlx + dly * dly) || 1;
      var mr = Math.sqrt(drx * drx + dry * dry) || 1;
      var dotL = (vinx * dlx + viny * dly) / ml;
      var dotR = (vinx * drx + viny * dry) / mr;

      var branch = E2.end === 'b' ? p.pts.slice() : p.pts.slice().reverse(); // 末 = E.pt
      if (Geom.dist(branch[branch.length - 1], J) > 1e-6) branch.push({ x: J.x, y: J.y });

      /*
       * left  = [目标起点 … tpts[kk]] + [J]   （点序是「起点 → 交点」）
       * right = [J] + tpts[kk+1 …]            （点序是「交点 → 终点」）
       * 若选 left，必须倒序追加，否则会从交点跳回目标起点再走一遍，
       * 表现为路径来回折返、总长度虚高。
       */
      var useLeft = dotL >= dotR;
      var merged = branch.slice();
      var rest, restAttachedEnd;

      if (useLeft) {
        for (var ql = left.length - 2; ql >= 0; ql--) merged.push(left[ql]);
        rest = right;
        restAttachedEnd = 'a';      // right[0] = J
      } else {
        for (var qr = 1; qr < right.length; qr++) merged.push(right[qr]);
        rest = left;
        restAttachedEnd = 'b';      // left 末尾 = J
      }

      p.dead = true; tp2.dead = true;
      paths.push({ pts: merged, a: FREE, b: FREE, dead: false });

      // 切分出的另一侧：J 端标记为已连接，避免后续再被吸附
      if (rest.length >= 2 && Geom.length(rest) > Math.max(0.6, width * 0.25)) {
        paths.push({
          pts: rest,
          a: restAttachedEnd === 'a' ? ATTACHED : FREE,
          b: restAttachedEnd === 'b' ? ATTACHED : FREE,
          dead: false
        });
      }
    }
  }

  /* ---------- D. 去重 ---------- */
  /**
   * 只有「端点重合 + 中段也基本重合」才算重复。
   * 仅凭端点相同会误杀闭环被劈成的两条半环（它们的端点必然相同）。
   */
  function sameGeometry(A, B, tol) {
    var stepA = Math.max(1, Math.floor(A.pts.length / 7));
    var total = 0, hit = 0;
    for (var i = 0; i < A.pts.length; i += stepA) {
      total++;
      if (Geom.distToPolyline(A.pts[i], B.pts) <= tol) hit++;
      if (total >= 7) break;
    }
    if (hit < Math.max(2, Math.ceil(total * 0.7))) return false;
    var stepB = Math.max(1, Math.floor(B.pts.length / 7));
    total = 0; hit = 0;
    for (var j = 0; j < B.pts.length; j += stepB) {
      total++;
      if (Geom.distToPolyline(B.pts[j], A.pts) <= tol) hit++;
      if (total >= 7) break;
    }
    return hit >= Math.max(2, Math.ceil(total * 0.7));
  }

  function dedupe(paths, tol) {
    var live = paths.filter(function (p) { return !p.dead && p.pts.length >= 2; });
    var dead = new Set();
    for (var i = 0; i < live.length; i++) {
      if (dead.has(i)) continue;
      var A = live[i];
      var la = Geom.length(A.pts);
      if (la < tol * 3) continue;
      var a0 = A.pts[0], a1 = A.pts[A.pts.length - 1];
      for (var j = i + 1; j < live.length; j++) {
        if (dead.has(j)) continue;
        var B = live[j];
        var lb = Geom.length(B.pts);
        if (Math.abs(la - lb) > tol * 6) continue;
        var b0 = B.pts[0], b1 = B.pts[B.pts.length - 1];
        var same = Geom.dist(a0, b0) <= tol && Geom.dist(a1, b1) <= tol;
        var rev = Geom.dist(a0, b1) <= tol && Geom.dist(a1, b0) <= tol;
        if (!same && !rev) continue;
        if (!sameGeometry(A, B, tol * 1.2)) continue;
        dead.add(lb > la ? i : j);
        if (dead.has(i)) break;
      }
    }
    return live.filter(function (_, idx) { return !dead.has(idx); });
  }

  /* ---------- 主入口 ---------- */
  /**
   * @param graph Skeleton.trace 的结果
   * @param opts {
   *   width, throughJunction:true, maxTurn:45,
   *   gapK:1.0, minLenK:1.0, tMode:'weld'|'snap'|'off', facing:true
   * }
   */
  Merge.weld = function (graph, opts) {
    opts = opts || {};
    var width = opts.width || 2;
    var paths = graph.edges.map(function (e) {
      return {
        pts: e.pts.map(function (p) { return { x: p.x, y: p.y }; }),
        a: e.a == null ? FREE : e.a,
        b: e.b == null ? FREE : e.b,
        closed: !!e.closed,
        dead: false
      };
    });
    var stats = { input: paths.length };

    if (opts.throughJunction !== false) {
      joinThroughNodes(paths, opts.maxTurn == null ? 45 : opts.maxTurn);
    }
    normalizeEnds(paths);
    stats.afterJoin = paths.filter(function (p) { return !p.dead; }).length;

    bridgeGaps(paths, (opts.gapK == null ? 1 : opts.gapK) * width, opts.facing !== false);
    stats.afterBridge = paths.filter(function (p) { return !p.dead; }).length;

    attachEnds(paths, (opts.gapK == null ? 1 : opts.gapK) * width, opts.tMode || 'weld', opts.facing !== false, width);
    stats.afterAttach = paths.filter(function (p) { return !p.dead; }).length;

    var result = dedupe(paths, Math.max(0.75, width * 0.45));

    var minLen = (opts.minLenK == null ? 1 : opts.minLenK) * width;
    if (minLen > 0) result = result.filter(function (p) { return Geom.length(p.pts) >= minLen; });

    // 去相邻重复点
    result = result.map(function (p) {
      return { pts: Geom.dedupe(p.pts, 0.01), closed: !!p.closed };
    }).filter(function (p) { return p.pts.length >= 2; });

    stats.output = result.length;
    stats.totalLength = result.reduce(function (s, p) { return s + Geom.length(p.pts); }, 0);
    return { paths: result, stats: stats };
  };

  global.LineMerge = Merge;
})(typeof window !== 'undefined' ? window : globalThis);
