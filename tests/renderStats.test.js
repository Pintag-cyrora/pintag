import { describe, it, expect, beforeEach } from 'vitest';

// Verbatim copy of renderStats from dashboard.html (lines 483–503).
// Do NOT refactor — this test verifies the exact DOM-mutation logic used in production.
function renderStats(properties) {
  const total = properties.length;

  const published = properties.filter(p =>
    p.status === 'active'
  ).length;

  const sale = properties.filter(p =>
    p.transaction_type === 'for_sale'
  ).length;

  const rent = properties.filter(p =>
    p.transaction_type === 'for_rent'
  ).length;

  document.getElementById('listing-count').innerText = total;
  document.getElementById('published-count').innerText = published;
  document.getElementById('sale-count').innerText = sale;
  document.getElementById('rent-count').innerText = rent;
}

// ── helpers ──────────────────────────────────────────────────────────

function makeStatsDOM() {
  document.body.innerHTML = `
    <div id="listing-count">0</div>
    <div id="published-count">0</div>
    <div id="sale-count">0</div>
    <div id="rent-count">0</div>
  `;
}

const getCount = (id) => String(document.getElementById(id).innerText);

const make = (overrides) => ({ status: 'active', transaction_type: 'for_sale', ...overrides });

// ── tests ────────────────────────────────────────────────────────────

describe('renderStats DOM integration', () => {
  beforeEach(() => {
    makeStatsDOM();
  });

  it('sets all counters to 0 for empty array', () => {
    renderStats([]);
    expect(getCount('listing-count')).toBe('0');
    expect(getCount('published-count')).toBe('0');
    expect(getCount('sale-count')).toBe('0');
    expect(getCount('rent-count')).toBe('0');
  });

  it('sets listing-count to total number of properties', () => {
    renderStats([make(), make(), make()]);
    expect(getCount('listing-count')).toBe('3');
  });

  it('sets published-count to count of status=active only', () => {
    renderStats([
      make({ status: 'active' }),
      make({ status: 'active' }),
      make({ status: 'inactive' }),
      make({ status: 'sold' }),
    ]);
    expect(getCount('published-count')).toBe('2');
  });

  it('sets sale-count to count of transaction_type=for_sale only', () => {
    renderStats([
      make({ transaction_type: 'for_sale' }),
      make({ transaction_type: 'for_sale' }),
      make({ transaction_type: 'for_rent' }),
    ]);
    expect(getCount('sale-count')).toBe('2');
  });

  it('sets rent-count to count of transaction_type=for_rent only', () => {
    renderStats([
      make({ transaction_type: 'for_rent' }),
      make({ transaction_type: 'for_sale' }),
    ]);
    expect(getCount('rent-count')).toBe('1');
  });

  it('does not count legacy "sale" in sale-count (matches dashboard.html)', () => {
    renderStats([
      make({ transaction_type: 'sale' }),
      make({ transaction_type: 'for_sale' }),
    ]);
    expect(getCount('sale-count')).toBe('1');
  });

  it('does not count legacy "rent" in rent-count (matches dashboard.html)', () => {
    renderStats([
      make({ transaction_type: 'rent' }),
      make({ transaction_type: 'for_rent' }),
    ]);
    expect(getCount('rent-count')).toBe('1');
  });

  it('overwrites previous values when called a second time', () => {
    renderStats([make(), make(), make()]);
    expect(getCount('listing-count')).toBe('3');
    renderStats([make()]);
    expect(getCount('listing-count')).toBe('1');
    expect(getCount('published-count')).toBe('1');
  });

  it('updates all four counters independently and correctly', () => {
    renderStats([
      make({ status: 'active',   transaction_type: 'for_sale' }),
      make({ status: 'active',   transaction_type: 'for_rent' }),
      make({ status: 'inactive', transaction_type: 'for_sale' }),
    ]);
    expect(getCount('listing-count')).toBe('3');
    expect(getCount('published-count')).toBe('2');
    expect(getCount('sale-count')).toBe('2');
    expect(getCount('rent-count')).toBe('1');
  });

  it('handles null status and transaction_type gracefully', () => {
    renderStats([make({ status: null, transaction_type: null })]);
    expect(getCount('listing-count')).toBe('1');
    expect(getCount('published-count')).toBe('0');
    expect(getCount('sale-count')).toBe('0');
    expect(getCount('rent-count')).toBe('0');
  });
});
