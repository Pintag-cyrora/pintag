// dev-banner.js — the mandatory, non-dismissible visual safety net. Shows
// whenever window.PINTAG.isProduction is false, regardless of why —
// independent of whether config.js's detection is ever wrong, a human
// always has ground truth on screen. Reads tag/label generically, so
// adding a future environment (staging/QA/UAT) in config.js needs no
// changes here. Pure UI; no environment-detection logic lives here (see
// config.js). Must load after config.js.
(function () {
  if (!window.PINTAG || window.PINTAG.isProduction) return;

  document.addEventListener('DOMContentLoaded', function () {
    var banner = document.createElement('div');
    banner.textContent = '⚠ ' + window.PINTAG.tag + ' • Connected to: ' + window.PINTAG.label;
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;' +
      'background:#e67e22;color:#fff;font:bold 13px/1 sans-serif;text-align:center;' +
      'padding:6px 8px;box-shadow:0 1px 4px rgba(0,0,0,0.3);';
    document.body.appendChild(banner);
    document.body.style.paddingTop = (banner.offsetHeight || 28) + 'px';
  });
})();
