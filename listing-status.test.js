// Unit tests for listing-status.js -- run with `node --test listing-status.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./listing-status.js', import.meta.url), 'utf8');
vm.runInThisContext(src, { filename: 'listing-status.js' });

const {
  resolveListingStatus, getMarketStatusLabel, getWorkflowStatusLabel,
  getMarketStatusBadgeClass, getListingStatusCTA, getUnavailableMessage
} = globalThis;

test('resolveListingStatus: defaults to active/available when unset (pre-migration-default rows)', () => {
  const r = resolveListingStatus({});
  assert.equal(r.workflow, 'active');
  assert.equal(r.market, 'available');
  assert.equal(r.isPubliclyAvailable, true);
});

test('resolveListingStatus: coming_soon stays publicly available (normal price/contact flow)', () => {
  const r = resolveListingStatus({ workflow_status: 'active', market_status: 'coming_soon' });
  assert.equal(r.isPubliclyAvailable, true);
});

test('resolveListingStatus: sold/rented/reserved/fully_occupied/off_market are NOT publicly available', () => {
  ['sold','rented','reserved','fully_occupied','off_market'].forEach(m => {
    const r = resolveListingStatus({ workflow_status: 'active', market_status: m });
    assert.equal(r.isPubliclyAvailable, false, m + ' should be unavailable');
  });
});

test('getMarketStatusLabel: trilingual, falls back to en for unknown status', () => {
  assert.equal(getMarketStatusLabel('sold', 'en'), 'Sold');
  assert.equal(getMarketStatusLabel('sold', 'lo'), 'ຂາຍແລ້ວ');
  assert.equal(getMarketStatusLabel('sold', 'zh'), '已售出');
  assert.equal(getMarketStatusLabel('bogus', 'en'), 'Available');
});

test('getWorkflowStatusLabel: trilingual', () => {
  assert.equal(getWorkflowStatusLabel('draft', 'en'), 'Draft');
  assert.equal(getWorkflowStatusLabel('archived', 'zh'), '已归档');
});

test('getMarketStatusBadgeClass: buckets into available/pending/unavailable', () => {
  assert.equal(getMarketStatusBadgeClass('available'), 'status-available');
  assert.equal(getMarketStatusBadgeClass('coming_soon'), 'status-available');
  assert.equal(getMarketStatusBadgeClass('reserved'), 'status-pending');
  assert.equal(getMarketStatusBadgeClass('fully_occupied'), 'status-pending');
  assert.equal(getMarketStatusBadgeClass('sold'), 'status-unavailable');
});

test('getListingStatusCTA: null for available/unknown (normal flow, no override)', () => {
  assert.equal(getListingStatusCTA('available', 'en'), null);
});

test('getListingStatusCTA: sold/rented/reserved/off_market -> Find Similar Properties', () => {
  ['sold','rented','reserved','off_market'].forEach(m => {
    const cta = getListingStatusCTA(m, 'en');
    assert.equal(cta.action, 'find_similar');
    assert.equal(cta.label, 'Find Similar Properties');
  });
});

test('getListingStatusCTA: fully_occupied -> Join Waiting List', () => {
  assert.equal(getListingStatusCTA('fully_occupied', 'en').action, 'waiting_list');
});

test('getListingStatusCTA: coming_soon -> Notify Me When Available, trilingual', () => {
  assert.equal(getListingStatusCTA('coming_soon', 'en').label, 'Notify Me When Available');
  assert.equal(getListingStatusCTA('coming_soon', 'lo').label, 'ແຈ້ງເຕືອນເມື່ອວ່າງ');
});

test('getUnavailableMessage: full sentence per status, null for available', () => {
  assert.equal(getUnavailableMessage('sold', 'en'), 'This property has been sold.');
  assert.equal(getUnavailableMessage('available', 'en'), null);
});
