// Generates the fixture for run-availability-canonical-pg.sh: one property per (market_status x unit configuration)
// state, with the EXPECTED availability computed by the BROWSER resolver (property-availability.js, the canonical
// implementation). The SQL port in 20261012000000_intelligence_canonical_availability.sql is then compared with it.
//   node tests/security/regression/gen-availability-matrix.mjs > matrix.sql
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const f of ['unit-availability.js', 'listing-status.js', 'property-availability.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const R = globalThis.resolvePropertyAvailability;

const U = (o) => Object.assign({ is_available: true, available_count: 1, total_units: null, next_available_date: null }, o);
const OPEN = () => U({});
const OPEN_DATED = () => U({ next_available_date: '2999-01-01' });
const FULL = () => U({ available_count: 0, next_available_date: '2999-01-01' });
const TEMP = () => U({ available_count: 0 });
const SOON = () => U({ is_available: false, total_units: 10, available_count: 0 });
const FLAG_OFF = () => U({ is_available: false, available_count: 3 });
const UNIT_SETS = {
  none: [], oneOpen: [OPEN()], oneFull: [FULL()], oneTemp: [TEMP()], oneSoon: [SOON()], oneOpenDated: [OPEN_DATED()], oneFlagOff: [FLAG_OFF()],
  twoOpen: [OPEN(), OPEN()], openAndFull: [OPEN(), FULL()], openAndSoon: [OPEN(), SOON()], twoFull: [FULL(), FULL()],
  twoTemp: [TEMP(), TEMP()], twoSoon: [SOON(), SOON()], fullAndTemp: [FULL(), TEMP()], soonAndTemp: [SOON(), TEMP()],
};
const MARKETS = ['available', 'reserved', 'rented', 'fully_occupied', 'sold', 'off_market', 'coming_soon'];

const uuid = (kind, n, m) => `${kind}0000000-0000-0000-${String(n).padStart(4, '0')}-${String(m).padStart(12, '0')}`;
const lit = (v) => (v === null ? 'NULL' : typeof v === 'boolean' ? String(v) : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const EXPECT = process.argv.includes('--expected');
const out = [];
const exp = { siteAll: 0, siteAvailable: 0, shown: new Map() };
out.push('CREATE TABLE expected_state (district text PRIMARY KEY, label text, workflow text, expect_available boolean, expect_open_units text[]);');
let n = 0;
function emit(market, setName, units, workflow) {
  n++;
  const pid = uuid('a', n, 0);
  const district = `D${String(n).padStart(3, '0')}`;
  const prop = { market_status: market, unit_types: units.map((u, i) => Object.assign({ id: uuid('b', n, i + 1) }, u)) };
  const s = R(prop);
  const available = workflow === 'active' && s.available;
  const open = available ? s.openUnitIds : [];
  out.push(`INSERT INTO properties (id, property_type, transaction_type, district_en, status, market_status, workflow_status, bedrooms) VALUES (${lit(pid)}, 'house', 'for_rent', ${lit(district)}, ${lit(workflow)}, ${lit(market)}, ${lit(workflow)}, 2);`);
  prop.unit_types.forEach((u) => out.push(`INSERT INTO unit_types (id, property_id, is_available, available_count, total_units, next_available_date) VALUES (${lit(u.id)}, ${lit(pid)}, ${lit(u.is_available)}, ${lit(u.available_count)}, ${lit(u.total_units)}, ${lit(u.next_available_date)});`));
  // expectations for scripts/market-status-report.sql (sections 3 and 6): what the site shows
  if (workflow !== 'draft') { exp.siteAll++; if (s.available) exp.siteAvailable++; }
  if (workflow === 'active') { const k = [market, s.effectiveMarket, s.available ? 't' : 'f'].join('|'); exp.shown.set(k, (exp.shown.get(k) || 0) + 1); }
  out.push(`INSERT INTO expected_state VALUES (${lit(district)}, ${lit(`${market}/${setName}/${workflow}`)}, ${lit(workflow)}, ${lit(available)}, ARRAY[${open.map(lit).join(',')}]::text[]);`);
}
for (const m of MARKETS) for (const [name, units] of Object.entries(UNIT_SETS)) emit(m, name, units, 'active');
// draft / archived are never supply, whatever the status and units say
for (const wf of ['draft', 'archived']) for (const [m, name] of [['available', 'none'], ['available', 'twoOpen'], ['rented', 'openAndFull']]) emit(m, name, UNIT_SETS[name], wf);
if (EXPECT) {
  const lines = [`SITE|${exp.siteAll}|${exp.siteAvailable}`];
  [...exp.shown.entries()].sort().forEach(([k, v]) => lines.push(`SHOWN|${k}|${v}`));
  process.stdout.write(lines.join('\n') + '\n');
} else {
  process.stdout.write(out.join('\n') + '\n');
}
