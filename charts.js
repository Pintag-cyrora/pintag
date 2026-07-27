// charts.js — small, hand-rolled SVG chart module for analytics.html.
//
// No charting library exists anywhere in this codebase, and this repo's own
// convention (terminology.js, components.js, tracking.js, insight-engine.js,
// ...) is zero external dependencies -- plain JS, no build step. This file
// follows the same convention rather than pulling in a CDN chart library.
//
// Palette: Pintag's own teal (--teal #2D8C8C) carries every single-series
// chart (trend lines, magnitude bars) -- it's the site's one established
// brand hue. For genuine multi-category identity (traffic source, browser,
// device breakdown) this uses the dataviz skill's validated 8-hue
// categorical reference palette (blue/orange/aqua/yellow/magenta/green/
// violet/red) rather than inventing new hues from scratch -- Pintag has no
// second brand hue to build a categorical theme from, and this order is
// already proven CVD-safe (validated against this page's own white card
// surface, not just the skill's generic default). Status colors (good/
// warning/critical) reuse intelligence.html's existing --green/--gold/--red.
//
// Every chart ships a legend when it has ≥2 series, a hover tooltip, and a
// same-data <table> alternative (built by the caller from the same rows --
// see analytics.html) so contrast-WARN slots (yellow/aqua/magenta on white)
// always have the required relief channel.

