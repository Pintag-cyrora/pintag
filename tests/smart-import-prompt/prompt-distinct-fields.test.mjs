// Focused test: the smart-listing-importer prompt must instruct the model that
// TITLE and PROPERTY HIGHLIGHT have DISTINCT purposes (the highlight must not
// restate the title), and that the neighbourhood insight stays location-only.
//
// This is a static prompt-content assertion — the Gemini call itself can't be
// run offline, so we verify the INSTRUCTIONS the model receives. Run:
//   node tests/smart-import-prompt/prompt-distinct-fields.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.resolve(here, '../../supabase/functions/smart-listing-importer/index.ts'),
  'utf8'
);

const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || '' });
const has = (re) => re.test(src);
const idx = (re) => { const m = src.match(re); return m ? m.index : -1; };

// 1. A dedicated PROPERTY HIGHLIGHT section exists (was entirely absent before).
check('PROPERTY HIGHLIGHT section present', has(/PROPERTY HIGHLIGHT — sell ONE strong quality/));

// 2. The highlight is explicitly told NOT to restate the title.
check('highlight must NOT restate the title',
  has(/must NOT simply restate the title/i) && has(/NOT a restatement of the title/i));

// 3. Highlight length guidance: <=160, prefer ~90-140, never pad.
check('highlight length: max 160', has(/Maximum 160 characters/));
check('highlight length: prefer ~90–140', has(/90[–-]140 characters/));
check('highlight: never pad', has(/NEVER pad to reach the limit/i));

// 4. A DIFFERENTIATION / DISTINCT PURPOSES rule exists and names the three jobs.
check('DIFFERENTIATION & DISTINCT PURPOSES rule present', has(/DIFFERENTIATION & DISTINCT PURPOSES/));
check('rule: identify strongest supported evidence first', has(/identify the strongest property-specific evidence/i));
check('rule: TITLE = recognizable identity', has(/TITLE = the property's recognizable identity/));
check('rule: HIGHLIGHT = distinct selling strength', has(/PROPERTY HIGHLIGHT = a DISTINCT visual\/functional selling strength/));
check('rule: NEIGHBORHOOD INSIGHT = location only', has(/NEIGHBORHOOD INSIGHT = location ONLY/));

// 5. Explicit anti-repetition + separation directives.
check('do not repeat concept across title and highlight',
  has(/Do NOT repeat the same concept across the title and the highlight/));
check('do not put property features into neighbourhood insight',
  has(/Do NOT put property features into the neighbourhood insight/));
check('do not use photos to invent neighbourhood facts',
  has(/Do NOT use the photos to invent neighbourhood facts/));

// 6. Ordering: the HIGHLIGHT section sits between TITLE and DESCRIPTIONS.
const iTitle = idx(/\nTITLE — the single most important field/);
const iHi    = idx(/\nPROPERTY HIGHLIGHT — sell ONE strong quality/);
const iDesc  = idx(/\nDESCRIPTIONS — generate from the ACTUAL photos/);
check('highlight section is placed between TITLE and DESCRIPTIONS',
  iTitle >= 0 && iHi > iTitle && iDesc > iHi, `title@${iTitle} highlight@${iHi} desc@${iDesc}`);

// 7. Regression guards — the things we were told to KEEP unchanged.
check('KEEP: temperature still 0.4', has(/temperature:\s*0\.4/));
check('KEEP: neighbourhood insight still village-first', has(/anchor on the VILLAGE/i));
check('KEEP: existing-title clue logic intact', has(/A "Current listing title" may be provided/));
check('KEEP: anti-hallucination "never invent" intact', has(/never invent/i));

let pass = 0, fail = 0;
console.log('\n──── smart-listing-importer prompt — distinct TITLE vs HIGHLIGHT ────');
for (const r of results) { console.log((r.ok ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? ('   [' + r.detail + ']') : '')); r.ok ? pass++ : fail++; }
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
