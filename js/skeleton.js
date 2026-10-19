/* =============================================================
 * skeleton.js  —  骨架提取算法（图像 → 中心线图）
 *
 * 针对「均匀线宽的线稿」重写，流程：
 *   1. 灰度 + Otsu 自动阈值二值化（可关闭自动、可反相）
 *   2. 去小连通域（噪点）
 *   3. 精确欧氏距离变换 EDT（Felzenszwalb-Huttenlocher，O(n)）
 *   4. 用 EDT 脊线统计「线宽 W」：脊线处 dt ≈ W/2
 *   5. 以 W 为基准做「距离阈值腐蚀 + 脊线滞后生长」得到中心线带，
 *      再用 Zhang-Suen 细化到 1px —— 因为种子来自 DT，中心线天然居中，
 *      不会像直接细化原掩膜那样被粗线内部的毛刺带偏
 *   6. 图结构追踪：区分「端点节点 / 交叉节点」，沿 deg==2 链走边，
 *      得到 edge 图（而不是原实现里逐像素贪心走，分叉处会断）
 *   7. 按 W 剪枝短毛刺
 * ============================================================= */
(function (global) {
  'use strict';

  var Geom = global.LineGeom;
  var Skeleton = {};

  var DIRS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

  /* ---------------- 1. 灰度 ---------------- */
  Skeleton.gray = function (imgData) {
    var d = imgData.data, n = imgData.width * imgData.height;
    var g = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) | 0;
    }
    return g;
  };

  /* ---------------- 2. Otsu 阈值 ---------------- */
  Skeleton.otsu = function (hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, maxVar = -1, best = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; best = i; }
    }
    return best;
  };

  /* ---------------- 3. 二值化 ---------------- */
  /**
   * @param opts {threshold:0=自动, polarity:'auto'|'dark'|'light'}
   */
  Skeleton.binarize = function (gray, w, h, opts) {
    opts = opts || {};
    var n = gray.length;
    var hist = new Float64Array(256);
    for (var i = 0; i < n; i++) hist[gray[i]]++;

    var autoTh = Skeleton.otsu(hist, n);
    var th = (opts.threshold && opts.threshold > 0) ? opts.threshold : autoTh;
    // 纯二值图（只有 0/255）时 Otsu 会给出 0，直接比较会得到空掩膜，故夹到 [1,254]
    th = Math.max(1, Math.min(254, th));

    var mask = new Uint8Array(w * h);
    var fg = 0;
    for (var k = 0; k < n; k++) {
      if (gray[k] < th) { mask[k] = 1; fg++; }
    }

    // 线稿通常是「深色线 + 浅色底」，深色像素占比过大说明是反相（黑板白线）
    var inverted = false;
    var pol = opts.polarity || 'auto';
    if (pol === 'light' || (pol === 'auto' && fg > n * 0.5)) {
      for (var j = 0; j < mask.length; j++) mask[j] = mask[j] ? 0 : 1;
      inverted = true;
      fg = n - fg;
    }
    return {
      mask: mask, threshold: th, autoThreshold: autoTh,
      inverted: inverted, fgRatio: fg / n
    };
  };

  /* ---------------- 4. 去小连通域 ---------------- */
  Skeleton.removeSmall = function (mask, w, h, minArea) {
    if (!(minArea > 0)) return new Uint8Array(mask);
    var out = new Uint8Array(mask);
    var seen = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) {
      if (!mask[i] || seen[i]) continue;
      var stack = [i], comp = [];
      seen[i] = 1;
      while (stack.length) {
        var ci = stack.pop(); comp.push(ci);
        var cy = (ci / w) | 0, cx = ci % w;
        for (var d = 0; d < 8; d++) {
          var nx = cx + DIRS8[d][1], ny = cy + DIRS8[d][0];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = ny * w + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1; stack.push(ni);
        }
      }
      if (comp.length < minArea) for (var c = 0; c < comp.length; c++) out[comp[c]] = 0;
    }
    return out;
  };

  /* ---------------- 5. 精确欧氏距离变换 ---------------- */
  function dt1d(f, d, v, z, n) {
    var k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (var x = 0; x < n; x++) {
      while (z[k + 1] < x) k++;
      var dx = x - v[k];
      d[x] = dx * dx + f[v[k]];
    }
  }

  /** 返回每个前景像素到最近背景像素的欧氏距离（像素单位） */
  Skeleton.edt = function (mask, w, h) {
    var BIG = 1e9;
    var grid = new Float64Array(w * h);
    for (var i = 0; i < w * h; i++) grid[i] = mask[i] ? BIG : 0;

    var m = Math.max(w, h);
    var f = new Float64Array(m), d = new Float64Array(m);
    var v = new Int32Array(m), z = new Float64Array(m + 1);

    for (var x = 0; x < w; x++) {
      for (var y = 0; y < h; y++) f[y] = grid[y * w + x];
      dt1d(f, d, v, z, h);
      for (var y2 = 0; y2 < h; y2++) grid[y2 * w + x] = d[y2];
    }
    for (var yy = 0; yy < h; yy++) {
      var off = yy * w;
      for (var xx = 0; xx < w; xx++) f[xx] = grid[off + xx];
      dt1d(f, d, v, z, w);
      for (var xx2 = 0; xx2 < w; xx2++) grid[off + xx2] = d[xx2];
    }

    var out = new Float32Array(w * h);
    for (var p = 0; p < w * h; p++) out[p] = Math.sqrt(grid[p]);
    return out;
  };

  /* ---------------- 6. 线宽估计 ---------------- */
  /**
   * 均匀线宽 W 的笔画，其中心线处 dt ≈ W/2。
   * 取 EDT 的局部极大点（脊线）统计 2*dt 的众数，得到主笔宽，
   * 同时给出 p10/p90 用于提示「线宽是否真的均匀」。
   */
  Skeleton.estimateWidth = function (dt, w, h) {
    var maxDt = 0, i;
    for (i = 0; i < w * h; i++) if (dt[i] > maxDt) maxDt = dt[i];

    var BIN = 0.25;
    var nb = Math.max(8, Math.ceil((2 * maxDt + 4) / BIN));
    var hist = new Float64Array(nb);
    var samples = [];

    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;
        var val = dt[idx];
        if (val < 0.9) continue;
        var isMax = true;
        for (var k = 0; k < 8; k++) {
          var nx = x + DIRS8[k][1], ny = y + DIRS8[k][0];
          if (dt[ny * w + nx] > val + 1e-4) { isMax = false; break; }
        }
        if (!isMax) continue;
        // dt 是到最近「背景像素中心」的距离，笔画边界在其内侧 0.5px，
        // 故 2*dt-0.5 才对得上真实线宽（奇偶宽度误差 <=0.5px）
        var wid = 2 * val - 0.5;
        samples.push(wid);
        var b = Math.floor(wid / BIN);
        if (b >= nb) b = nb - 1;
        hist[b] += 1;
      }
    }

    if (samples.length < 4) {
      return { width: 2, p10: 2, p90: 2, count: samples.length, uniform: false };
    }

    // 3 桶平滑后取峰
    var sm = new Float64Array(nb);
    for (i = 0; i < nb; i++) {
      var a = hist[i - 1] || 0, b2 = hist[i], c = hist[i + 1] || 0;
      sm[i] = (a + b2 * 2 + c) / 4;
    }
    var peak = 0;
    for (i = 1; i < nb; i++) if (sm[i] > sm[peak]) peak = i;
    var peakW = (peak + 0.5) * BIN;

    // 峰值邻域内做加权平均，得到亚像素线宽
    var sumW = 0, sumC = 0;
    for (i = 0; i < nb; i++) {
      var cw = (i + 0.5) * BIN;
      if (Math.abs(cw - peakW) <= 1.0) { sumW += cw * hist[i]; sumC += hist[i]; }
    }
    var width = sumC > 0 ? sumW / sumC : peakW;
    if (!(width > 0.5)) width = 1;

    samples.sort(function (p, q) { return p - q; });
    var p10 = samples[Math.floor(samples.length * 0.1)];
    var p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
    var uniform = (p90 - p10) <= Math.max(1.2, width * 0.35);

    return { width: width, p10: p10, p90: p90, count: samples.length, uniform: uniform };
  };

  /* ---------------- 7. 由 EDT 生成中心线带 ---------------- */
  /**
   * @param residual 细化前希望残留的带宽（px），约等于 1~2
   */
  Skeleton.centerline = function (mask, dt, w, h, width, residual) {
    var n = w * h;
    var resid = Math.max(0.8, residual || 1.2);
    var t = Math.max(0, (width - resid) / 2);

    var strong = new Uint8Array(n);
    var cnt = 0;
    for (var i = 0; i < n; i++) if (mask[i] && dt[i] >= t) { strong[i] = 1; cnt++; }
    if (cnt === 0) return new Uint8Array(mask); // 线本身太细，直接细化原掩膜

    // 允许保留的脊线像素（应对同一张图里更细的线）
    var keep = new Uint8Array(n);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;
        if (!mask[idx]) continue;
        var val = dt[idx];
        if (val < 1) continue;
        var isMax = true;
        for (var k = 0; k < 8; k++) {
          if (dt[(y + DIRS8[k][0]) * w + (x + DIRS8[k][1])] > val + 1e-4) { isMax = false; break; }
        }
        if (isMax) keep[idx] = 1;
      }
    }

    // 以 strong 为种子，在 strong|keep 上做滞后生长，保证细线不断
    var out = new Uint8Array(n);
    var stack = [];
    for (var s = 0; s < n; s++) if (strong[s]) { out[s] = 1; stack.push(s); }
    while (stack.length) {
      var ci = stack.pop();
      var cy = (ci / w) | 0, cx = ci % w;
      for (var d = 0; d < 8; d++) {
        var nx = cx + DIRS8[d][1], ny = cy + DIRS8[d][0];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (out[ni]) continue;
        if (!keep[ni] && !strong[ni]) continue;
        out[ni] = 1; stack.push(ni);
      }
    }
    return out;
  };

  /* ---------------- 8. Zhang-Suen 细化 ---------------- */
  Skeleton.thin = function (mask, w, h) {
    var bin = new Uint8Array(mask);
    var del = new Uint8Array(w * h);
    var changed = true, guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (var pass = 0; pass < 2; pass++) {
        var any = false;
        for (var y = 1; y < h - 1; y++) {
          var row = y * w;
          for (var x = 1; x < w - 1; x++) {
            var i = row + x;
            if (!bin[i]) continue;
            var p2 = bin[i - w], p3 = bin[i - w + 1], p4 = bin[i + 1], p5 = bin[i + w + 1];
            var p6 = bin[i + w], p7 = bin[i + w - 1], p8 = bin[i - 1], p9 = bin[i - w - 1];
            var c = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (c < 2 || c > 6) continue;
            var ap = 0;
            if (!p2 && p3) ap++; if (!p3 && p4) ap++; if (!p4 && p5) ap++; if (!p5 && p6) ap++;
            if (!p6 && p7) ap++; if (!p7 && p8) ap++; if (!p8 && p9) ap++; if (!p9 && p2) ap++;
            if (ap !== 1) continue;
            if (pass === 0) {
              if (p2 && p4 && p6) continue;
              if (p4 && p6 && p8) continue;
            } else {
              if (p2 && p4 && p8) continue;
              if (p2 && p6 && p8) continue;
            }
            del[i] = 1; any = true;
          }
        }
        if (any) {
          for (var k = 0; k < w * h; k++) if (del[k]) { bin[k] = 0; del[k] = 0; }
          changed = true;
        }
      }
    }
    return bin;
  };

  /* ---------------- 8.5 最小骨架化（去掉冗余像素） ----------------
   * Zhang-Suen 在浅角度斜线上会留下 2px 宽的台阶带，局部度数为 3/4，
   * 追踪时会把整段误判成一个巨大「交叉节点」。这一步把「删掉后邻域仍然
   * 连通」的冗余像素逐个删除，收成真正的 1px 链。
   */
  function neighbors8(bin, w, h, x, y) {
    var out = [];
    for (var d = 0; d < 8; d++) {
      var nx = x + DIRS8[d][1], ny = y + DIRS8[d][0];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (bin[ny * w + nx]) out.push({ x: nx, y: ny });
    }
    return out;
  }

  function connected8(list) {
    if (list.length <= 1) return true;
    var seen = [0];
    var queue = [0];
    var vis = new Uint8Array(list.length);
    vis[0] = 1;
    while (queue.length) {
      var i = queue.pop();
      for (var j = 0; j < list.length; j++) {
        if (vis[j]) continue;
        if (Math.abs(list[i].x - list[j].x) <= 1 && Math.abs(list[i].y - list[j].y) <= 1) {
          vis[j] = 1; queue.push(j);
        }
      }
    }
    for (var k = 0; k < list.length; k++) if (!vis[k]) return false;
    return true;
  }

  Skeleton.minimalThin = function (bin, w, h) {
    var cur = new Uint8Array(bin);
    var changed = true, guard = 0;
    while (changed && guard++ < 30) {
      changed = false;
      // 必须「即时删除」：同一轮里批量删除会各自合法、合起来把链打断
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var i = y * w + x;
          if (!cur[i]) continue;
          var nb = neighbors8(cur, w, h, x, y);
          if (nb.length <= 1) continue;      // 孤立点 / 端点必须保留
          if (!connected8(nb)) continue;     // 删了会断 → 保留
          cur[i] = 0;
          changed = true;
        }
      }
    }
    return cur;
  };

  /* ---------------- 9. 图结构追踪 ---------------- */
  /**
   * 把所有 1px 骨架拆成「节点 cluster + 边」的图：
   *   节点 = 度 != 2 的像素（端点 deg1 / 交叉 deg>=3），8 连通聚成一簇取质心
   *   边   = 两个节点之间的 deg==2 像素链
   * 这样交叉点不会像逐像素贪心那样把路径截断，后续焊接才有据可依。
   */
  Skeleton.trace = function (mask, w, h) {
    var n = w * h, i, x, y;

    // 度
    var deg = new Uint8Array(n);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var idx = y * w + x;
        if (!mask[idx]) continue;
        var c = 0;
        for (var d = 0; d < 8; d++) {
          var nx = x + DIRS8[d][1], ny = y + DIRS8[d][0];
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) c++;
        }
        deg[idx] = c;
      }
    }

    // 节点聚类
    var nodeId = new Int32Array(n).fill(-1);
    var nodes = [];
    for (i = 0; i < n; i++) {
      if (!mask[i] || deg[i] === 2 || nodeId[i] !== -1) continue;
      var id = nodes.length;
      nodeId[i] = id;
      var stack = [i], pixels = [];
      while (stack.length) {
        var ci = stack.pop();
        var cy = (ci / w) | 0, cx = ci % w;
        pixels.push({ x: cx, y: cy });
        for (var d2 = 0; d2 < 8; d2++) {
          var ax = cx + DIRS8[d2][1], ay = cy + DIRS8[d2][0];
          if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
          var ai = ay * w + ax;
          if (!mask[ai] || deg[ai] === 2 || nodeId[ai] !== -1) continue;
          nodeId[ai] = id; stack.push(ai);
        }
      }
      var sx = 0, sy = 0;
      for (var p = 0; p < pixels.length; p++) { sx += pixels[p].x + 0.5; sy += pixels[p].y + 0.5; }
      nodes.push({ id: id, pixels: pixels, x: sx / pixels.length, y: sy / pixels.length, degree: 0 });
    }

    var consumed = new Uint8Array(n);
    var edges = [];

    function walkEdge(startNode, px, py, cx, cy) {
      var pts = [{ x: nodes[startNode].x, y: nodes[startNode].y }];
      consumed[cy * w + cx] = 1;
      pts.push({ x: cx + 0.5, y: cy + 0.5 });
      var guard = 0;
      while (guard++ < n) {
        var ci = cy * w + cx;
        if (deg[ci] !== 2) {
          var nj = nodeId[ci];
          if (nj >= 0) {
            pts.push({ x: nodes[nj].x, y: nodes[nj].y });
            edges.push({ a: startNode, b: nj, pts: pts });
          } else {
            edges.push({ a: startNode, b: null, pts: pts });
          }
          return;
        }
        var found = false;
        for (var d = 0; d < 8; d++) {
          var ax = cx + DIRS8[d][1], ay = cy + DIRS8[d][0];
          if (ax === px && ay === py) continue;
          if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
          if (!mask[ay * w + ax]) continue;
          var ai = ay * w + ax;
          if (consumed[ai]) continue;
          px = cx; py = cy; cx = ax; cy = ay;
          consumed[ai] = 1;
          pts.push({ x: cx + 0.5, y: cy + 0.5 });
          found = true;
          break;
        }
        if (!found) { edges.push({ a: startNode, b: null, pts: pts }); return; }
      }
      edges.push({ a: startNode, b: null, pts: pts });
    }

    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      for (var q = 0; q < node.pixels.length; q++) {
        var np = node.pixels[q];
        for (var d3 = 0; d3 < 8; d3++) {
          var ax2 = np.x + DIRS8[d3][1], ay2 = np.y + DIRS8[d3][0];
          if (ax2 < 0 || ay2 < 0 || ax2 >= w || ay2 >= h) continue;
          var ai2 = ay2 * w + ax2;
          if (!mask[ai2]) continue;
          if (deg[ai2] !== 2) continue;          // 相邻节点像素属于同一簇
          if (consumed[ai2]) continue;
          walkEdge(ni, np.x, np.y, ax2, ay2);
        }
      }
    }

    // 纯环（没有节点的连通域）
    for (i = 0; i < n; i++) {
      if (!mask[i] || consumed[i] || deg[i] !== 2) continue;
      var pts2 = [], ci2 = i, prev = -1, guard2 = 0;
      while (guard2++ < n) {
        consumed[ci2] = 1;
        var cyy = (ci2 / w) | 0, cxx = ci2 % w;
        pts2.push({ x: cxx + 0.5, y: cyy + 0.5 });
        var next = -1;
        for (var d4 = 0; d4 < 8; d4++) {
          var ax3 = cxx + DIRS8[d4][1], ay3 = cyy + DIRS8[d4][0];
          if (ax3 < 0 || ay3 < 0 || ax3 >= w || ay3 >= h) continue;
          if (!mask[ay3 * w + ax3]) continue;
          var ai3 = ay3 * w + ax3;
          if (ai3 === prev || ai3 === ci2) continue;
          next = ai3; break;
        }
        if (next < 0) break;
        if (next === i) {
          pts2.push({ x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5 });
          break;
        }
        prev = ci2; ci2 = next;
      }
      if (pts2.length > 3) edges.push({ a: null, b: null, closed: true, pts: pts2 });
    }

    return { nodes: nodes, edges: edges, deg: deg };
  };

  /* ---------------- 10. 剪枝（按线宽） ---------------- */
  Skeleton.pruneLeaves = function (nodes, edges, minLen) {
    var changed = true, guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      var degMap = new Map();
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (e.a != null) degMap.set(e.a, (degMap.get(e.a) || 0) + 1);
        if (e.b != null) degMap.set(e.b, (degMap.get(e.b) || 0) + 1);
      }
      for (var k = edges.length - 1; k >= 0; k--) {
        var ed = edges[k];
        if (ed.closed) continue;
        var da = ed.a != null ? (degMap.get(ed.a) || 0) : 99;
        var db = ed.b != null ? (degMap.get(ed.b) || 0) : 99;
        // 只剪「一端是叶子」的短枝，避免把正常线段剪没
        if ((da <= 1 || db <= 1) && Geom.length(ed.pts) < minLen) {
          edges.splice(k, 1);
          changed = true;
        }
      }
    }
    return edges;
  };

  /* ---------------- 11. 一键构建 ---------------- */
  /**
   * @param imgData ImageData
   * @param opts {threshold, polarity, minComponentArea, widthOverride, residual, pruneK}
   */
  Skeleton.build = function (imgData, opts) {
    opts = opts || {};
    var t0 = now();
    var w = imgData.width, h = imgData.height;

    var gray = Skeleton.gray(imgData);
    var bin = Skeleton.binarize(gray, w, h, opts);
    var mask = Skeleton.removeSmall(bin.mask, w, h, opts.minComponentArea || 0);
    var tBin = now();

    var dt = Skeleton.edt(mask, w, h);
    var tEdt = now();

    var est = Skeleton.estimateWidth(dt, w, h);
    var width = (opts.widthOverride && opts.widthOverride > 0) ? opts.widthOverride : est.width;
    var tWidth = now();

    var band = Skeleton.centerline(mask, dt, w, h, width, opts.residual);
    var center = Skeleton.thin(band, w, h);
    center = Skeleton.minimalThin(center, w, h);
    var tSkel = now();

    var graph = Skeleton.trace(center, w, h);
    var rawEdgeCount = graph.edges.length;

    var pruneK = opts.pruneK == null ? 1.2 : opts.pruneK;
    graph.edges = Skeleton.pruneLeaves(graph.nodes, graph.edges, pruneK * width);

    // 清理没有任何边的节点
    var used = new Set();
    graph.edges.forEach(function (e) {
      if (e.a != null) used.add(e.a);
      if (e.b != null) used.add(e.b);
    });
    graph.nodes = graph.nodes.filter(function (nd) { return used.has(nd.id); });

    /*
     * 线宽二次校正：墨迹面积 / 中心线总长。
     * EDT 众数估计有 ±0.5px 的奇偶偏差；面积/长度对线稿基本无偏，
     * 两者接近时取均值，能显著提升「输出描边宽度」的准确度。
     */
    var inkArea = 0;
    for (var ai = 0; ai < mask.length; ai++) if (mask[ai]) inkArea++;
    var totalLen = 0;
    graph.edges.forEach(function (e) { totalLen += Geom.length(e.pts); });
    var widthArea = totalLen > 1 ? inkArea / totalLen : 0;
    if (!(opts.widthOverride > 0) && widthArea > width * 0.6 && widthArea < width * 1.6) {
      width = 0.5 * width + 0.5 * widthArea;
    }
    var tTrace = now();

    var centerCount = 0;
    for (var i = 0; i < center.length; i++) if (center[i]) centerCount++;

    return {
      w: w, h: h,
      mask: mask,
      dt: dt,
      band: band,
      center: center,
      centerCount: centerCount,
      threshold: bin.threshold,
      autoThreshold: bin.autoThreshold,
      inverted: bin.inverted,
      fgRatio: bin.fgRatio,
      width: width,
      widthArea: widthArea,
      widthAuto: !(opts.widthOverride > 0),
      widthStats: est,
      graph: graph,
      rawEdgeCount: rawEdgeCount,
      timing: { bin: tBin - t0, edt: tEdt - tBin, width: tWidth - tEdt, skel: tSkel - tWidth, trace: tTrace - tSkel }
    };
  };

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  global.Skeleton = Skeleton;
})(typeof window !== 'undefined' ? window : globalThis);