var PT_CHART = (function () {
  var CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  var TEAL = '#2D8C8C';
  var TEAL_WASH = 'rgba(45,140,140,0.10)';
  var INK = '#1A2428';
  var INK_SOFT = '#3D5058';
  var INK_MUTED = '#7A9098';
  var GRID = '#EDE8E0';
  var AXIS = '#D8D2C6';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return Math.round(n).toLocaleString();
  }

  function niceMax(v) {
    if (v <= 0) return 10;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var norm = v / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  // Shared floating tooltip -- one DOM node reused across every chart on the
  // page, matching how a real GA-style tool never allocates N tooltip divs.
  var tooltipEl = null;
  function getTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'pt-chart-tooltip';
    tooltipEl.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;background:' + INK + ';color:#fff;font:500 11.5px "DM Sans",sans-serif;padding:6px 10px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.18);display:none;white-space:nowrap;';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }
  function showTooltip(x, y, html) {
    var t = getTooltip();
    t.innerHTML = html;
    t.style.left = (x + 14) + 'px';
    t.style.top = (y - 10) + 'px';
    t.style.display = 'block';
  }
  function hideTooltip() { if (tooltipEl) tooltipEl.style.display = 'none'; }

  function legendHtml(labels, colors) {
    if (labels.length < 2) return '';
    return '<div class="pt-chart-legend" style="display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:10px;font-size:11px;color:' + INK_SOFT + ';">' +
      labels.map(function (l, i) {
        return '<span style="display:inline-flex;align-items:center;gap:5px;"><span style="width:9px;height:9px;border-radius:2px;background:' + (colors[i] || TEAL) + ';display:inline-block;"></span>' + esc(l) + '</span>';
      }).join('') + '</div>';
  }

  // ── Line/area chart: trend over time, one or more series ──────────────
  // opts: { series: [{label, color?, points:[{x,y}]}], width, height, yFormat }
  function renderLineChart(container, opts) {
    var W = opts.width || container.clientWidth || 640, H = opts.height || 220;
    var padL = 40, padR = 12, padT = 14, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var series = opts.series || [];
    var allPoints = series.reduce(function (a, s) { return a.concat(s.points); }, []);
    if (!allPoints.length) { container.innerHTML = emptyState(opts.emptyLabel); return; }
    var n = series[0].points.length;
    var maxY = niceMax(Math.max.apply(null, allPoints.map(function (p) { return p.y; }).concat([1])));
    var x = function (i) { return padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW); };
    var y = function (v) { return padT + plotH - (v / maxY) * plotH; };

    var gridLines = '';
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var gy = padT + plotH - (g / ticks) * plotH;
      gridLines += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="' + GRID + '" stroke-width="1"/>';
      gridLines += '<text x="' + (padL - 8) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="10" fill="' + INK_MUTED + '">' + fmtNum((maxY / ticks) * g) + '</text>';
    }

    var seriesSvg = series.map(function (s, si) {
      var color = s.color || (series.length > 1 ? CATEGORICAL[si % CATEGORICAL.length] : TEAL);
      var pathD = s.points.map(function (p, i) { return (i === 0 ? 'M' : 'L') + x(i) + ',' + y(p.y); }).join(' ');
      var areaD = pathD + ' L' + x(s.points.length - 1) + ',' + (padT + plotH) + ' L' + x(0) + ',' + (padT + plotH) + ' Z';
      var last = s.points[s.points.length - 1];
      return (series.length === 1 ? '<path d="' + areaD + '" fill="' + color + '" opacity="0.10" stroke="none"/>' : '') +
        '<path d="' + pathD + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<circle cx="' + x(s.points.length - 1) + '" cy="' + y(last.y) + '" r="4" fill="' + color + '" stroke="#fff" stroke-width="2"/>';
    }).join('');

    // Invisible hover rails -- one per x position, full plot height, so
    // hovering anywhere near a point shows its tooltip (a bare 8px dot is
    // too small a hit target on its own, per the interaction spec).
    var hoverRails = '';
    for (var i = 0; i < n; i++) {
      var label = opts.xLabels ? opts.xLabels[i] : String(i);
      var lines = series.map(function (s) { return (s.label ? esc(s.label) + ': ' : '') + fmtNum(s.points[i].y); }).join('<br>');
      hoverRails += '<rect data-i="' + i + '" x="' + (x(i) - (plotW / Math.max(n - 1, 1)) / 2) + '" y="' + padT + '" width="' + (plotW / Math.max(n - 1, 1)) + '" height="' + plotH + '" fill="transparent" style="cursor:crosshair;" data-tip="' + esc(label) + '<br>' + lines.replace(/"/g, '&quot;') + '"/>';
    }

    var xLabelsSvg = '';
    var labelEvery = Math.max(1, Math.ceil(n / 7));
    for (var li = 0; li < n; li += labelEvery) {
      xLabelsSvg += '<text x="' + x(li) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="' + INK_MUTED + '">' + esc(opts.xLabels ? opts.xLabels[li] : li) + '</text>';
    }

    container.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="' + esc(opts.ariaLabel || 'Trend chart') + '">' +
        gridLines + seriesSvg + xLabelsSvg + hoverRails +
      '</svg>' +
      legendHtml(series.map(function (s) { return s.label; }).filter(Boolean), series.map(function (s, i) { return s.color || CATEGORICAL[i % CATEGORICAL.length]; }));

    wireHover(container);
  }

  // ── Bar chart: horizontal ranking (top listings, districts, ...) ──────
  // opts: { rows: [{label, value}], width, height, color, maxBars }
  function renderBarChart(container, opts) {
    var rows = (opts.rows || []).slice(0, opts.maxBars || 10);
    if (!rows.length) { container.innerHTML = emptyState(opts.emptyLabel); return; }
    var color = opts.color || TEAL;
    var maxV = niceMax(Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1])));
    var rowH = 28, labelW = opts.labelWidth || 140, W = opts.width || container.clientWidth || 640;
    var barAreaW = W - labelW - 56;
    var H = rows.length * rowH + 8;

    var bars = rows.map(function (r, i) {
      var w = Math.max(2, (r.value / maxV) * barAreaW);
      var cy = i * rowH + rowH / 2;
      return '<text x="' + (labelW - 8) + '" y="' + (cy + 4) + '" text-anchor="end" font-size="11.5" fill="' + INK_SOFT + '">' + esc(truncate(r.label, 22)) + '</text>' +
        '<rect x="' + labelW + '" y="' + (cy - 9) + '" width="' + w + '" height="18" rx="4" fill="' + color + '" data-tip="' + esc(r.label) + ': ' + fmtNum(r.value) + '" style="cursor:pointer;"/>' +
        '<text x="' + (labelW + w + 6) + '" y="' + (cy + 4) + '" font-size="11" fill="' + INK + '" font-weight="600">' + fmtNum(r.value) + '</text>';
    }).join('');

    container.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="img" aria-label="' + esc(opts.ariaLabel || 'Bar chart') + '">' + bars + '</svg>';
    wireHover(container);
  }

  // ── Donut chart: categorical share breakdown ────────────────────────
  // opts: { slices: [{label, value}], size }
  function renderDonutChart(container, opts) {
    var slices = (opts.slices || []).filter(function (s) { return s.value > 0; });
    if (!slices.length) { container.innerHTML = emptyState(opts.emptyLabel); return; }
    var size = opts.size || 200, r = size / 2 - 10, cx = size / 2, cy = size / 2, rInner = r * 0.6;
    var total = slices.reduce(function (a, s) { return a + s.value; }, 0);
    var angle = -Math.PI / 2;
    var GAP = 0.02; // radians, the surface-gap spacer between wedges
    var paths = slices.map(function (s, i) {
      var frac = s.value / total;
      var a0 = angle + GAP / 2, a1 = angle + frac * Math.PI * 2 - GAP / 2;
      angle += frac * Math.PI * 2;
      var large = (a1 - a0) > Math.PI ? 1 : 0;
      var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      var xi0 = cx + rInner * Math.cos(a1), yi0 = cy + rInner * Math.sin(a1);
      var xi1 = cx + rInner * Math.cos(a0), yi1 = cy + rInner * Math.sin(a0);
      var color = CATEGORICAL[i % CATEGORICAL.length];
      var d = 'M' + x0 + ',' + y0 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 + ' L' + xi0 + ',' + yi0 + ' A' + rInner + ',' + rInner + ' 0 ' + large + ' 0 ' + xi1 + ',' + yi1 + ' Z';
      var pct = Math.round(frac * 100);
      return '<path d="' + d + '" fill="' + color + '" data-tip="' + esc(s.label) + ': ' + fmtNum(s.value) + ' (' + pct + '%)" style="cursor:pointer;"/>';
    }).join('');

    container.innerHTML =
      '<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">' +
        '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" role="img" aria-label="' + esc(opts.ariaLabel || 'Share breakdown') + '">' + paths +
          '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" font-size="15" font-weight="700" fill="' + INK + '">' + fmtNum(total) + '</text>' +
        '</svg>' +
        '<div style="flex:1;min-width:140px;">' + legendHtml(slices.map(function (s) { return s.label + ' (' + Math.round(s.value / total * 100) + '%)'; }), slices.map(function (_, i) { return CATEGORICAL[i % CATEGORICAL.length]; })) + '</div>' +
      '</div>';
    wireHover(container);
  }

  // ── Sparkline: 12-point trend for a stat tile ──────────────────────
  function renderSparkline(container, points, color) {
    if (!points || points.length < 2) { container.innerHTML = ''; return; }
    var W = 90, H = 26, pad = 3;
    var max = Math.max.apply(null, points.concat([1])), min = Math.min.apply(null, points.concat([0]));
    var range = (max - min) || 1;
    var x = function (i) { return pad + (i / (points.length - 1)) * (W - pad * 2); };
    var y = function (v) { return H - pad - ((v - min) / range) * (H - pad * 2); };
    var d = points.map(function (v, i) { return (i === 0 ? 'M' : 'L') + x(i) + ',' + y(v); }).join(' ');
    var last = points[points.length - 1];
    container.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      '<path d="' + d + '" fill="none" stroke="' + (color || TEAL) + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + x(points.length - 1) + '" cy="' + y(last) + '" r="2.5" fill="' + (color || TEAL) + '"/>' +
      '</svg>';
  }

  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function emptyState(label) {
    return '<div style="padding:32px 16px;text-align:center;color:' + INK_MUTED + ';font-size:12.5px;">' + esc(label || 'No data in this period yet.') + '</div>';
  }

  function wireHover(container) {
    container.querySelectorAll('[data-tip]').forEach(function (el) {
      el.addEventListener('mousemove', function (e) { showTooltip(e.clientX, e.clientY, el.getAttribute('data-tip')); });
      el.addEventListener('mouseleave', hideTooltip);
    });
  }

  return {
    renderLineChart: renderLineChart,
    renderBarChart: renderBarChart,
    renderDonutChart: renderDonutChart,
    renderSparkline: renderSparkline,
    fmtNum: fmtNum,
    CATEGORICAL: CATEGORICAL,
    TEAL: TEAL
  };
})();
