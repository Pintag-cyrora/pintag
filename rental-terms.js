// rental-terms.js — Rental Terms v2: building-level defaults + per-unit-type
// overrides for deposit, utilities, service frequency, policies, and fees.
// Same loading convention as terminology.js/amenities.js: plain global vars,
// no build step, <script src="rental-terms.js"> before each page's own
// inline <script>. Written as plain, dependency-free JS (no `document`/
// `window` references in the resolver/formatter/normalizer functions) so
// the same file is includable from a browser <script> tag AND a Deno edge
// function without a rewrite — required because AI-generated copy (Smart
// Import, future description generation) must consume resolveRentalTerms()
// rather than re-deriving this logic in a different runtime.
//
// ============================================================================
// ARCHITECTURAL RULES — read before touching this file or adding a field
// ============================================================================
//
// 1. RENTAL_TERMS_FIELDS is the single source of truth for Rental Terms
//    metadata: labels (en/lo/zh), option lists, field kind, display order,
//    and grouping. No other file may define any of these. A consumer that
//    needs a label fetches it from this registry at render time — it never
//    keeps its own copy.
//
// 2. Display order comes directly from RENTAL_TERMS_FIELDS' array order.
//    Never alphabetize; never let an individual consumer re-sort fields.
//
// 3. resolveRentalTerms() is the ONLY public read API. No code outside this
//    file may read properties.rental_terms or unit_types.rental_terms_overrides
//    directly — not admin.html, not listing.html, not an edge function, not
//    a future helper. Any future helper (e.g. a hypothetical
//    getEffectiveDeposit()) must itself call resolveRentalTerms() internally
//    and read from its `.values` — it may never re-open the raw columns as
//    a shortcut.
//
// 4. Adding a Rental Term that fits an EXISTING `kind` requires only: one
//    entry in RENTAL_TERMS_FIELDS, plus its option list if applicable. It
//    must NOT require changes to resolveRentalTerms(), _normalizeRentalTermsBlob(),
//    the admin renderer (RENTAL_TERM_KIND_RENDERERS), the public listing
//    renderer, save/load logic, or the collapsed-summary formatter
//    (formatRentalTermValue()). A new `kind` (a new renderer function) is
//    only justified when a field needs a genuinely new interaction model —
//    check whether it fits money_multiplier / utility / select /
//    checkbox_ref / fee_list first; most new fields will. If implementing a
//    field ever requires touching more than the registry, that's a signal
//    the kind-dispatch architecture has broken down for that field — fix
//    the architecture, don't hand-roll a special case in a consumer.
//
// 5. Resolver purity: resolveRentalTerms() and _normalizeRentalTermsBlob()
//    never mutate the `property` object, never mutate the `unitType`
//    object, never mutate the stored JSON, and never write normalized or
//    resolved values back to the database as a side effect of being
//    called. Normalization is an in-memory, read-time-only concern.
//
// 6. The resolver's return shape is a frozen contract:
//      { version, values, overriddenKeys }
//    This must remain stable across future schema versions. A future v2
//    schema changes what _normalizeRentalTermsBlob() does internally — it
//    must never change what resolveRentalTerms() returns to callers.
//
// 7. "version" inside a stored blob is a serialization/schema-version
//    marker ONLY. It must never be read as, or repurposed for, a business
//    version, a pricing revision, a policy revision, or any other domain
//    concept. `_normalizeRentalTermsBlob()` stays intentionally minimal
//    (strip `version`, return a shallow copy) until a real Version 2 shape
//    actually exists — no speculative migration logic is written ahead of
//    a real need.
//
// 8. This module and unit-availability.js must remain completely
//    independent — see unit-availability.js's own header for the mirrored
//    rule. Neither file may import or reference the other.
//
// 9. JSONB scope boundary: this pattern is for configuration/policy data —
//    small, human-edited, evolves by adding optional keys. It is NOT a
//    precedent for operational/transactional data (bookings, pricing
//    history, calendars, analytics) — those stay flat and relational,
//    matching every other table in this schema (search_events,
//    listing_events, leads, intelligence_insights, unit_types itself).
// ============================================================================

var RENTAL_TERMS_SCHEMA_VERSION = 1;

