// map-location-field.js — the "Google Maps link" form field for the agent-facing
// pages (add-property.html, edit-listing.html), behaving the same way the staff
// admin does: classify the pasted link with map-location.js, say plainly what it
// will and will not do on the public site, expand short links through the
// resolve-map-url edge function, and never block saving.
//
// Needs map-location.js loaded first. The PARSER makes no network calls; this
// file is the only place on these pages that talks to the resolver.
//
// The one rule that matters on the EDIT page: the form must never wipe a stored
// link by accident. changeFor() reports a change only when the field was
// actually loaded from the listing AND the user's value differs from it, so an
// edit of an unrelated field (or a failed load) leaves map_embed_url untouched.
(function (global) {
  'use strict';

  // Lao first (these pages are Lao-language), English token in brackets so the
  // three states stay recognisable next to the admin screen.
  var COPY = {
    hintDefault: 'ວາງລິ້ງ Google Maps (ບໍ່ບັງຄັບ). ຖ້າເປັນລິ້ງສັ້ນ ລະບົບຈະຂະຫຍາຍໃຫ້ອັດຕະໂນມັດ.',
    exact: function (c) { return '✓ ຈຸດທີ່ຕັ້ງແນ່ນອນ [Exact location] ' + c.lat.toFixed(6) + ', ' + c.lng.toFixed(6) + ' — ລາຍການຈະສະແດງເປັນຈຸດຢູ່ແຜນທີ່.'; },
    place: function (c) {
      return 'ℹ ສະຖານທີ່ທີ່ມີຊື່ [Named place]' + (c.label ? ': “' + c.label + '”' : '') +
        ' — ເປັນສະຖານທີ່ໃນ Google Maps ແຕ່ບໍ່ມີພິກັດແນ່ນອນ. ບັນທຶກໄດ້. ໜ້າລາຍການຈະມີລິ້ງໄປ Google Maps ແຕ່ຈະບໍ່ມີຈຸດຢູ່ແຜນທີ່.';
    },
    invalid: function (c) {
      return '⚠ ລິ້ງນີ້ໃຊ້ບໍ່ໄດ້ [Unusable link] — ຈະບໍ່ມີຈຸດຢູ່ແຜນທີ່: ' + global.PintagMapLocation.describeFailure(c) +
        '. ເປີດສະຖານທີ່ໃນ Google Maps ແລ້ວກົດແຊຣ໌ເພື່ອຄັດລອກລິ້ງໃໝ່.';
    },
    resolving: 'ກຳລັງຂະຫຍາຍລິ້ງ…',
    resolveFailed: function (why) {
      return '⚠ ຂະຫຍາຍລິ້ງສັ້ນບໍ່ໄດ້ (' + why + '). ລິ້ງຈະຖືກບັນທຶກຕາມເດີມ ແລະຈະບໍ່ມີຈຸດຢູ່ແຜນທີ່. ລອງໃໝ່ ຫຼືວາງລິ້ງເຕັມຈາກ google.com/maps.';
    }
  };

  var COLORS = { exact: '#2D8C8C', place: '#3A4E55', invalid: '#b91c1c', resolving: '#2D8C8C', empty: '' };

  // opts: { input, hint, supabaseUrl, anonKey, getToken?: () => Promise<string|null> }
  function attach(opts) {
    var input = opts.input, hint = opts.hint;
    var inflight = null;
    var original = null;          // the stored value, once the listing has loaded
    var loaded = false;

    function show(state, text) {
      hint.textContent = text;
      hint.style.color = COLORS[state] || '';
      hint.setAttribute('data-map-state', state);
    }

    function render() {
      var url = input.value.trim();
      if (!url) { show('empty', COPY.hintDefault); return; }
      var c = global.PintagMapLocation.classifyMapUrl(url);
      if (c.type === 'exact') show('exact', COPY.exact(c));
      else if (c.type === 'place') show('place', COPY.place(c));
      else show('invalid', COPY.invalid(c));
    }

    async function resolveNow() {
      var url = input.value.trim();
      if (!url || !global.PintagMapLocation.isShortLink(url)) { render(); return; }
      show('resolving', COPY.resolving);
      try {
        var token = opts.getToken ? await opts.getToken() : null;
        var res = await fetch(opts.supabaseUrl + '/functions/v1/resolve-map-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: opts.anonKey, Authorization: 'Bearer ' + (token || opts.anonKey) },
          body: JSON.stringify({ url: url })
        });
        var data = await res.json().catch(function () { return {}; });
        if (input.value.trim() !== url) return;        // the field moved on while this was in flight
        if (!res.ok || !data.resolved_url) { show('invalid', COPY.resolveFailed(data.error || ('HTTP ' + res.status))); return; }
        if (data.resolved_url !== url) input.value = data.resolved_url;
        render();
      } catch (e) {
        show('invalid', COPY.resolveFailed(e && e.message ? e.message : 'network error'));
      }
    }

    function resolve() {
      var p = resolveNow().catch(function () {});
      inflight = p;
      p.then(function () { if (inflight === p) inflight = null; });
      return p;
    }

    input.addEventListener('input', render);
    input.addEventListener('blur', resolve);
    render();

    return {
      render: render,
      // Await before reading the value on save: blur starts the resolution on the
      // way to the Save click.
      pending: function () { return inflight || Promise.resolve(); },
      value: function () { return input.value.trim() || null; },
      // EDIT page: remember what is stored so an untouched field is never rewritten.
      setOriginal: function (stored) {
        original = stored == null ? '' : String(stored).trim();
        loaded = true;
        input.value = original;
        render();
      },
      // null  -> leave map_embed_url alone (not loaded, or unchanged)
      // {value, clearing} -> write value (null clears the link, which the page confirms)
      changeFor: function () {
        if (!loaded) return null;
        var now = input.value.trim();
        if (now === original) return null;
        return { value: now || null, clearing: !now && !!original };
      },
      state: function () { return hint.getAttribute('data-map-state'); }
    };
  }

  var api = { attach: attach, COPY: COPY };
  global.PintagMapField = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
