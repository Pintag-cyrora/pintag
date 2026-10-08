// contact-intent-funnel.js — the funnel model + HTML, fed the REAL output of
// analytics_contact_intent_funnel() for the controlled Postgres fixtures
// (fixtures/*.json, see fixtures/README.md).
//
//   node --test tests/analytics/contact-intent-funnel.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CIF = require('../../contact-intent-funnel.js');
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const MAIN = () => load('contact-intent-funnel.rpc-output.json');
const EMPTY = () => load('contact-intent-funnel.rpc-output.empty.json');
const RES = () => load('contact-intent-funnel.rpc-output.resolution.json');          // Terms / Price & deposit scenarios
const V1 = () => load('contact-intent-funnel.rpc-output.v1.json');                   // the ORIGINAL function: no `resolution` block
const clone = (o) => JSON.parse(JSON.stringify(o));
const stage = (m, block, key) => m[block].find((r) => r.key === key);

test('rate: exact percentages, one decimal, and withheld below the volume floor', () => {
  assert.deepEqual(CIF.rate(1, 3, 1), { value: 33.3, text: '33.3%', suppressed: false, reason: null });
  assert.equal(CIF.rate(5, 40).text, '12.5%');
  assert.equal(CIF.rate(40, 40).text, '100%');
  assert.equal(CIF.rate(0, 40).text, '0%');
  assert.deepEqual(CIF.rate(3, 17), { value: null, text: '—', suppressed: true, reason: 'low-volume' });     // 17 < 30
  assert.deepEqual(CIF.rate(0, 0), { value: null, text: '—', suppressed: true, reason: 'none' });
  assert.equal(CIF.rate(-5, 40).text, '0%');                                                                 // junk can never produce a negative rate
  assert.equal(CIF.rate('x', 'y').suppressed, true);
});

test('buildModel on the controlled fixtures: every funnel count is exactly what the database produced', () => {
  const m = CIF.buildModel(MAIN());
  assert.equal(m.visits, 17);
  assert.equal(m.openEvents, 21);
  assert.equal(m.repeatOpenVisits, 1);
  assert.deepEqual(m.excluded, { nullSession: 1, nullProperty: 1 });
  // CONTACT INTENT
  assert.deepEqual(m.contactIntent.map((r) => [r.key, r.count]), [['opened', 17], ['chosen', 15], ['where', 3], ['price', 2], ['terms', 0], ['availability', 1], ['photos', 1], ['unit', 2]]);
  assert.equal(m.selfServiceVisits, 5);
  // HIGH-INTENT CONVERSION
  assert.deepEqual(m.highIntent.map((r) => [r.key, r.count]), [['book', 1], ['call', 2], ['whatsapp', 6], ['clicks', 6]]);
  assert.equal(m.agentContactVisits, 8);
  assert.deepEqual(m.contactClicks, { total: 7, call: 2, whatsapp: 5 });
  assert.deepEqual(m.unitFlow, { selected: 2, thenContact: 1 });
  // reconciliation
  assert.equal(m.clicks.total, 12);
  assert.deepEqual([m.clicks.viaAsk.total, m.clicks.direct.total, m.clicks.unlinked.total], [8, 2, 2]);
  assert.deepEqual([m.clicks.direct.call, m.clicks.direct.whatsapp], [1, 1]);        // direct Call and direct WhatsApp without Ask
  assert.deepEqual(m.integrity, [], 'the real RPC output satisfies every arithmetic invariant');
});

test('legacy contact-phone is folded into Call agent, the legacy WhatsApp ids into WhatsApp; both are reported as legacy', () => {
  const m = CIF.buildModel(MAIN());
  assert.equal(stage(m, 'highIntent', 'call').count, 2);            // channel=call (s03) + legacy contact-phone (s07)
  assert.equal(m.diagnostics.quality.legacyCallRows, 2);
  assert.equal(m.diagnostics.quality.legacyRows, 3);
  assert.equal(m.diagnostics.quality.newRowsWithoutMetadata, 2);
});

