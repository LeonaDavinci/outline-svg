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
      singlePath: opts.singlePath
    });
    var t3 = performance.now();

    state.result = { sk: sk, weld: welded, out: out, opts: opts, eps: eps, strokeW: strokeW };
    state.svg = out.svg;
    el('svgCode').value = out.svg;
    el('svgPreview').innerHTML = out.svg;
    el('svgCount').textContent = out.pathCount + ' 段';
    el('exportBtn').disabled = false;

    drawSkeleton(sk, welded);
    drawOverlay(sk, welded, strokeW);

    renderStats(sk, welded, out, eps, strokeW, t1 - t0, t2 - t1, t3 - t2);
    setStatus('完成，用时 ' + (t3 - t0).toFixed(0) + ' ms');
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
    el('toggleCodeBtn').addEventListener('click', function () {
      var ta = el('svgCode');
      ta.style.display = ta.style.display === 'block' ? 'none' : 'block';
    });
    el('resetBtn').addEventListener('click', resetParams);
    el('sampleBtn').addEventListener('click', loadSample);

    el('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var img = new Image();
      img.onload = function () { loadImage(img); };
      img.src = URL.createObjectURL(f);
    });

    // 拖放
    var dz = document.body;
    ['dragover', 'drop'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/^image\//.test(f.type)) return;
      var img = new Image();
      img.onload = function () { loadImage(img); };
      img.src = URL.createObjectURL(f);
    });
  }

  function resetParams() {
    var defs = {
      threshold: 128, widthOverride: 0, residual: 1.2, pruneK: 1.2, gapK: 1.0,
      minLenK: 1.0, maxTurn: 90, epsK: 0.06, smooth: 0.9, cornerDeg: 55, strokeFixed: 2
    };
    Object.keys(defs).forEach(function (k) {
      el(k).value = defs[k];
      el(k).dispatchEvent(new Event('input'));
    });
    el('autoThreshold').checked = false;
    el('autoWidth').checked = true;
    el('autoStroke').checked = true;
    el('throughJunction').checked = true;
    el('facing').checked = true;
    el('singlePath').checked = true;
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
