// Shared web-page shell for /morning and future Marketing OS pages —
// generalized from founder-server.ts's own pageShell() (which stays
// untouched, still used by /, /teach, /review, /observations). Nav
// placeholders for pages not built yet render as inert "Coming soon"
// links rather than real hrefs, so nothing 404s from here.

export function escapeHtml(str: string): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export interface NavLink {
  href: string;
  label: string;
  enabled: boolean;
}

export const PRIMARY_NAV: NavLink[] = [
  { href: '/morning', label: 'Morning', enabled: true },
  { href: '/research', label: 'Research', enabled: false },
  { href: '/content', label: 'Content', enabled: false },
  { href: '/video', label: 'Video', enabled: false },
  { href: '/analytics', label: 'Analytics', enabled: false },
  { href: '/publish', label: 'Publish', enabled: false },
  { href: '/teach', label: 'Teach', enabled: true },
  { href: '/settings', label: 'Settings', enabled: false },
];

function renderNav(activeHref: string | undefined): string {
  const items = PRIMARY_NAV.map((link) => {
    const isActive = link.href === activeHref;
    if (!link.enabled) {
      return `<span class="nav-item nav-item-disabled" title="Coming soon">${escapeHtml(link.label)}</span>`;
    }
    return `<a class="nav-item${isActive ? ' nav-item-active' : ''}" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`;
  }).join('');
  return `<nav class="primary-nav">${items}</nav>`;
}

/** Shared color tokens/base styles — same teal/warm palette as founder-server.ts's pageShell() and the rest of the product, so this reads as one family. Mobile-first: large type, generous touch targets, a bottom-fixed nav bar (thumb-reachable) rather than a top nav. */
const BASE_STYLE = `
*{box-sizing:border-box;margin:0;padding:0;}
:root{--teal:#2D8C8C;--teal-light:#38A8A8;--teal-dim:rgba(45,140,140,0.08);--teal-border:rgba(45,140,140,0.22);
  --ink:#1A2428;--ink-soft:#3D5058;--ink-muted:#7A9098;--warm:#F7F3EC;--warm-deep:#EDE8E0;--white:#fff;
  --border:rgba(26,36,40,0.1);--gold:#B8860B;--red:#C0392B;--green:#1E6B45;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:17px;background:var(--warm);color:var(--ink);line-height:1.6;padding-bottom:76px;}
a{color:var(--teal);}
.page-wrap{max-width:640px;margin:0 auto;padding:24px 18px 40px;}
.primary-nav{position:fixed;left:0;right:0;bottom:0;display:flex;overflow-x:auto;background:var(--ink);padding:8px 6px calc(8px + env(safe-area-inset-bottom));gap:2px;z-index:10;}
.nav-item{flex:1 0 auto;min-width:64px;text-align:center;padding:10px 8px;border-radius:8px;font-size:12px;font-weight:600;color:rgba(255,255,255,0.55);text-decoration:none;white-space:nowrap;}
.nav-item-active{color:#fff;background:rgba(255,255,255,0.12);}
.nav-item-disabled{color:rgba(255,255,255,0.28);}
.card{background:var(--white);border:1px solid var(--border);border-radius:14px;padding:20px 20px;margin-bottom:16px;}
.card-title{font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:12px;display:flex;align-items:center;gap:8px;}
.card p{font-size:16px;color:var(--ink-soft);}
ul{list-style:none;}
.empty{color:var(--ink-muted);font-style:italic;font-size:15px;}
`;

export function pageShell(opts: { title: string; bodyHtml: string; activeHref?: string; extraHeadHtml?: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escapeHtml(opts.title)} — Marketing OS</title>
<style>${BASE_STYLE}</style>
${opts.extraHeadHtml ?? ''}
</head>
<body>
<div class="page-wrap">
${opts.bodyHtml}
</div>
${renderNav(opts.activeHref)}
</body>
</html>
`;
}