// Shared option lists.
var RENTAL_MONTHS_OPTIONS = [
  {value:'months_of_rent', label:{en:'Months of rent', lo:'ຈຳນວນເດືອນຄ່າເຊົ່າ', zh:'按月租计算'}},
  {value:'fixed_amount',   label:{en:'Fixed amount',   lo:'ຈຳນວນຄົງທີ່',        zh:'固定金额'}}
];
var RENTAL_FREQUENCY_OPTIONS = [
  {value:'daily',        label:{en:'Daily',            lo:'ທຸກມື້',          zh:'每天'}},
  {value:'twice_weekly',  label:{en:'Twice a Week',     lo:'ອາທິດລະ 2 ຄັ້ງ',  zh:'每周两次'}},
  {value:'weekly',        label:{en:'Weekly',           lo:'ອາທິດລະຄັ້ງ',    zh:'每周一次'}},
  {value:'biweekly',      label:{en:'Biweekly',         lo:'ສອງອາທິດຄັ້ງ',   zh:'每两周一次'}},
  {value:'monthly',       label:{en:'Monthly',          lo:'ເດືອນລະຄັ້ງ',    zh:'每月一次'}},
  {value:'not_included',  label:{en:'Not Included',     lo:'ບໍ່ລວມ',         zh:'不包含'}}
];
var RENTAL_LAUNDRY_OPTIONS = [
  {value:'included',     label:{en:'Included',      lo:'ລວມຢູ່ແລ້ວ',     zh:'包含'}},
  {value:'self_service', label:{en:'Self-Service',  lo:'ບໍລິການດ້ວຍຕົນເອງ', zh:'自助服务'}},
  {value:'paid_service', label:{en:'Paid Service',  lo:'ບໍລິການເສຍຄ່າ',  zh:'付费服务'}},
  {value:'not_available',label:{en:'Not Available', lo:'ບໍ່ມີບໍລິການ',   zh:'不提供'}}
];

// Included Services — a filtered, rental-specific registry, same shape as
// AMENITIES ({key: {en,lo,zh,icon}}) but deliberately its own set: this is
// "what's bundled into the rent," a different question from AMENITIES'
// general marketing feature list, even where a term (wifi) overlaps in
// English. Intentionally a conservative v1 set — see terminology.js-style
// future-proofing note: breakfast/gym access/airport transfer are the
// documented FUTURE additions (design doc §8), added later as new entries
// here with zero resolver/renderer changes, not built speculatively now.
var RENTAL_SERVICES = {
  wifi:        {en:'Wi-Fi',        lo:'ອິນເຕີເນັດໄວໄຟ', zh:'无线网络',   icon:'📶'},
  housekeeping:{en:'Housekeeping', lo:'ບໍລິການທຳຄວາມສະອາດ', zh:'客房清洁', icon:'🧹'},
  security:    {en:'Security',     lo:'ຄວາມປອດໄພ',      zh:'安保',       icon:'🔐'}
};

// RENTAL_TERMS_FIELDS — the registry. Array order = display order (rule 2
// above). `group` is optional metadata (financial/utilities/services) for
// a future grouped admin/public UI — not consumed by any renderer yet.
var RENTAL_TERMS_FIELDS = [
  { key:'deposit', kind:'money_multiplier', group:'financial',
    label:{en:'Deposit', lo:'ເງິນມັດຈຳ', zh:'押金'}, typeOptions:RENTAL_MONTHS_OPTIONS },
  { key:'advance_rent', kind:'money_multiplier', group:'financial',
    label:{en:'Advance Rent', lo:'ຄ່າເຊົ່າລ່ວງໜ້າ', zh:'预付租金'}, typeOptions:RENTAL_MONTHS_OPTIONS },
  { key:'electricity', kind:'utility', group:'utilities',
    label:{en:'Electricity', lo:'ໄຟຟ້າ', zh:'电费'}, typeOptions:[
      {value:'included',  label:{en:'Included',        lo:'ລວມຢູ່ແລ້ວ', zh:'包含'}},
      {value:'metered',   label:{en:'Metered',         lo:'ຕິດຕັ້ງມິເຕີ', zh:'按表计费'}},
      {value:'flat_rate', label:{en:'Flat Rate',       lo:'ອັດຕາຄົງທີ່', zh:'固定费率'}}
    ] },
  { key:'water', kind:'utility', group:'utilities',
    label:{en:'Water', lo:'ນ້ຳປະປາ', zh:'水费'}, typeOptions:[
      {value:'included', label:{en:'Included',  lo:'ລວມຢູ່ແລ້ວ', zh:'包含'}},
      {value:'metered',  label:{en:'Metered',   lo:'ຕິດຕັ້ງມິເຕີ', zh:'按表计费'}},
      {value:'flat_fee', label:{en:'Flat Fee',  lo:'ຄ່າທຳນຽມຄົງທີ່', zh:'固定费用'}}
    ] },
  { key:'internet', kind:'utility', group:'utilities',
    label:{en:'Internet', lo:'ອິນເຕີເນັດ', zh:'网络'}, typeOptions:[
      {value:'included',       label:{en:'Included',        lo:'ລວມຢູ່ແລ້ວ',   zh:'包含'}},
      {value:'not_included',   label:{en:'Not Included',    lo:'ບໍ່ລວມ',       zh:'不包含'}},
      {value:'available_extra',label:{en:'Available (Extra Fee)', lo:'ມີໃຫ້ (ເສຍຄ່າເພີ່ມ)', zh:'可提供(需额外付费)'}}
    ] },
  { key:'cleaning_frequency', kind:'select', group:'services',
    label:{en:'Cleaning Frequency', lo:'ຄວາມຖີ່ການທຳຄວາມສະອາດ', zh:'清洁频率'}, options:RENTAL_FREQUENCY_OPTIONS },
  { key:'sheet_changing_frequency', kind:'select', group:'services',
    label:{en:'Sheet Changing Frequency', lo:'ຄວາມຖີ່ການປ່ຽນຜ້າປູ', zh:'换床单频率'}, options:RENTAL_FREQUENCY_OPTIONS },
  { key:'laundry', kind:'select', group:'services',
    label:{en:'Laundry', lo:'ບໍລິການຊັກຜ້າ', zh:'洗衣服务'}, options:RENTAL_LAUNDRY_OPTIONS },
  { key:'included_services', kind:'checkbox_ref', group:'services',
    label:{en:'Included Services', lo:'ບໍລິການທີ່ລວມຢູ່', zh:'包含的服务'}, registry:'RENTAL_SERVICES' },
  { key:'additional_fees', kind:'fee_list', group:'financial',
    label:{en:'Additional Fees', lo:'ຄ່າທຳນຽມເພີ່ມເຕີມ', zh:'其他费用'} }
];

