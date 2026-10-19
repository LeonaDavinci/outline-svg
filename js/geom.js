/* =============================================================
 * geom.js  —  几何基础库（无依赖，供 skeleton / merge / svg 共用）
 * 只做纯数学，不涉及图像、DOM。
 * ============================================================= */
(function (global) {
  'use strict';

  var LineGeom = {};

  /** 两点距离 */
  LineGeom.dist = function (a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** 折线总长度 */
  LineGeom.length = function (pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += LineGeom.dist(pts[i - 1], pts[i]);
    return s;
  };

  /** 去掉相邻重复点（容差 tol） */
  LineGeom.dedupe = function (pts, tol) {
    if (!pts || pts.length === 0) return [];
    tol = tol || 1e-4;
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      if (LineGeom.dist(out[out.length - 1], pts[i]) > tol) out.push(pts[i]);
    }
    return out;
  };

  /** 点到线段：返回 {dist, t, proj} */
  LineGeom.pointSeg = function (p, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len2 = abx * abx + aby * aby;
    var t = 0;
    if (len2 > 1e-12) t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var proj = { x: a.x + abx * t, y: a.y + aby * t };
    return { dist: LineGeom.dist(p, proj), t: t, proj: proj };
  };

  /**
   * 端点外向单位方向（指向线头外侧）
   * @param pts 折线
   * @param which 'a' 起点 | 'b' 终点
   * @param span 参与估计的点数
   */
  LineGeom.outDir = function (pts, which, span) {
    var n = pts.length;
    if (n < 2) return { x: 0, y: 0 };
    span = Math.max(1, Math.min(span || 3, n - 1));
    var ax, ay, bx, by;
    if (which === 'a') {
      ax = pts[0].x; ay = pts[0].y;
      bx = pts[span].x; by = pts[span].y;
    } else {
      var L = n - 1;
      ax = pts[L].x; ay = pts[L].y;
      bx = pts[L - span].x; by = pts[L - span].y;
    }
    var dx = ax - bx, dy = ay - by;
    var m = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / m, y: dy / m };
  };

  /** Douglas-Peucker 简化（迭代栈实现，避免长路径爆栈） */
  LineGeom.simplify = function (pts, eps) {
    var n = pts.length;
    if (n <= 2 || !(eps > 0)) return pts.slice();
    var keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var i0 = seg[0], i1 = seg[1];
      if (i1 - i0 < 2) continue;
      var maxD = -1, idx = -1;
      for (var i = i0 + 1; i < i1; i++) {
        var d = LineGeom.pointSeg(pts[i], pts[i0], pts[i1]).dist;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) {
        keep[idx] = 1;
        stack.push([i0, idx]);
        stack.push([idx, i1]);
      }
    }
    var out = [];
    for (var k = 0; k < n; k++) if (keep[k]) out.push(pts[k]);
    return out;
  };

  /** 点到折线的最短距离（暴力，配套去重用） */
  LineGeom.distToPolyline = function (p, pts) {
    var best = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var d = LineGeom.pointSeg(p, pts[i], pts[i + 1]).dist;
      if (d < best) best = d;
    }
    return best;
  };

  /** 折线按弧长均匀重采样 */
  LineGeom.resample = function (pts, step) {
    if (!pts || pts.length < 2 || !(step > 0)) return pts ? pts.slice() : [];
    var out = [pts[0]];
    var acc = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dx = b.x - a.x, dy = b.y - a.y;
      var segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen < 1e-9) continue;
      var remain = step - acc;
      var traveled = 0;
      while (traveled + remain <= segLen) {
        var t = (traveled + remain) / segLen;
        out.push({ x: a.x + dx * t, y: a.y + dy * t });
        traveled += remain;
        remain = step;
      }
      acc = segLen - traveled;
    }
    out.push(pts[pts.length - 1]);
    return out;
  };

  /** 三点滑动平均（保端点） */
  LineGeom.smooth = function (pts, level) {
    if (!pts || pts.length < 3 || !(level >= 1)) return pts ? pts.slice() : [];
    var cur = pts.slice();
    for (var k = 0; k < level; k++) {
      var next = [cur[0]];
      for (var i = 1; i < cur.length - 1; i++) {
        next.push({
          x: (cur[i - 1].x + cur[i].x + cur[i + 1].x) / 3,
          y: (cur[i - 1].y + cur[i].y + cur[i + 1].y) / 3
        });
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    return cur;
  };

  /**
   * 标记哪些顶点是尖角（转角过大）。
   * 方向用 ±span 个点的窗口估计：平滑之后拐角会被摊到好几个顶点上，
   * 只比较相邻两点会漏判，导致直角被抹圆。
   * @returns Uint8Array，1 = 尖角
   */
  LineGeom.cornerFlags = function (pts, cornerCos, span) {
    span = Math.max(1, span || 2);
    var n = pts.length;
    var flags = new Uint8Array(n);
    if (n < 3) return flags;
    for (var i = 1; i < n - 1; i++) {
      var a = pts[Math.max(0, i - span)];
      var b = pts[i];
      var c = pts[Math.min(n - 1, i + span)];
      var v1x = b.x - a.x, v1y = b.y - a.y;
      var v2x = c.x - b.x, v2y = c.y - b.y;
      var m1 = Math.sqrt(v1x * v1x + v1y * v1y);
      var m2 = Math.sqrt(v2x * v2x + v2y * v2y);
      if (!(m1 > 1e-9 && m2 > 1e-9)) continue;
      if ((v1x * v2x + v1y * v2y) / (m1 * m2) < cornerCos) flags[i] = 1;
    }
    return flags;
  };

  global.LineGeom = LineGeom;
})(typeof window !== 'undefined' ? window : globalThis);