test('rates are withheld at 17 Ask visits (low volume) but counts are not; at >= 30 they appear', () => {
  const low = CIF.buildModel(MAIN());
  assert.equal(low.lowVolume, true);
  for (const r of low.highIntent.concat(low.contactIntent.slice(1))) assert.equal(r.rate.suppressed, true, r.key);
  assert.equal(low.kpis.selfServiceRate.text, '—');
  assert.equal(low.kpis.agentContactRate.text, '—');
  assert.equal(low.kpis.bookRate.text, '—');
  assert.ok(low.caveats.some((c) => c.id === 'volume'));

  const raw = MAIN();
  raw.ask.visits = 40; raw.contact_intent.intent_chosen_visits = 30; raw.contact_intent.self_service_visits = 10; raw.high_intent.agent_contact_visits = 8;
  raw.high_intent.book_visits = 2; raw.high_intent.high_intent_visits = 12;
  const m = CIF.buildModel(raw);
  assert.equal(m.lowVolume, false);
  assert.equal(m.kpis.selfServiceRate.text, '25%');
  assert.equal(m.kpis.agentContactRate.text, '20%');
  assert.equal(m.kpis.bookRate.text, '5%');
  assert.ok(!m.caveats.some((c) => c.id === 'volume'));
});

test('the headline KPIs are the six the dashboard promises', () => {
  const html = CIF.render(CIF.buildModel(MAIN()));
  for (const label of ['Ask visits', 'Self-service intent rate', 'Agent contact rate', 'Book-viewing rate', 'Call vs WhatsApp', 'Contact clicks']) {
    assert.ok(html.includes('>' + label + '<'), label);
  }
  const m = CIF.buildModel(MAIN());
  assert.deepEqual([m.kpis.callVisits, m.kpis.whatsappVisits], [2, 6]);
  assert.match(html, /data-kpi="call-vs-whatsapp"[^>]*>.*?2 : 6/s);
});

test('structure: CONTACT INTENT (8 rows) and HIGH-INTENT CONVERSION (4 rows), in the agreed order', () => {
  const html = CIF.render(CIF.buildModel(MAIN()));
  const order = (block) => [...html.split('data-block="' + block + '"')[1].split('</table>')[0].matchAll(/data-stage="([a-z]+)"/g)].map((x) => x[1]);
  assert.deepEqual(order('contact-intent'), ['opened', 'chosen', 'where', 'price', 'terms', 'availability', 'photos', 'unit']);
  assert.deepEqual(order('high-intent'), ['book', 'call', 'whatsapp', 'clicks']);
  assert.ok(html.indexOf('data-block="contact-intent"') < html.indexOf('data-block="high-intent"'));
});

test('self-service intents are never presented as failed conversion', () => {
  const html = CIF.render(CIF.buildModel(MAIN()));
  assert.match(html, /self-service/i);
  assert.match(html, /helped, not lost/);
  assert.doesNotMatch(html, /drop-?off|abandon|lost visitors|did not convert|bounce/i);
  // "failed" appears only in the explicit negation (self-service is NOT a failed conversion) and the "failed insert" data-quality note
  assert.deepEqual([...html.matchAll(/[^.>"]*\bfailed\b[^.<"]*/gi)].map((x) => x[0].trim()).filter((t) => !/not a failed conversion|a failed insert/i.test(t)), []);
  const m = CIF.buildModel(MAIN());
  assert.equal(m.contactIntent.filter((r) => r.self).map((r) => r.key).join(), 'where,price,terms,availability,photos');
});

test('diagnostics are collapsed (not open) and hold the low-volume breakdowns', () => {
  const html = CIF.render(CIF.buildModel(MAIN()));
  const details = html.match(/<details[^>]*>/)[0];
  assert.doesNotMatch(details, /\bopen\b/);
  const inside = html.split('<details')[1];
  for (const t of ['By surface', 'By language', 'By availability when opened', 'Unit selection', 'By listing', 'Derived action', 'Data quality']) assert.ok(inside.includes(t), t);
  const before = html.split('<details')[0];
  assert.ok(!/By listing|By language|By surface|Derived action/.test(before), 'no diagnostic table outside the collapsed block');
});

