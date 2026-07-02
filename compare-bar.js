// ══════════════════════════════════════════════════════════════════
// compare-bar.js — shared floating "Compare" bar.
// Include on any page that offers a compare toggle (listings.html,
// saved-properties.html, listing.html). Self-contained: injects its
// own <style> with a fixed, hardcoded palette rather than relying on
// each host page's --teal/--ink tokens (those differ slightly between
// pages), so the bar looks identical everywhere it appears.
//
// Depends on compare.js (getCompareSet, removeFromCompare) and the
// 'pintag:compare-changed' event it dispatches. Depends on the host
// page defining getCurrentLang() globally, same convention as
// property-card.js's dependency on esc().
//
// Visibility rule: shown only when 2-4 properties are selected — one
// selection isn't a comparison yet, and the cap is 4.
// ══════════════════════════════════════════════════════════════════
(function () {
  var LABELS = {
    comparing: { lo: 'ກຳລັງປຽບທຽບ', en: 'Comparing', zh: '正在比较' },
    properties: { lo: 'ຊັບສິນ', en: 'properties', zh: '个房源' },
    clear: { lo: 'ລ້າງທັງໝົດ', en: 'Clear all', zh: '清除全部' },
    compareNow: { lo: 'ປຽບທຽບເລີຍ', en: 'Compare Now', zh: '立即比较' },
    limitMsg: { lo: 'ປຽບທຽບໄດ້ສູງສຸດ 4 ຊັບສິນ', en: 'You can compare up to 4 properties', zh: '最多可比较4个房源' }
  };

  function lang() {
    try { return (typeof getCurrentLang === 'function') ? getCurrentLang() : 'lo'; }
    catch (e) { return 'lo'; }
  }

  function injectStyle() {
    if (document.getElementById('pintag-compare-style')) return;
    var style = document.createElement('style');
    style.id = 'pintag-compare-style';
    style.textContent =
      '#pintag-compare-bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%) translateY(0);' +
      'z-index:1500;display:flex;align-items:center;gap:16px;background:#1A2428;color:#fff;' +
      'padding:12px 14px 12px 20px;border-radius:999px;box-shadow:0 10px 32px rgba(0,0,0,0.28);' +
      'font-family:"DM Sans",sans-serif;opacity:0;pointer-events:none;transition:opacity 0.2s ease,transform 0.2s ease;' +
      'max-width:calc(100vw - 32px);}' +
      '#pintag-compare-bar.visible{opacity:1;pointer-events:auto;}' +
      '#pintag-compare-bar .pcb-count{font-size:13px;font-weight:500;white-space:nowrap;}' +
      '#pintag-compare-bar .pcb-count b{color:#38A8A8;}' +
      '#pintag-compare-bar .pcb-clear{font-size:12px;color:rgba(255,255,255,0.6);text-decoration:underline;background:none;border:none;cursor:pointer;font-family:inherit;white-space:nowrap;padding:0;}' +
      '#pintag-compare-bar .pcb-clear:hover{color:#fff;}' +
      '#pintag-compare-bar .pcb-go{display:inline-flex;align-items:center;gap:6px;background:#2D8C8C;color:#fff;font-size:13px;font-weight:600;padding:9px 18px;border-radius:999px;text-decoration:none;white-space:nowrap;transition:background 0.15s;}' +
      '#pintag-compare-bar .pcb-go:hover{background:#38A8A8;}' +
      '@supports selector(:has(a)){body:has(#mobile-cta-bar) #pintag-compare-bar{bottom:84px;}}' +
      '@media(max-width:600px){#pintag-compare-bar{gap:10px;padding:10px 10px 10px 16px;} #pintag-compare-bar .pcb-clear{display:none;}}' +
      '.pintag-compare-shake{animation:pintagCompareShake 0.4s ease;}' +
      '@keyframes pintagCompareShake{10%,90%{transform:translateX(-1px);}20%,80%{transform:translateX(2px);}30%,50%,70%{transform:translateX(-3px);}40%,60%{transform:translateX(3px);}}';
    document.head.appendChild(style);
  }

  function ensureBar() {
    var bar = document.getElementById('pintag-compare-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'pintag-compare-bar';
    bar.innerHTML =
      '<span class="pcb-count"></span>' +
      '<button type="button" class="pcb-clear"></button>' +
      '<a class="pcb-go" href="#"></a>';
    document.body.appendChild(bar);
    bar.querySelector('.pcb-clear').addEventListener('click', function () {
      getCompareSet().forEach(function (slug) { removeFromCompare(slug); });
    });
    return bar;
  }

  function render() {
    var set = getCompareSet();
    var bar = ensureBar();
    var L = lang();

    if (set.size < 2) {
      bar.classList.remove('visible');
      return;
    }

    bar.querySelector('.pcb-count').innerHTML =
      LABELS.comparing[L] + ' <b>' + set.size + '</b> ' + LABELS.properties[L];
    bar.querySelector('.pcb-clear').textContent = LABELS.clear[L];
    var go = bar.querySelector('.pcb-go');
    go.textContent = LABELS.compareNow[L] + ' →';
    go.href = 'compare.html?slugs=' + Array.from(set).map(encodeURIComponent).join(',');

    bar.classList.add('visible');
  }

  // A card's compare button calls this after toggleCompare() so the bar
  // can give a brief, honest nudge instead of silently ignoring a 5th pick.
  window.pintagCompareLimitNudge = function (btn) {
    if (!btn) return;
    btn.classList.remove('pintag-compare-shake');
    void btn.offsetWidth; // restart animation if clicked again quickly
    btn.classList.add('pintag-compare-shake');
  };

  document.addEventListener('DOMContentLoaded', function () {
    injectStyle();
    render();
  });
  document.addEventListener('pintag:compare-changed', render);
})();