// ---------------------------------------------------------------------------
// Resolver — the sole public read API (rule 3). Pure (rule 5). Frozen
// contract (rule 6).
// ---------------------------------------------------------------------------

function _normalizeRentalTermsBlob(raw) {
  // Intentionally minimal (rule 7) -- v1 is a no-op beyond stripping the
  // version marker and returning a fresh copy. A version-aware upgrade
  // branch is added here only once a real v2 shape exists.
  var blob = raw || {};
  var copy = {};
  for (var k in blob) {
    if (Object.prototype.hasOwnProperty.call(blob, k) && k !== 'version') {
      copy[k] = blob[k];
    }
  }
  return copy;
}

function resolveRentalTerms(property, unitType) {
  var defaults  = _normalizeRentalTermsBlob(property && property.rental_terms);
  var overrides = _normalizeRentalTermsBlob(unitType && unitType.rental_terms_overrides);
  var values = {};
  var k;
  for (k in defaults)  { if (Object.prototype.hasOwnProperty.call(defaults, k))  values[k] = defaults[k]; }
  for (k in overrides) { if (Object.prototype.hasOwnProperty.call(overrides, k)) values[k] = overrides[k]; }
  return {
    version: RENTAL_TERMS_SCHEMA_VERSION,
    values: values,
    overriddenKeys: Object.keys(overrides)
  };
}