test('listing rows: rates only from MIN_LISTING_VISITS; soft-deleted listings are flagged; the hard-deleted one is absent', () => {
  const m = CIF.buildModel(MAIN());
  const L = m.diagnostics.listings;
  assert.equal(L.length, 3);
  assert.deepEqual(L.map((l) => [l.slug, l.visits, l.lowVolume, l.isDeleted]), [['villa-alpha', 14, false, false], ['tower-beta', 2, true, false], ['gamma-soft', 1, true, true]]);
  const html = CIF.render(m);
  assert.match(html, /Villa Alpha[\s\S]*?\(28\.6%\)/);                 // 4 of 14 self-service, shown because 14 >= 10
  assert.match(html, /Tower Beta<\/td>|Tower Beta <span class="muted"/);
  assert.match(html, /low volume/);
  assert.match(html, /class="badge cif-deleted">deleted</);
});

test('derived attribution is labelled diagnostic and shows matched / unmatched exactly', () => {
  const a = CIF.buildModel(MAIN()).diagnostics.attribution;
  assert.deepEqual(a.matched, { book: 1, call: 3, whatsapp: 4 });
  assert.deepEqual(a.unmatched, { book: 0, call: 0, whatsapp: 3 });
  assert.equal(a.unlinkable, 1); assert.equal(a.leadsWithoutAction, 3); assert.equal(a.visitsWithClickButNoAction, 1);
  assert.match(CIF.render(CIF.buildModel(MAIN())), /Treat as diagnostic/);
});

test('breakdowns by surface / language / availability / unit', () => {
  const d = CIF.buildModel(MAIN()).diagnostics;
  const get = (rows, k) => rows.find((r) => r.key === k).visits;
  assert.deepEqual(['panel', 'sheet', 'unknown'].map((k) => get(d.bySurface, k)), [7, 8, 2]);
  assert.deepEqual(['en', 'lo', 'zh', 'unknown'].map((k) => get(d.byLang, k)), [13, 1, 1, 2]);
  assert.deepEqual(['on', 'off', 'unknown'].map((k) => get(d.byAvailability, k)), [14, 1, 2]);
  assert.deepEqual(d.byUnit.map((u) => [u.name, u.visits, u.thenContact]).sort(), [['Room A', 1, 1], ['Room B', 1, 0]]);
});

test('historical-data caveats: epoch / Today / outcome window / exclusions appear exactly when they apply', () => {
  const ids = (raw) => CIF.buildModel(raw).caveats.map((c) => c.id);
  // a past range starting ON the final-layout day: no epoch caveat, no Today caveat
  let raw = MAIN();
  assert.deepEqual(ids(raw).filter((i) => i !== 'volume' && i !== 'excluded'), []);
  // Today
  raw = MAIN(); raw.range.includes_today = true; raw.range.outcomes_incomplete = true;
  const today = CIF.buildModel(raw).caveats.find((c) => c.id === 'today');
  assert.equal(today.level, 'warn'); assert.match(today.text, /Today \(Laos time\) is still in progress/);
  assert.match(CIF.render(CIF.buildModel(raw)), /data-caveat="today"/);
  // a range ending recently but not including today
  raw = MAIN(); raw.range.outcomes_incomplete = true;
  assert.ok(ids(raw).includes('window')); assert.ok(!ids(raw).includes('today'));
  // a range that reaches before the final layout day
  raw = MAIN(); raw.range.start = '2026-10-03';
  const epoch = CIF.buildModel(raw).caveats.find((c) => c.id === 'epoch');
  assert.match(epoch.text, /began on 2026-10-01/); assert.match(epoch.text, /2026-10-08/); assert.match(epoch.text, /nothing is backfilled/);
  // exclusions
  const ex = CIF.buildModel(MAIN()).caveats.find((c) => c.id === 'excluded').text;
  assert.match(ex, /1 open without a browser session/); assert.match(ex, /1 open on a listing that no longer exists/);
});

