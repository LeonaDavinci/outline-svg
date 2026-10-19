/* =============================================================
 * app.js  —  UI 与流水线编排
 * 只做 DOM / Canvas / 文件读写，不含任何算法。
 * 流水线：Skeleton.build → LineMerge.weld → SvgBuilder.build
 * ============================================================= */
(function () {
  'use strict';

  var MAX_DIM = 1600;      // 工作分辨率上限，超过则等比缩小（不影响矢量质量）

  var el = function (id) { return document.getElementById(id); };
  var state = {
    img: null,
    workData: null,
    w: 0, h: 0,
    scale: 1,
    result: null,
    selected: new Set(),
    segments: [],
    removed: new Set(),
    undoStack: [],
    svg: ''
  };

  /* ---------------- 参数读取 ---------------- */
  var P = {
    autoThreshold: 'autoThreshold',
    threshold: 'threshold',
    polarity: 'polarity',
    autoWidth: 'autoWidth',
    widthOverride: 'widthOverride',
    residual: 'residual',
    pruneK: 'pruneK',
    gapK: 'gapK',
    minLenK: 'minLenK',
    throughJunction: 'throughJunction',
    maxTurn: 'maxTurn',
    tMode: 'tMode',
    facing: 'facing',
    epsK: 'epsK',
    smooth: 'smooth',
    cornerDeg: 'cornerDeg',
    autoStroke: 'autoStroke',
    strokeFixed: 'strokeFixed',
    singlePath: 'singlePath',
    cuspCorner: 'cuspCorner',
    strokeColor: 'strokeColor',
    decimals: 'decimals'
  };

  function num(id) { return parseFloat(el(id).value); }
  function chk(id) { return el(id).checked; }

  function readOpts() {
    return {
      threshold: chk(P.autoThreshold) ? 0 : Math.round(num(P.threshold)),
      polarity: el(P.polarity).value,
      minComponentArea: 4,
      widthOverride: chk(P.autoWidth) ? 0 : num(P.widthOverride),
      residual: num(P.residual),
      pruneK: num(P.pruneK),
      gapK: num(P.gapK),
      minLenK: num(P.minLenK),
      throughJunction: chk(P.throughJunction),
      maxTurn: num(P.maxTurn),
      tMode: el(P.tMode).value,
      facing: chk(P.facing),
      epsK: num(P.epsK),
      smooth: num(P.smooth),
      cornerDeg: num(P.cornerDeg),
      autoStroke: chk(P.autoStroke),
      strokeFixed: num(P.strokeFixed),
      singlePath: chk(P.singlePath),
      cuspCorner: chk(P.cuspCorner),
      color: el(P.strokeColor).value,
      decimals: parseInt(el(P.decimals).value, 10)
    };
  }

  /* ---------------- 图像载入 ---------------- */
  function loadImage(img) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, MAX_DIM / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));

    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);

    state.img = img;
    state.w = cw; state.h = ch;
    state.scale = scale;
    state.workData = ctx.getImageData(0, 0, cw, ch);

    var src = el('canvasSrc');
    src.width = cw; src.height = ch;
    src.getContext('2d').drawImage(c, 0, 0);

    el('canvasSkel').width = cw;
    el('canvasSkel').height = ch;
    el('canvasOverlay').width = cw;
    el('canvasOverlay').height = ch;

    el('imgInfo').textContent = '原始 ' + w + '×' + h +
      (scale < 1 ? '（已缩放到 ' + cw + '×' + ch + ' 处理）' : '');

    el('runBtn').disabled = false;
    el('runBtn2').disabled = false;
    el('exportBtn').disabled = true;
    el('svgCode').value = '';
    el('svgPreview').innerHTML = '';
    el('svgCount').textContent = '—';
    state.selected = new Set();
    state.segments = [];
    state.removed = new Set();
    state.undoStack = [];
    state.result = null;
    el('segInfo').textContent = '共 0 段 · 拖拽可框选，Ctrl+拖拽追加多选';
    el('delBtn').disabled = true;
    el('undoBtn').disabled = true;
    el('clearSelBtn').disabled = true;
    clearCanvas('canvasSkel', '#ffffff');
    clearCanvas('canvasOverlay', '#ffffff');
    setStatus('图像已载入，点击「提取骨架并矢量化」');
  }

  function clearCanvas(id, color) {
    var c = el(id), ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
  }

  function setStatus(s) { el('status').textContent = s; }

  function setRunEnabled(on) {
    el('runBtn').disabled = !on;
    el('runBtn2').disabled = !on;
  }

  /* ---------------- 主流程 ---------------- */
  function run() {
    if (!state.workData) return;
    setStatus('计算中…');
    setRunEnabled(false);

    // 让浏览器先把状态刷出来再跑重活
    setTimeout(function () {
      try {
        doRun();
      } catch (err) {
        console.error(err);
        setStatus('出错：' + err.message);
      } finally {
        setRunEnabled(true);
      }
    }, 16);
  }

  function doRun() {
    var opts = readOpts();
    var t0 = performance.now();

    var sk = Skeleton.build(state.workData, opts);
    var t1 = performance.now();

    var welded = LineMerge.weld(sk.graph, {
      width: sk.width,
      pruneK: opts.pruneK,
      gapK: opts.gapK,
      minLenK: opts.minLenK,
      throughJunction: opts.throughJunction,
      maxTurn: opts.maxTurn,
      tMode: opts.tMode,
      facing: opts.facing
    });
    var t2 = performance.now();

    var eps = Math.max(0.25, opts.epsK * sk.width);
    var strokeW = opts.autoStroke ? Math.max(0.4, sk.width) : opts.strokeFixed;

    var out = SvgBuilder.build(welded.paths, {
      w: sk.w, h: sk.h,
      eps: eps,
      smooth: opts.smooth,
      cornerDeg: opts.cornerDeg,
      strokeWidth: +strokeW.toFixed(2),
      color: opts.color,
      padding: 4,
      decimals: opts.decimals,
      singlePath: opts.singlePath,
      cuspCorner: opts.cuspCorner
    });
    var t3 = performance.now();

    state.result = {
      sk: sk, weld: welded, out: out, opts: opts, eps: eps, strokeW: strokeW,
      svgOpts: {
        w: sk.w, h: sk.h, eps: eps, smooth: opts.smooth, cornerDeg: opts.cornerDeg,
        strokeWidth: +strokeW.toFixed(2), color: opts.color, padding: 4,
        decimals: opts.decimals, singlePath: opts.singlePath, cuspCorner: opts.cuspCorner
      }
    };
    state.svg = out.svg;
    state.selected = new Set();
    state.removed = new Set();
    state.undoStack = [];
    el('svgCode').value = out.svg;
    renderPreview(out, strokeW);
    el('svgCount').textContent = out.pathCount === out.subpaths
      ? out.pathCount + ' 段'
      : out.pathCount + ' 段 / ' + out.subpaths + ' 子路径';
    el('exportBtn').disabled = false;

    drawSkeleton(sk, welded);
    drawOverlay(sk, welded, strokeW);

    renderStats(sk, welded, out, eps, strokeW, t1 - t0, t2 - t1, t3 - t2);
    setStatus('完成，用时 ' + (t3 - t0).toFixed(0) + ' ms');
  }

  /* ================= 分段着色 + 点选预览 ================= */

  // 高对比、明亮的离散色环，保证相邻段一眼能分开
  var SEG_COLORS = [
    '#1666d6', '#e8380d', '#12a150', '#8b5cf6', '#ff8a00',
    '#0e9bb0', '#d81b60', '#2f7d32', '#c026d3', '#0b7285'
  ];

  function segColor(i) { return SEG_COLORS[i % SEG_COLORS.length]; }

  /**
   * 用「每段一个 path + 透明加粗命中层」重建预览，
   * 命中层比可见线条宽出一圈，手指/鼠标稍微偏一点也能选中。
   */
  function renderPreview(out, strokeW) {
    var host = el('svgPreview');
    // 记录每段的点列，供框选做命中测试
    state.segments = [];
    for (var i = 0; i < out.ds.length; i++) {
      state.segments.push({
        i: i, d: out.ds[i],
        pts: (out.polys && out.polys[i]) || [],
        len: (out.lengths && out.lengths[i]) || 0
      });
    }
    paintPreview();
  }

  function paintPreview() {
    var host = el('svgPreview');
    var segs = state.segments || [];
    if (!segs.length) {
      host.innerHTML = '<span class="svg-empty">' +
        (state.removed && state.removed.size ? '所有线段已删除，点「撤销」可恢复' : '没有可显示的线段') +
        '</span>';
      updateSegInfo();
      return;
    }
    var base = (state.result && state.result.strokeW) || 2;
    var hitW = Math.max(base + 8, 10);
    var parts = [], hits = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      parts.push('<path class="seg" data-i="' + s.i + '" d="' + s.d +
        '" stroke="' + segColor(s.i) + '" stroke-width="' + base + '"/>');
      hits.push('<path class="hit" data-i="' + s.i + '" d="' + s.d +
        '" stroke-width="' + hitW.toFixed(1) + '"/>');
    }
    var first = segs[0];
    var vb = (state.result && state.result.out) ? state.result.out : null;
    var w = vb ? vb.w : 100, h = vb ? vb.h : 100;
    host.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ' +
      (w + 8) + ' ' + (h + 8) + '" width="' + w + '" height="' + h +
      '" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<g class="segs">' + parts.join('') + '</g>' +
      '<g class="hits">' + hits.join('') + '</g></svg>';
    applySelection();
  }

  function updateSegInfo() {
    var box = el('segInfo');
    if (!box) return;
    var sel = state.selected || new Set();
    var total = (state.segments || []).length;
    var removed = state.removed ? state.removed.size : 0;
    var head = '当前 ' + total + ' 段' + (removed ? '（已删 ' + removed + '）' : '');
    if (!sel.size) {
      box.textContent = head + ' · 拖拽可框选，Ctrl+拖拽追加多选';
      return;
    }
    var totalLen = 0, idx = [];
    sel.forEach(function (i) {
      var seg = (state.segments || []).filter(function (s) { return s.i === i; })[0];
      totalLen += seg ? seg.len : 0;
      idx.push(i);
    });
    idx.sort(function (a, b) { return a - b; });
    box.innerHTML = head + ' · 已选 <b>' + idx.length + '</b> 段（#' +
      idx.map(function (v) { return v + 1; }).join(', #') + '）· 合计 ' + totalLen.toFixed(0) + ' px';
  }

  function applySelection() {
    var host = el('svgPreview');
    var segs = host.querySelectorAll('.seg');
    var sel = state.selected;
    var base = (state.result && state.result.strokeW) || 2;
    for (var i = 0; i < segs.length; i++) {
      var on = sel.has(parseInt(segs[i].getAttribute('data-i'), 10));
      segs[i].classList.toggle('sel', on);
      segs[i].classList.toggle('dim', sel.size > 0 && !on);
      segs[i].setAttribute('stroke-width', on ? +(base * 1.8).toFixed(2) : base);
    }
    el('delBtn').disabled = sel.size === 0;
    el('clearSelBtn').disabled = sel.size === 0;
    el('undoBtn').disabled = !state.undoStack || state.undoStack.length === 0;
    updateSegInfo();
  }

  /* ---------------- 删除 / 撤销 ---------------- */
  function rebuildAfterEdit() {
    var r = state.result;
    if (!r) return;
    var removed = state.removed;
    var kept = [];
    for (var i = 0; i < r.weld.paths.length; i++) if (!removed.has(i)) kept.push(r.weld.paths[i]);
    var out = SvgBuilder.build(kept, r.svgOpts);
    r.out = out;
    state.svg = out.svg;
    el('svgCode').value = out.svg;
    el('svgCount').textContent = out.pathCount === out.subpaths
      ? out.pathCount + ' 段'
      : out.pathCount + ' 段 / ' + out.subpaths + ' 子路径';
    renderPreview(out, r.strokeW);
  }

  function deleteSelected() {
    var sel = state.selected;
    if (!sel || !sel.size || !state.result) return;
    var batch = Array.from(sel).sort(function (a, b) { return a - b; });
    if (!state.removed) state.removed = new Set();
    if (!state.undoStack) state.undoStack = [];
    state.undoStack.push(batch);
    batch.forEach(function (i) { state.removed.add(i); });
    state.selected = new Set();
    rebuildAfterEdit();
  }

  function undoDelete() {
    var stack = state.undoStack;
    if (!stack || !stack.length || !state.result) return;
    var batch = stack.pop();
    batch.forEach(function (i) { state.removed.delete(i); });
    state.selected = new Set();
    rebuildAfterEdit();
  }

  function selectAll() {
    state.selected = new Set((state.segments || []).map(function (s) { return s.i; }));
    applySelection();
  }

  function bindPreviewSelect() {
    var host = el('svgPreview');
    var dragged = false;      // 框选结束后紧随的那次 click 要忽略，否则单段会被误选

    /* --- 单击 / Shift 点击 --- */
    host.addEventListener('click', function (e) {
      if (dragged) { dragged = false; return; }
      if (!state.result) return;
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var i = t.getAttribute('data-i');
      if (i === null || i === undefined) {          // 点在空白处
        if (state.selected.size) { state.selected.clear(); applySelection(); }
        return;
      }
      i = parseInt(i, 10);
      if (!state.selected) state.selected = new Set();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (state.selected.has(i)) state.selected.delete(i); else state.selected.add(i);
      } else {
        var only = state.selected.size === 1 && state.selected.has(i);
        state.selected.clear();
        if (!only) state.selected.add(i);
      }
      applySelection();
    });

    /* --- 框选：拖拽画框，Ctrl 追加 --- */
    var drag = null;
    host.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || !state.result) return;
      var r = host.getBoundingClientRect();
      drag = { x0: e.clientX - r.left, y0: e.clientY - r.top, box: r, moved: false, add: !!(e.ctrlKey || e.metaKey || e.shiftKey) };
    });
    host.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var x = e.clientX - drag.box.left, y = e.clientY - drag.box.top;
      if (!drag.moved && Math.abs(x - drag.x0) + Math.abs(y - drag.y0) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.el = document.createElement('div');
        drag.el.className = 'rubber';
        host.appendChild(drag.el);
        host.setPointerCapture && host.setPointerCapture(e.pointerId);
      }
      var l = Math.min(drag.x0, x), t = Math.min(drag.y0, y);
      drag.el.style.left = l + 'px';
      drag.el.style.top = t + 'px';
      drag.el.style.width = Math.abs(x - drag.x0) + 'px';
      drag.el.style.height = Math.abs(y - drag.y0) + 'px';
    });
    function endDrag(e) {
      if (!drag) return;
      var d = drag; drag = null;
      if (!d.moved) return;
      dragged = true;
      var x = e.clientX - d.box.left, y = e.clientY - d.box.top;
      if (d.el) d.el.remove();
      var rect = {
        x0: Math.min(d.x0, x), y0: Math.min(d.y0, y),
        x1: Math.max(d.x0, x), y1: Math.max(d.y0, y)
      };
      var hit = hitTest(rect);
      if (!d.add) state.selected = new Set();
      hit.forEach(function (i) { state.selected.add(i); });
      applySelection();
    }
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', function () {
      if (drag && drag.el) drag.el.remove();
      drag = null;
    });
  }

  /** 屏幕矩形 → SVG 坐标矩形，返回命中的线段下标 */
  function hitTest(rect) {
    var out = [];
    var svg = el('svgPreview').querySelector('svg');
    if (!svg) return out;
    var r = svg.getBoundingClientRect();
    var host = el('svgPreview').getBoundingClientRect();
    var vb = (svg.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number);
    var sx = vb[2] / r.width, sy = vb[3] / r.height;
    var pad = 3;                                   // 放宽一点，手抖也能选到
    var X0 = (rect.x0 - (r.left - host.left)) * sx + vb[0] - pad;
    var X1 = (rect.x1 - (r.left - host.left)) * sx + vb[0] + pad;
    var Y0 = (rect.y0 - (r.top - host.top)) * sy + vb[1] - pad;
    var Y1 = (rect.y1 - (r.top - host.top)) * sy + vb[1] + pad;
    (state.segments || []).forEach(function (s) {
      var pts = s.pts;
      if (!pts.length) return;
      var stride = Math.max(1, Math.floor(pts.length / 120));
      for (var k = 0; k < pts.length; k += stride) {
        var p = pts[k];
        if (p.x >= X0 && p.x <= X1 && p.y >= Y0 && p.y <= Y1) { out.push(s.i); return; }
      }
    });
    return out;
  }

  /* ---------------- 预览绘制 ---------------- */
  function drawSkeleton(sk, welded) {
    var c = el('canvasSkel'), ctx = c.getContext('2d');
    var w = sk.w, h = sk.h;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // 中心线像素
    var img = ctx.createImageData(w, h);
    for (var i = 0; i < w * h; i++) {
      if (sk.center[i]) {
        img.data[i * 4] = 40; img.data[i * 4 + 1] = 40; img.data[i * 4 + 2] = 40;
        img.data[i * 4 + 3] = 255;
      } else {
        img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // 焊接后的路径（蓝色细线）
    ctx.strokeStyle = 'rgba(30,110,220,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    welded.paths.forEach(function (p) {
      p.pts.forEach(function (pt, k) {
        if (k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      });
    });
    ctx.stroke();

    // 端点（红色）
    var r = Math.max(1.6, sk.width * 0.45);
    ctx.fillStyle = '#e11900';
    welded.paths.forEach(function (p) {
      var a = p.pts[0], b = p.pts[p.pts.length - 1];
      ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
    });
  }

  function drawOverlay(sk, welded, strokeW) {
    var c = el('canvasOverlay'), ctx = c.getContext('2d');
    var w = sk.w, h = sk.h;

    // 底层：原图淡化
    var tmp = el('canvasSrc');
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.28;
    ctx.drawImage(tmp, 0, 0, w, h);
    ctx.globalAlpha = 1;

    // 上层：生成的矢量线
    ctx.strokeStyle = '#d81b00';
    ctx.lineWidth = Math.max(0.6, strokeW);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    welded.paths.forEach(function (p) {
      p.pts.forEach(function (pt, k) {
        if (k === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      });
    });
    ctx.stroke();
  }

  /* ---------------- 统计信息 ---------------- */
  function renderStats(sk, welded, out, eps, strokeW, tA, tB, tC) {
    var ws = sk.widthStats;
    var rows = [
      ['二值化阈值', sk.threshold.toFixed(0) + (sk.threshold === sk.autoThreshold ? '（Otsu 自动）' : '（手动）') + (sk.inverted ? '，已反相' : '')],
      ['估计线宽 W', ws.width.toFixed(2) + ' px' + (sk.widthAuto ? '（自动）' : '（手动）')],
      ['线宽分布 p10–p90', ws.p10.toFixed(2) + ' – ' + ws.p90.toFixed(2) + ' px' + (ws.uniform ? '，均匀' : '，<b>不均匀</b>')],
      ['骨架像素', sk.centerCount + ' px'],
      ['拓扑节点 / 边', sk.graph.nodes.length + ' 个 / ' + welded.stats.input + ' 条'],
      ['过节点合并后', welded.stats.afterJoin + ' 条'],
      ['缺口焊接后', welded.stats.afterBridge + ' 条'],
      ['T 型焊接后', welded.stats.afterAttach + ' 条'],
      ['最终路径', out.pathCount + ' 条（简化点 ' + out.points + '）'],
      ['导出子路径 (M 数)', out.subpaths + (out.subpaths === out.pathCount ? '，与段数一致' : '，多出来的来自尖角断开')],
      ['总长度', (welded.stats.totalLength / Math.max(1, sk.width) * 1).toFixed(0) + ' px（约 ' + (welded.stats.totalLength / sk.width).toFixed(1) + ' W）'],
      ['简化 ε / 描边', eps.toFixed(2) + ' px / ' + strokeW.toFixed(2) + ' px'],
      ['耗时', '二值 ' + sk.timing.bin.toFixed(0) + ' · EDT ' + sk.timing.edt.toFixed(0) +
        ' · 骨架 ' + sk.timing.skel.toFixed(0) + ' · 追踪 ' + sk.timing.trace.toFixed(0) +
        ' · 焊接 ' + tB.toFixed(0) + ' · 输出 ' + tC.toFixed(0) + ' ms']
    ];
    el('stats').innerHTML = rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>';
    }).join('');
  }

  /* ---------------- 滑块联动显示 ---------------- */
  function bindSlider(id, outId, fmt) {
    var input = el(id), out = el(outId);
    var upd = function () {
      out.textContent = fmt ? fmt(parseFloat(input.value)) : input.value;
    };
    input.addEventListener('input', upd);
    upd();
    return upd;
  }

  var refreshHints = [];

  function initUI() {
    bindSlider('threshold', 'thresholdVal', function (v) { return v.toFixed(0); });
    bindSlider('widthOverride', 'widthVal', function (v) { return v.toFixed(1); });
    bindSlider('residual', 'residualVal', function (v) { return v.toFixed(1); });
    bindSlider('pruneK', 'pruneVal', function (v) { return v.toFixed(1); });
    bindSlider('gapK', 'gapVal', function (v) { return v.toFixed(1); });
    bindSlider('minLenK', 'minLenVal', function (v) { return v.toFixed(1); });
    bindSlider('maxTurn', 'maxTurnVal', function (v) { return v.toFixed(0) + '°'; });
    bindSlider('epsK', 'epsVal', function (v) { return v.toFixed(3); });
    bindSlider('smooth', 'smoothVal', function (v) { return v.toFixed(2); });
    bindSlider('cornerDeg', 'cornerVal', function (v) { return v.toFixed(0) + '°'; });
    bindSlider('strokeFixed', 'strokeVal', function (v) { return v.toFixed(1); });

    // 系数 × 线宽 的实时提示
    function hint() {
      var W = 2;
      if (state.result && state.result.sk) W = state.result.sk.width;
      el('pruneHint').textContent = '≈ ' + (num('pruneK') * W).toFixed(1) + ' px';
      el('gapHint').textContent = '≈ ' + (num('gapK') * W).toFixed(1) + ' px';
      el('minLenHint').textContent = '≈ ' + (num('minLenK') * W).toFixed(1) + ' px';
      el('epsHint').textContent = '≈ ' + Math.max(0.25, num('epsK') * W).toFixed(2) + ' px';
    }
    ['pruneK', 'gapK', 'minLenK', 'epsK'].forEach(function (id) {
      el(id).addEventListener('input', hint);
    });
    refreshHints.push(hint);
    hint();

    el('autoThreshold').addEventListener('change', function () {
      el('threshold').disabled = this.checked;
    });
    el('autoWidth').addEventListener('change', function () {
      el('widthOverride').disabled = this.checked;
    });
    el('autoStroke').addEventListener('change', function () {
      el('strokeFixed').disabled = this.checked;
    });

    el('threshold').disabled = el('autoThreshold').checked;
    el('widthOverride').disabled = el('autoWidth').checked;
    el('strokeFixed').disabled = el('autoStroke').checked;

    el('runBtn').addEventListener('click', run);
    el('runBtn2').addEventListener('click', run);
    el('exportBtn').addEventListener('click', exportSvg);
    el('delBtn').addEventListener('click', deleteSelected);
    el('undoBtn').addEventListener('click', undoDelete);
    el('selectAllBtn').addEventListener('click', selectAll);
    el('clearSelBtn').addEventListener('click', function () {
      state.selected.clear();
      applySelection();
    });
    bindPreviewSelect();

    // 快捷键：Delete/Backspace 删除，Ctrl+Z 撤销
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selected && state.selected.size) { e.preventDefault(); deleteSelected(); }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undoDelete();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        selectAll();
      }
    });
    el('toggleCodeBtn').addEventListener('click', function () {
      var ta = el('svgCode');
      ta.style.display = ta.style.display === 'block' ? 'none' : 'block';
    });
    el('resetBtn').addEventListener('click', resetParams);
    el('sampleBtn').addEventListener('click', loadSample);

    el('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      showFileName(f);
      var img = new Image();
      img.onload = function () { loadImage(img); };
      img.src = URL.createObjectURL(f);
    });

    // 拖放：整页可接收，拖入时给出全屏提示
    var dz = document.body;
    var depth = 0;
    dz.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      document.body.classList.add('dragging');
    });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); });
    dz.addEventListener('dragleave', function (e) {
      e.preventDefault();
      if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); }
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/^image\//.test(f.type)) return;
      showFileName(f);
      var img = new Image();
      img.onload = function () { loadImage(img); };
      img.src = URL.createObjectURL(f);
    });
  }

  function showFileName(f) {
    var box = el('fileName');
    if (!box) return;
    var kb = (f.size / 1024).toFixed(f.size < 1024 * 1024 ? 1 : 0);
    box.textContent = f.name + '  ·  ' + kb + ' KB';
    box.classList.add('has-file');
  }

  function resetParams() {
    var defs = {
      threshold: 128, widthOverride: 2, residual: 1.2, pruneK: 3.4, gapK: 2.8,
      minLenK: 3.8, maxTurn: 145, epsK: 0.06, smooth: 0.9, cornerDeg: 55, strokeFixed: 2
    };
    Object.keys(defs).forEach(function (k) {
      el(k).value = defs[k];
      el(k).dispatchEvent(new Event('input'));
    });
    el('autoThreshold').checked = false;
    el('autoWidth').checked = true;
    el('autoStroke').checked = true;
    el('throughJunction').checked = true;
    el('facing').checked = false;
    el('singlePath').checked = true;
    el('cuspCorner').checked = true;
    el('tMode').value = 'snap';
    el('polarity').value = 'auto';
    el('threshold').disabled = false;
    el('widthOverride').disabled = true;
    el('strokeFixed').disabled = true;
    refreshHints.forEach(function (fn) { fn(); });
  }

  /* ---------------- 导出 ---------------- */
  function exportSvg() {
    if (!state.svg) return;
    var blob = new Blob([state.svg], { type: 'image/svg+xml;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'outline-' + state.w + 'x' + state.h + '.svg';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  /* ---------------- 内置示例图 ---------------- */
  function loadSample() {
    var W = 520, H = 360;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 5;              // 均匀线宽，用于验证宽度估计
    ctx.lineCap = 'round';
    ctx.lineJoin = 'miter';

    var L = function (x1, y1, x2, y2) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    // 方框
    ctx.beginPath();
    ctx.rect(50, 50, 150, 110);
    ctx.stroke();
    // 穿过方框的横线 + 竖线（十字交叉）
    L(20, 200, 480, 200);
    L(260, 40, 260, 320);
    // T 型
    L(330, 120, 470, 120);
    L(400, 120, 400, 250);
    // 圆弧
    ctx.beginPath();
    ctx.arc(120, 280, 55, Math.PI * 0.15, Math.PI * 1.1);
    ctx.stroke();
    // 断续短线（测试缺口焊接）
    L(440, 280, 470, 300);
    L(478, 306, 500, 322);

    var img = new Image();
    img.onload = function () { loadImage(img); setStatus('示例图已载入（线宽 5px），点击运行'); };
    img.src = c.toDataURL('image/png');
  }

  /* ---------------- 启动 ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    initUI();
    loadSample();
  });
})();