// buildRentalTermsPayload()/getRentalTermsOverridesFromDom() are the only
// write paths (rule 3) -- admin.html calls these, it never constructs a
// raw {version, ...} object itself.
function buildRentalTermsPayload(fieldValues) {
  var payload = { version: RENTAL_TERMS_SCHEMA_VERSION };
  for (var k in fieldValues) {
    if (Object.prototype.hasOwnProperty.call(fieldValues, k)) payload[k] = fieldValues[k];
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Formatting -- per-`kind` dispatch, generic over field key (rule 4).
// ---------------------------------------------------------------------------

function _rtOptionLabel(options, value, lang) {
  for (var i = 0; i < options.length; i++) {
    if (options[i].value === value) return options[i].label[lang] || options[i].label.en;
  }
  return value;
}

var RENTAL_TERM_KIND_FORMATTERS = {
  money_multiplier: function(fieldDef, raw, lang) {
    if (!raw || raw.value == null) return null;
    if (raw.type === 'fixed_amount') return String(raw.value);
    var unit = raw.value === 1 ? {en:'Month', lo:'ເດືອນ', zh:'月'} : {en:'Months', lo:'ເດືອນ', zh:'月'};
    return raw.value + ' ' + (unit[lang] || unit.en);
  },
  utility: function(fieldDef, raw, lang) {
    if (!raw || !raw.type) return null;
    var label = _rtOptionLabel(fieldDef.typeOptions, raw.type, lang);
    return raw.rate ? (label + ' (' + raw.rate + ')') : label;
  },
  select: function(fieldDef, raw, lang) {
    if (!raw) return null;
    return _rtOptionLabel(fieldDef.options, raw, lang);
  },
  checkbox_ref: function(fieldDef, raw, lang) {
    if (!Array.isArray(raw) || !raw.length) return null;
    var registry = (fieldDef.registry === 'RENTAL_SERVICES') ? RENTAL_SERVICES : {};
    return raw.map(function(key) {
      var entry = registry[key];
      return entry ? (entry[lang] || entry.en) : key;
    }).join(', ');
  },
  fee_list: function(fieldDef, raw, lang) {
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw.length === 1 ? raw[0].label : (raw.length + ' fees');
  }
};

// formatRentalTermValue() -- used by admin.html's collapsed Unit Type card
// summary to show resolved VALUES (not just field names) for overridden
// fields, in registry order, e.g. "Deposit: 1 Month".
function formatRentalTermValue(fieldKey, rawValue, lang) {
  lang = lang || 'en';
  var fieldDef = null;
  for (var i = 0; i < RENTAL_TERMS_FIELDS.length; i++) {
    if (RENTAL_TERMS_FIELDS[i].key === fieldKey) { fieldDef = RENTAL_TERMS_FIELDS[i]; break; }
  }
  if (!fieldDef) return null;
  var formatter = RENTAL_TERM_KIND_FORMATTERS[fieldDef.kind];
  var formatted = formatter ? formatter(fieldDef, rawValue, lang) : null;
  if (formatted == null) return null;
  return (fieldDef.label[lang] || fieldDef.label.en) + ': ' + formatted;
}

// Collapsed-card summary: top N overridden fields by registry order, with
// intelligent truncation ("+N more"). Pure, portable, no DOM.
function summarizeRentalTermOverrides(overriddenKeys, values, lang, maxShown) {
  lang = lang || 'en';
  maxShown = maxShown || 3;
  var orderedKeys = RENTAL_TERMS_FIELDS
    .map(function(f) { return f.key; })
    .filter(function(k) { return overriddenKeys.indexOf(k) !== -1; });
  var lines = [];
  for (var i = 0; i < orderedKeys.length && lines.length < maxShown; i++) {
    var line = formatRentalTermValue(orderedKeys[i], values[orderedKeys[i]], lang);
    if (line) lines.push(line);
  }
  var remaining = orderedKeys.length - lines.length;
  if (remaining > 0) lines.push('+' + remaining + ' more');
  return lines;
}

// ---------------------------------------------------------------------------
// Admin rendering -- DOM-touching, browser-only (unlike the resolver/
// formatter functions above, which stay portable per this file's header).
// Kept generic over `kind`, never over field key (rule 4).
// ---------------------------------------------------------------------------

var RENTAL_TERM_KIND_RENDERERS = {
  money_multiplier: function(fieldDef, value, onChange) {
    var row = document.createElement('div');
    row.className = 'rt-field rt-field-money';
    var typeSel = document.createElement('select');
    typeSel.className = 'form-input rt-input';
    fieldDef.typeOptions.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label.en;
      if (value && value.type === opt.value) o.selected = true;
      typeSel.appendChild(o);
    });
    var numInput = document.createElement('input');
    numInput.type = 'number'; numInput.min = '0'; numInput.className = 'form-input rt-input';
    numInput.value = (value && value.value != null) ? value.value : '';
    function emit() {
      var v = numInput.value === '' ? null : parseFloat(numInput.value);
      onChange(fieldDef.key, (v == null) ? null : { type: typeSel.value, value: v });
    }
    typeSel.onchange = emit; numInput.oninput = emit;
    row.appendChild(typeSel); row.appendChild(numInput);
    return row;
  },
  utility: function(fieldDef, value, onChange) {
    var row = document.createElement('div');
    row.className = 'rt-field rt-field-utility';
    var typeSel = document.createElement('select');
    typeSel.className = 'form-input rt-input';
    fieldDef.typeOptions.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label.en;
      if (value && value.type === opt.value) o.selected = true;
      typeSel.appendChild(o);
    });
    var rateInput = document.createElement('input');
    rateInput.type = 'text'; rateInput.placeholder = 'Rate (optional)'; rateInput.className = 'form-input rt-input';
    rateInput.value = (value && value.rate) ? value.rate : '';
    function emit() {
      onChange(fieldDef.key, typeSel.value ? { type: typeSel.value, rate: rateInput.value.trim() || null } : null);
    }
    typeSel.onchange = emit; rateInput.oninput = emit;
    row.appendChild(typeSel); row.appendChild(rateInput);
    return row;
  },
  select: function(fieldDef, value, onChange) {
    var sel = document.createElement('select');
    sel.className = 'form-input rt-input rt-field';
    var blank = document.createElement('option'); blank.value = ''; blank.textContent = '—';
    sel.appendChild(blank);
    fieldDef.options.forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label.en;
      if (value === opt.value) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function() { onChange(fieldDef.key, sel.value || null); };
    return sel;
  },
  checkbox_ref: function(fieldDef, value, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rt-field rt-field-checkboxes';
    var registry = (fieldDef.registry === 'RENTAL_SERVICES') ? RENTAL_SERVICES : {};
    var current = Array.isArray(value) ? value.slice() : [];
    Object.keys(registry).forEach(function(key) {
      var label = document.createElement('label');
      label.className = 'rt-checkbox-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = current.indexOf(key) !== -1;
      cb.onchange = function() {
        current = cb.checked ? current.concat([key]) : current.filter(function(k) { return k !== key; });
        onChange(fieldDef.key, current.length ? current : null);
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + registry[key].icon + ' ' + registry[key].en));
      wrap.appendChild(label);
    });
    return wrap;
  },
  fee_list: function(fieldDef, value, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'rt-field rt-field-fees';
    var rows = Array.isArray(value) ? value.slice() : [];
    function redraw() {
      wrap.innerHTML = '';
      rows.forEach(function(fee, i) {
        var row = document.createElement('div');
        row.className = 'rt-fee-row';
        var labelInput = document.createElement('input');
        labelInput.type = 'text'; labelInput.placeholder = 'Fee name'; labelInput.className = 'form-input rt-input';
        labelInput.value = fee.label || '';
        var amountInput = document.createElement('input');
        amountInput.type = 'text'; amountInput.placeholder = 'Amount'; amountInput.className = 'form-input rt-input';
        amountInput.value = fee.amount || '';
        var freqSel = document.createElement('select');
        freqSel.className = 'form-input rt-input';
        ['one_time', 'monthly'].forEach(function(f) {
          var o = document.createElement('option'); o.value = f; o.textContent = f === 'one_time' ? 'One-Time' : 'Monthly';
          if (fee.frequency === f) o.selected = true;
          freqSel.appendChild(o);
        });
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button'; removeBtn.textContent = '✕'; removeBtn.className = 'rt-fee-remove';
        function emit() {
          rows[i] = { label: labelInput.value.trim(), amount: amountInput.value.trim(), frequency: freqSel.value };
          onChange(fieldDef.key, rows.length ? rows : null);
        }
        labelInput.oninput = emit; amountInput.oninput = emit; freqSel.onchange = emit;
        removeBtn.onclick = function() { rows.splice(i, 1); onChange(fieldDef.key, rows.length ? rows : null); redraw(); };
        row.appendChild(labelInput); row.appendChild(amountInput); row.appendChild(freqSel); row.appendChild(removeBtn);
        wrap.appendChild(row);
      });
      var addBtn = document.createElement('button');
      addBtn.type = 'button'; addBtn.textContent = '+ Add Fee'; addBtn.className = 'rt-fee-add';
      addBtn.onclick = function() { rows.push({label:'', amount:'', frequency:'one_time'}); redraw(); };
      wrap.appendChild(addBtn);
    }
    redraw();
    return wrap;
  }
};

