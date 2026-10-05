// charts.js number formatting: counts are EXACT, never abbreviated.
//
//   node --test tests/analytics/charts-format.test.js
//
// The bug: PT_CHART.fmtNum() turned >= 1,000 into "1K" and >= 1,000,000 into
// "1M", so the Website Overview's Page views / Total visitors read "1K" for any
// count from 950 to 1,049 (and "1.2K" for 1,234). The admin wants the real
// number. These tests load the REAL charts.js into a vm (it has no DOM needs at
// load time) and pin the formatter and the three charts that use it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'charts.js'), 'utf8');
function load() {
  const ctx = vm.createContext({});
  vm.runInContext(SRC, ctx);
  return ctx.PT_CHART;
}
const C = load();

// A container stub: the renderers only set innerHTML, read clientWidth and call
// querySelectorAll (tooltip wiring) on it.
function render(fn, opts) {
  const el = { innerHTML: '', clientWidth: 640, querySelectorAll: () => [] };
  C[fn](el, opts);
  return el.innerHTML;
}
const texts = html => [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
const tips = html => [...html.matchAll(/data-tip="([^"]*)"/g)].map(m => m[1]);

test('fmtNum: the examples from the requirement, exactly', () => {
  assert.equal(C.fmtNum(1000), '1,000');
  assert.equal(C.fmtNum(1234), '1,234');
  assert.equal(C.fmtNum(12500), '12,500');
});

test('fmtNum: small, large and huge counts', () => {
  assert.equal(C.fmtNum(0), '0');
  assert.equal(C.fmtNum(7), '7');
  assert.equal(C.fmtNum(999), '999');
  assert.equal(C.fmtNum(125000), '125,000');
  assert.equal(C.fmtNum(1000000), '1,000,000');
  assert.equal(C.fmtNum(1234567), '1,234,567');
  assert.equal(C.fmtNum(2500000000), '2,500,000,000');
});

test('fmtNum: never emits K / M / B (any case) or a decimal point for any count', () => {
  const samples = [];
  for (let n = 0; n <= 3000; n += 7) samples.push(n);
  for (const n of [9999, 10000, 99999, 100000, 999999, 1e6, 1.5e6, 1e7, 123456789, 1e9, 1e10, 1e12]) samples.push(n);
  for (const n of samples) {
    const out = C.fmtNum(n);
    assert.doesNotMatch(out, /[kKmMbB]/, 'abbreviated: fmtNum(' + n + ') = ' + out);
    assert.doesNotMatch(out, /\./, 'decimal in a count: fmtNum(' + n + ') = ' + out);
    assert.equal(Number(out.replace(/,/g, '')), n, 'not exact: fmtNum(' + n + ') = ' + out);
  }
});

test('fmtNum: 950-1,049 no longer collapse to the same "1K"', () => {
  const seen = new Set();
  for (let n = 950; n <= 1049; n++) seen.add(C.fmtNum(n));
  assert.equal(seen.size, 100, 'every count in the old "1K" band must read differently');
});

test('fmtNum: non-numbers, negatives and -0', () => {
  for (const v of [null, undefined, NaN, 'abc']) assert.equal(C.fmtNum(v), '0');
  assert.equal(C.fmtNum(-1500), '-1,500');
  assert.equal(C.fmtNum(-0.2), '0', 'a rounded -0 must not print as "-0"');
  assert.equal(C.fmtNum('1500'), '1,500');
});

test('fmtNum: counts are whole numbers (display-only rounding, as before)', () => {
  assert.equal(C.fmtNum(1499.6), '1,500');
  assert.equal(C.fmtNum(12.4), '12');
});

test('fmtNum does not depend on the browser locale (en-US separators)', () => {
  const orig = Number.prototype.toLocaleString;
  // A de-DE-style browser would print 1.234 by default; the explicit locale must win.
  Number.prototype.toLocaleString = function (loc, o) { return orig.call(this, loc === undefined ? 'de-DE' : loc, o); };
  try { assert.equal(load().fmtNum(1234567), '1,234,567'); } finally { Number.prototype.toLocaleString = orig; }
});

test('line chart: y-axis labels and tooltips are exact, and the gutter widens to fit them', () => {
  const pts = [1000, 12500, 125000].map((y, i) => ({ x: i, y }));
  const html = render('renderLineChart', { series: [{ label: 'Views', points: pts }], xLabels: ['a', 'b', 'c'] });
  const axis = texts(html).filter(t => /^[\d,]+$/.test(t));
  assert.deepEqual(axis, ['0', '50,000', '100,000', '150,000', '200,000']);
  assert.ok(texts(html).filter(t => /\d/.test(t)).every(t => /^[\d,]+$/.test(t)), 'every numeric SVG label is plain digits and commas');
  const t = tips(html);
  assert.ok(t.some(x => x.includes('Views: 1,000')) && t.some(x => x.includes('Views: 12,500')) && t.some(x => x.includes('Views: 125,000')), t.join('|'));
  // The axis text is right-anchored at (padL - 8). "200,000" is 7 chars ~ 42px at 10px, so the
  // anchor must be at least that far from the SVG's left edge or the label is clipped.
  const anchor = Math.max(...[...html.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end"/g)].map(m => Number(m[1])));
  assert.ok(anchor >= 7 * 6, 'axis labels have room: anchor x=' + anchor);
  assert.ok(anchor > 32, 'gutter grew past the old fixed 40px');
});

test('line chart: small counts keep the original 40px gutter', () => {
  const html = render('renderLineChart', { series: [{ points: [{ x: 0, y: 3 }, { x: 1, y: 9 }] }] });
  const axisX = Math.max(...[...html.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end"/g)].map(m => Number(m[1])));
  assert.equal(axisX, 32);
});

test('bar chart: value labels and tooltips are exact, and the bar leaves room for the label', () => {
  const html = render('renderBarChart', { rows: [{ label: 'A', value: 12500 }, { label: 'B', value: 1000 }, { label: 'C', value: 1234567 }] });
  const labels = texts(html);
  for (const want of ['12,500', '1,000', '1,234,567']) assert.ok(labels.includes(want), want + ' in ' + labels.join('|'));
  assert.ok(tips(html).includes('A: 12,500') && tips(html).includes('C: 1,234,567'));
  assert.ok(labels.filter(t => /^[\d,]+$/.test(t) === false).every(t => /^[ABC]$/.test(t)), 'only the row labels are non-numeric: ' + labels.join('|'));
  // widest bar ends at labelW(140) + w; its value label (9 chars ~63px) must still fit inside W=640.
  const W = 640;
  const longest = [...html.matchAll(/<text x="([\d.]+)" y="[\d.]+" font-size="11" fill="[^"]+" font-weight="600">1,234,567<\/text>/g)];
  assert.equal(longest.length, 1);
  assert.ok(Number(longest[0][1]) + 9 * 7 <= W, 'longest value label stays inside the SVG: x=' + longest[0][1]);
});

test('donut chart: centre total and slice tooltips are exact', () => {
  const html = render('renderDonutChart', { slices: [{ label: 'Direct', value: 8000 }, { label: 'Facebook', value: 4500 }] });
  assert.ok(texts(html).includes('12,500'), 'centre total: ' + texts(html).join('|'));
  assert.ok(tips(html).some(t => t.startsWith('Direct: 8,000 (')), tips(html).join('|'));
  assert.ok(tips(html).some(t => t.startsWith('Facebook: 4,500 (')));
});

test('percentages, durations and decimals are untouched by the count formatter', () => {
  // Those cards are built in analytics.js without fmtNum: pin that they still are.
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'analytics.js'), 'utf8');
  assert.match(js, /statCard\('Avg session duration', fmtSeconds\(/);
  assert.match(js, /statCard\('Bounce rate', \(s\.bounce_rate \|\| 0\) \+ '%'/);
  assert.match(js, /statCard\('Pages \/ session', s\.avg_pages_per_session \|\| 0,/);
  assert.match(js, /d\.pct\.toFixed\(1\) \+ '% vs prev'|\$\{d\.pct\.toFixed\(1\)\}% vs prev/);
});

test('charts.js contains no abbreviation logic any more', () => {
  assert.doesNotMatch(SRC, /\+ 'K'|\+ 'M'|\+ 'B'/);
  assert.doesNotMatch(SRC, /1000000\)|\/ 1000\)\.toFixed/);
});
