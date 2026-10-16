// FROZEN reference: filterListings() exactly as merged in PR #151 (owner-name search), BEFORE owner-contact phone search.
// Used only by the differential test in ../admin-listings-filter.spec.js to prove no previously matching row is lost or relabelled.
// Do not edit; it depends on _digitsOnly / _normalizeSearchText / _nameSearchMatch from admin.html.
function filterListings() {
  const raw = (document.getElementById('listings-search') || {}).value || '';
  const s = raw.trim().toLowerCase();
  const sDigits = _digitsOnly(raw);
  // Status filter uses the canonical workflow_status axis (draft|active|
  // archived) from 20260729000000_listing_status_model.sql — the same field
  // the row render already reads. 'all' disables it. It composes with the
  // text search below (both must pass), so "Sisattanak + Draft" etc. work.
  const statusFilter = (document.getElementById('listings-status-filter') || {}).value || 'all';
  const rows = document.querySelectorAll('.listings-table tbody tr');
  let shown = 0;
  rows.forEach(tr => {
    const p = _listingsAll.find(x => x.id === tr.dataset.propertyId);
    const why = tr.querySelector('.match-why');
    if (why) why.textContent = '';

    // Status axis first — a non-matching status hides the row regardless of text.
    const statusOk = statusFilter === 'all' || (p && (p.workflow_status || 'active') === statusFilter);
    if (!statusOk) { tr.style.display = 'none'; return; }

    // No text query: show every status-matching row.
    if (!s) { tr.style.display = ''; shown++; return; }

    // Resolve the managing agent's names from the already-loaded roster
    // (same source the Agent column renders from) so a search can match agent
    // name / Lao name / agency without another query.
    const agent = p && p.managed_by_party_id ? _agentsAll.find(a => a.id === p.managed_by_party_id) : null;
    const owner = p && p.owners;
    // Labelled fields, checked in priority order, so we can surface WHY a row
    // matched. Location = district OR village; agent = any of the agent names.
    const fields = [
      ['title',    p && p.title_en],
      ['location', p && p.district_en],
      ['location', p && p.village_en],
      ['agent',    agent && agent.name_en],
      ['agent',    agent && agent.name_lo],
      ['agent',    agent && agent.agency_name],
      ['owner',    owner && owner.name],
      ['price',    p && p.price_display],
    ];
    let reason = '';
    for (let i = 0; i < fields.length; i++) {
      const val = fields[i][1];
      if (val && String(val).toLowerCase().includes(s)) { reason = fields[i][0]; break; }
    }
    // A ≥3-digit query also matches an owner's phone/whatsapp (digits-only on
    // both sides), preserving the original phone-lookup behavior.
    const phoneHit = sDigits.length >= 3 && owner &&
      (_digitsOnly(owner.phone).includes(sDigits) || _digitsOnly(owner.whatsapp).includes(sDigits));
    if (!reason && phoneHit) reason = 'phone';
    // Owner NAME, normalised (punctuation / extra whitespace / width / multi-word in any order / Lao + Chinese). Only
    // adds matches the plain substring checks above missed, so nothing that matched before stops matching.
    //   'owner'          the internal, staff-only owners record
    //   'owner (contact)' a buyer contact whose role is 'owner' (legacy single contact or a property_contacts row);
    //                    contacts with any other role are never matched
    if (!reason && owner && _nameSearchMatch(owner.name, raw)) reason = 'owner';
    if (!reason && p) {
      const cs = [p.contacts].concat((Array.isArray(p.property_contacts) ? p.property_contacts : []).map(pc => pc && pc.contacts));
      if (cs.some(c => c && c.role === 'owner' && _nameSearchMatch(c.name, raw))) reason = 'owner (contact)';
    }

    const match = !!reason;
    tr.style.display = match ? '' : 'none';
    if (match) {
      shown++;
      // Show the reason subtly, but not for 'title' (the title is right there).
      if (why && reason !== 'title') why.textContent = reason;
    }
  });
  const note = document.getElementById('listings-search-count');
  const active = !!s || statusFilter !== 'all';
  if (note) note.textContent = active ? `${shown} of ${rows.length} listings` : '';
}