// renderRentalTermsFields(container, values, onChange) -- the generic
// renderer every admin surface (building-level + Unit Type override form)
// calls. Adding a field that fits an existing `kind` requires zero changes
// here (rule 4).
function renderRentalTermsFields(container, values, onChange) {
  container.innerHTML = '';
  RENTAL_TERMS_FIELDS.forEach(function(fieldDef) {
    var row = document.createElement('div');
    row.className = 'form-field rt-row';
    var label = document.createElement('label');
    label.className = 'form-label';
    label.textContent = fieldDef.label.en;
    row.appendChild(label);
    var control = RENTAL_TERM_KIND_RENDERERS[fieldDef.kind](fieldDef, values[fieldDef.key], onChange);
    row.appendChild(control);
    container.appendChild(row);
  });
}

// getRentalTermsFromDom(container) -- reads a container previously built by
// renderRentalTermsFields() back into a plain {key: value} object, by
// re-reading the same onChange-tracked state. In practice the admin page
// keeps a local `fieldValues` object updated live via onChange and passes
// it straight to buildRentalTermsPayload() -- this helper exists for
// completeness/symmetry and for any consumer that only has the DOM.
function getRentalTermsFromDom(fieldValues) {
  return buildRentalTermsPayload(fieldValues || {});
}