test('an empty range renders zeros as zeros (not an error), with no rates and no NaN', () => {
  const m = CIF.buildModel(EMPTY());
  assert.equal(m.visits, 0);
  assert.equal(m.kpis.selfServiceRate.text, '—');
  const html = CIF.render(m);
  assert.doesNotMatch(html, /NaN|undefined|null|Infinity/);
  assert.match(html, /data-kpi="visits"[\s\S]*?<div class="stat-value">0</);
});

test('a malformed / partial payload throws (the page shows an error + Retry), never zeros', () => {
  for (const bad of [null, undefined, {}, [], 'x', 5, { ask: {} }, { ask: { visits: 1 }, contact_intent: {} }]) {
    assert.throws(() => CIF.buildModel(bad), (e) => e.name === 'RpcError' && e.kind === 'incomplete', JSON.stringify(bad));
  }
});

test('integrity: a payload whose arithmetic is impossible is flagged loudly, not silently displayed', () => {
  const raw = MAIN(); raw.contact_intent.self_service_visits = 99; raw.clicks.total = 99;
  const m = CIF.buildModel(raw);
  assert.ok(m.integrity.length >= 2);
  assert.match(CIF.render(m), /Funnel arithmetic check failed/);
});

test('hostile strings (listing title, unit name, junk keys) are escaped; garbage numbers become 0', () => {
  const raw = MAIN();
  raw.diagnostics.listings[0].title = '<img src=x onerror=alert(1)>';
  raw.diagnostics.by_unit[0].unit_name = '"><script>alert(2)</script>';
  raw.diagnostics.by_lang.push({ key: '<b>x</b>', ask_visits: 'NaN', self_service_visits: -4 });
  const html = CIF.render(CIF.buildModel(raw));
  assert.doesNotMatch(html, /<img src=x|<script>alert|<b>x<\/b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /NaN/);
});

test('the rendered section carries no session ids, phone numbers or buyer data', () => {
  const html = CIF.render(CIF.buildModel(MAIN()));
  assert.doesNotMatch(html, /\bs[0-9]{2}[ab]?\b/);
  assert.doesNotMatch(html, /\+856|customer_|phone number/i);
});

test('loading / error shells keep the same anchor so a Retry can swap them in place', () => {
  assert.match(CIF.loadingHtml(), /id="ci-funnel"/);
  assert.match(CIF.errorHtml('<div>x</div>'), /id="ci-funnel"/);
  assert.match(CIF.render(CIF.buildModel(MAIN())), /id="ci-funnel"/);
});


// ═══ Terms & utilities / Price & deposit: the resolution breakdown ══════════════════════════════════
test('resolution scenarios: the model reproduces the database\'s numbers exactly', () => {
  const m = CIF.buildModel(RES());
  assert.equal(m.visits, 11);
  assert.deepEqual(m.contactIntent.map((r) => [r.key, r.count]), [['opened', 11], ['chosen', 11], ['where', 1], ['price', 5], ['terms', 6], ['availability', 0], ['photos', 0], ['unit', 0]]);
  assert.equal(m.selfServiceVisits, 6, 'self-service excludes the Price/Terms taps the page could not answer');
  assert.equal(m.escalatedVisits, 5);
  assert.deepEqual(m.resolution.price, { answered: 3, escalated: 2, unspecified: 1 });
  assert.deepEqual(m.resolution.terms, { answered: 2, escalated: 3, unspecified: 1 });
  assert.deepEqual(m.resolution.deposit, { answered: 2, escalated: 2 });
  assert.deepEqual(m.resolution.askAgent, { visits: 3, terms: 2, deposit: 1 });
  assert.equal(m.resolution.escalatedVisits, 5);
  assert.equal(m.resolution.escalatedThenContact, 3);
  assert.deepEqual([m.agentContactVisits, m.kpis.callVisits, m.kpis.whatsappVisits], [4, 1, 3]);
  assert.deepEqual(m.integrity, []);
});

