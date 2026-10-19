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

  /** 单条折线 → path d 片段 */
  function pathToD(pts, opt, f) {
    var smooth = opt.smooth;
    var cornerCos = Math.cos((opt.cornerDeg || 55) * Math.PI / 180);
    var runs = Geom.splitAtCorners(pts, cornerCos);
    var d = '';

    for (var r = 0; r < runs.length; r++) {
      var run = Geom.dedupe(runs[r], Math.max(1e-3, (opt.eps || 0.3) * 0.2));
      if (run.length < 2) continue;
      d += 'M' + f(run[0].x) + ',' + f(run[0].y);

      if (run.length === 2 || !(smooth > 0.01)) {
        for (var i = 1; i < run.length; i++) d += 'L' + f(run[i].x) + ',' + f(run[i].y);
        continue;
      }

      for (var s = 0; s < run.length - 1; s++) {
        var p0 = run[s - 1] || run[s];
        var p1 = run[s];
        var p2 = run[s + 1];
        var p3 = run[s + 2] || run[s + 1];

        // Catmull-Rom 切线，但把控制柄长度夹到线段长度的 0.42 倍，
        // 否则拐角处会出现数十像素的外爆环（打圈）
        var segLen = Geom.dist(p1, p2);
        var maxH = segLen * 0.42;

        var ax = (p2.x - p0.x) * smooth / 6, ay = (p2.y - p0.y) * smooth / 6;
        var am = Math.sqrt(ax * ax + ay * ay);
        if (am > maxH && am > 1e-6) { ax = ax / am * maxH; ay = ay / am * maxH; }

        var bx = (p3.x - p1.x) * smooth / 6, by = (p3.y - p1.y) * smooth / 6;
        var bm = Math.sqrt(bx * bx + by * by);
        if (bm > maxH && bm > 1e-6) { bx = bx / bm * maxH; by = by / bm * maxH; }

        d += 'C' + f(p1.x + ax) + ',' + f(p1.y + ay) + ' ' +
          f(p2.x - bx) + ',' + f(p2.y - by) + ' ' + f(p2.x) + ',' + f(p2.y);
      }
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

    return {
      svg: svg,
      w: w, h: h, strokeWidth: sw,            // 供预览层重建带颜色的 svg
      ds: ds,                                  // 每段的 d，供预览层分色/点选
      lengths: lengths,                        // 每段折线长度
      pathCount: ds.length,
      d: ds.join(' '),
      points: usedPoints
    };
  };

  global.SvgBuilder = SvgBuilder;
})(typeof window !== 'undefined' ? window : globalThis);
