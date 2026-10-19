/* =============================================================
 * svg.js  —  SVG 生成算法（折线路径 → path d / SVG 文档）
 *
 * 设计要点：
 *   1. 简化精度按线宽自适应（eps = 系数 × W），粗线图不会被压成畸形折线
 *   2. 先做折角检测，尖角处断开并用 L 保留直角，只有平缓段用三次贝塞尔
 *      —— 原实现整条路径无脑上曲线，直角会被抹圆
 *   3. Catmull-Rom → 三次贝塞尔，控制点长度由 smooth 系数控制
 *   4. 描边宽度默认直接取估计线宽，输出图形与输入线稿等宽
 * ============================================================= */
(function (global) {
  'use strict';

  var Geom = global.LineGeom;
  var SvgBuilder = {};

  function makeFmt(decimals) {
    var mul = Math.pow(10, decimals == null ? 2 : decimals);
    return function (v) {
      var r = Math.round(v * mul) / mul;
      if (r === 0) r = 0;   // 消掉 -0
      return String(r);
    };
  }

  /**
   * 单条折线 → path d。
   *
   * 尖角有两种处理：
   *   cusp（默认）：在拐角处把两侧贝塞尔的控制点都收回到拐角点本身，
   *     切线长度为 0，视觉上仍是锐角，但整条路径只有一个 M ——
   *     外部工具（Inkscape / Illustrator / 自研解析器）读到的子路径数
   *     就等于焊接后的段数，不会因为拐角而多出一堆子路径。
   *   break：老做法，遇到尖角就断开另起一个 M，尖角更硬但子路径变多。
   */
  function pathToD(pts, opt, f) {
    var n = pts.length;
    if (n < 2) return '';
    var d = 'M' + f(pts[0].x) + ',' + f(pts[0].y);

    if (n === 2 || !(opt.smooth > 0.01)) {
      for (var i = 1; i < n; i++) d += 'L' + f(pts[i].x) + ',' + f(pts[i].y);
      return d;
    }

    var corners = opt.cuspCorner === false ? new Uint8Array(n) :
      Geom.cornerFlags(pts, Math.cos((opt.cornerDeg || 55) * Math.PI / 180), 2);

    for (var s = 0; s < n - 1; s++) {
      var p0 = pts[s - 1] || pts[s];
      var p1 = pts[s];
      var p2 = pts[s + 1];
      var p3 = pts[s + 2] || pts[s + 1];

      var segLen = Geom.dist(p1, p2);
      var maxH = segLen * 0.42;

      var ax = (p2.x - p0.x) * opt.smooth / 6, ay = (p2.y - p0.y) * opt.smooth / 6;
      var am = Math.sqrt(ax * ax + ay * ay);
      if (am > maxH && am > 1e-6) { ax = ax / am * maxH; ay = ay / am * maxH; }

      var bx = (p3.x - p1.x) * opt.smooth / 6, by = (p3.y - p1.y) * opt.smooth / 6;
      var bm = Math.sqrt(bx * bx + by * by);
      if (bm > maxH && bm > 1e-6) { bx = bx / bm * maxH; by = by / bm * maxH; }

      // 尖角：控制点贴到拐角上 → 零切线 → 锐角但不新开 M
      var c1x = corners[s] ? p1.x : p1.x + ax;
      var c1y = corners[s] ? p1.y : p1.y + ay;
      var c2x = corners[s + 1] ? p2.x : p2.x - bx;
      var c2y = corners[s + 1] ? p2.y : p2.y - by;

      d += 'C' + f(c1x) + ',' + f(c1y) + ' ' + f(c2x) + ',' + f(c2y) + ' ' + f(p2.x) + ',' + f(p2.y);
    }
    return d;
  }

  /**
   * @param paths [{pts:[{x,y}]}]
   * @param opts {
   *   w,h,            画布尺寸（决定 viewBox）
   *   eps,            简化精度 px
   *   smooth,         平滑系数 0~1.5
   *   cornerDeg,      超过该转角视为尖角
   *   strokeWidth,    描边宽度
   *   color, padding, decimals, singlePath
   * }
   */
  SvgBuilder.build = function (paths, opts) {
    opts = opts || {};
    var f = makeFmt(opts.decimals == null ? 2 : opts.decimals);
    var eps = opts.eps == null ? 0.3 : opts.eps;
    var ds = [];
    var lengths = [];
    var usedPoints = 0;

    for (var i = 0; i < paths.length; i++) {
      var pts = paths[i].pts;
      if (!pts || pts.length < 2) continue;
      pts = Geom.dedupe(pts, Math.max(1e-3, eps * 0.2));
      // 先做滑动平均：把像素台阶抹平，DP 才敢放大地简化，否则每个台阶点都会被保留
      if (opts.preSmooth !== 0) pts = Geom.smooth(pts, opts.preSmooth == null ? 2 : opts.preSmooth);
      pts = Geom.simplify(pts, eps);
      if (pts.length < 2) continue;
      var d = pathToD(pts, {
        smooth: opts.smooth == null ? 0.9 : opts.smooth,
        cornerDeg: opts.cornerDeg == null ? 55 : opts.cornerDeg,
        cuspCorner: opts.cuspCorner,
        eps: eps
      }, f);
      if (!d) continue;
      ds.push(d);
      lengths.push(Geom.length(pts));
      usedPoints += pts.length;
    }

    var sw = opts.strokeWidth == null ? 2 : opts.strokeWidth;
    var color = opts.color || '#111111';
    var pad = opts.padding == null ? 4 : opts.padding;
    var w = opts.w || 100, h = opts.h || 100;
    var vb = (-pad) + ' ' + (-pad) + ' ' + (w + 2 * pad) + ' ' + (h + 2 * pad);
    var head = 'fill="none" stroke="' + color + '" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round"';

    var body;
    if (opts.singlePath === false) {
      body = ds.map(function (d) { return '  <path ' + head + ' d="' + d + '"/>'; }).join('\n');
    } else {
      body = '  <path ' + head + ' d="' + ds.join(' ') + '"/>';
    }

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb +
      '" width="' + w + '" height="' + h + '" ' + head + '>\n' + body + '\n</svg>';

    var subs = 0;
    for (var t = 0; t < ds.length; t++) subs += (ds[t].match(/M/g) || []).length;

    return {
      svg: svg,
      w: w, h: h, strokeWidth: sw,            // 供预览层重建带颜色的 svg
      ds: ds,                                  // 每段的 d，供预览层分色/点选
      lengths: lengths,                        // 每段折线长度
      pathCount: ds.length,
      subpaths: subs,                          // d 里的 M 数 = 外部工具看到的子路径数
      d: ds.join(' '),
      points: usedPoints
    };
  };

  global.SvgBuilder = SvgBuilder;
})(typeof window !== 'undefined' ? window : globalThis);