test('the Resolution block shows answered / handed-over / not-recorded per question', () => {
  const html = CIF.render(CIF.buildModel(RES()));
  assert.match(html, /data-block="resolution"/);
  // exact cell sequence per row (no tag-stripping regex: the markup is built by us and compared verbatim)
  const rowStart = (k, label) => '<tr data-resolution-row="' + k + '"><td>' + label + '</td>';
  assert.ok(html.includes(rowStart('price', 'Price &amp; deposit') + '<td>3</td><td>2</td><td>1</td>'), 'Price & deposit: 3 answered, 2 handed over, 1 not recorded');
  assert.ok(html.includes(rowStart('terms', 'Terms &amp; utilities') + '<td>2</td><td>3</td><td>1</td>'), 'Terms & utilities: 2 answered, 3 handed over, 1 not recorded');
  assert.ok(html.includes(rowStart('deposit', '…of which about the deposit') + '<td>2</td><td>2</td>'), 'deposit topic: 2 answered, 2 handed over');
});

test('resolution shares are withheld below the listing-level floor (never a percentage of a handful)', () => {
  const html = CIF.render(CIF.buildModel(RES()));
  const priceRow = html.match(/<tr data-resolution-row="price">(.*?)<\/tr>/s)[1];
  assert.match(priceRow, /title="Too few visits for a share">—</);
  const raw = RES(); raw.resolution.terms = { answer_on_site: 30, escalate_to_agent: 10, unspecified: 0 };
  const row = CIF.render(CIF.buildModel(raw)).match(/<tr data-resolution-row="terms">(.*?)<\/tr>/s)[1];
  assert.match(row, /25%/);
});

test('the resolution line states escalated visits and how many then contacted the agent; Ask-the-agent taps by topic', () => {
  const html = CIF.render(CIF.buildModel(RES()));
  assert.match(html, /data-res="escalated"[^>]*><b>5<\/b> Ask visits had a question handed to the agent; <b>3<\/b> of them then contacted the agent/);
  assert.match(html, /data-res="ask-agent"[^>]*><b>3<\/b> visits tapped “Ask the agent” \(2 about terms · 1 about the deposit\)/);
});

test('a v1 payload (no resolution block) still renders, explains what is missing, and never draws an empty Resolution table', () => {
  const m = CIF.buildModel(V1());
  assert.equal(m.resolution, null);
  assert.deepEqual(m.integrity, []);
  const html = CIF.render(m);
  assert.doesNotMatch(html, /data-block="resolution"/);
  assert.match(html, /data-caveat="resolution-missing"/);
  assert.match(html, /20261009000000/);
  assert.equal(m.contactIntent.find((r) => r.key === 'terms').count, 0);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('the v2 payload for the original fixtures keeps every v1 number (backward compatibility, end to end)', () => {
  const a = CIF.buildModel(V1()), b = CIF.buildModel(MAIN());
  for (const k of ['visits', 'selfServiceVisits', 'agentContactVisits', 'highIntentVisits']) assert.equal(b[k], a[k], k);
  assert.deepEqual(b.highIntent.map((r) => r.count), a.highIntent.map((r) => r.count));
  assert.deepEqual(b.clicks, a.clicks);
  assert.deepEqual(b.resolution.price, { answered: 0, escalated: 0, unspecified: 2 }, 'the old Price rows have no resolution: "not recorded", still self-service');
});

test('integrity flags an impossible resolution payload', () => {
  const raw = RES(); raw.resolution.escalated_then_contact_visits = 99;
  assert.ok(CIF.buildModel(raw).integrity.some((x) => /Escalated-then-contacted/.test(x)));
  const raw2 = RES(); raw2.resolution.escalated_visits = 1;
  assert.ok(CIF.buildModel(raw2).integrity.some((x) => /differ/.test(x)));
});

test('garbage in the resolution block becomes zeros, hostile strings are escaped', () => {
  const raw = RES(); raw.resolution.price = { answer_on_site: 'x', escalate_to_agent: -3 }; raw.resolution.ask_agent_clicks = { visits: '<script>' };
  const m = CIF.buildModel(raw);
  assert.deepEqual(m.resolution.price, { answered: 0, escalated: 0, unspecified: 0 });
  assert.equal(m.resolution.askAgent.visits, 0);
  const out = CIF.render(m);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /NaN|undefined/);
});
