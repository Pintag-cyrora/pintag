# Pintag Launch Roadmap — LIVING DOCUMENT

**The one question this document always answers:**
> *If we had to reopen Pintag today, which listings would we publish first?*

**Objective:** the **strongest possible launch catalogue** — complete, premium,
trustworthy — not the largest count. *We would rather launch 30–40 flawless
listings than 91 inconsistent ones.* Recovery continues while the platform is live.

**Last updated:** 2026-08-05 · **Status:** evidence gathering (no data written).
**Update rule:** as evidence arrives, **upgrade confidence and promote tiers**;
**never downgrade a listing without evidence**; update rankings in place.

## 🎯 Phase 1 Launch Catalogue Progress — PRIMARY BUSINESS KPI
- **Target:** **30** premium listings
- **Confirmed production-ready:** **0 / 30**
- **Recoverable near-term:** ~**12–16** via agent outreach (pending) + Wayback covers (pending E9)
- **Remaining gap:** **30**

*Objective: reach 30 the fastest way. Every recovery decision optimizes for closing
this gap; anything that doesn't strengthen the launch catalogue goes to Phase 2.*

## 🚦 Status — Platform · Catalogue · Launch
> *The platform is no longer the bottleneck. **The catalogue is.***

### Platform Readiness — ✅ substantially ready
Authentication ✅ · Security ✅ · Backend ✅ · Database ✅ · Search ✅ · Frontend ✅ ·
Infrastructure ✅ *(one caveat: verified backup pending — DR built, first run + drill outstanding)*

### Catalogue Readiness — 🔴 the bottleneck
- **⭐ Listings with ≥1 viable recovery path:** **12 confirmed · 79 pending evidence · 0 exhausted** (of 91) — *primary launch-readiness metric*
- **Production-ready listings:** **0 / ~30–40** target
- **Photos:** 0 galleries attached (Storage pool intact but unlinked; sources: Wayback cover / Facebook gallery)
- **Agent:** **Keomany's 10 = the operator's own listings → self-restore** (strong Phase-1 contributors; excluded from outreach ranking). External agents **Tik 3** (Facebook), **Pee 2**, **Sivone 1** = 6 via outreach. Other **79 = agent relationship currently unknown (Pending Evidence)**.
- **Owner (now the priority track):** owner→listing link **destroyed** (owner_id was on the deleted rows; removal_log has no owner; leads cascaded). `owners` survives only as a **contact list** — recovery is **owner outreach** (owner identifies + re-supplies their listings). ~**0 of 91** carry an owner link today.
- **Contact:** `leads` CASCADED — manual / Facebook.

> **A listing becomes a *true orphan* only after ALL authoritative sources are exhausted:** Wayback · Facebook · Storage metadata · `properties_removal_log` · the `listings` table · every Recovery Evidence Register source. Until then it stays **Pending Evidence**, never "orphan."
- **Core property facts:** mostly missing (Wayback / Facebook / manual)
- **AI-generated content:** ⚪ **not a blocker** — regenerated after launch

### Launch Readiness — 🔴 blocked by catalogue only
Platform ✅ **+** a premium Phase-1 catalogue ⬜. The **sole remaining gate is content** (plus the verified backup).

**Largest remaining launch blocker:** **79 of 91 have an unknown agent relationship (Pending Evidence)** — recovery path TBD until Wayback/Facebook/Storage are checked (not orphans yet). Fastest *confirmed* wins: the **12–16 agent-linked listings** via **4 agent contacts**. 0 galleries attached yet.
**Highest-impact next action (run in PARALLEL — complementary):**
  (a) **Operator self-restores own 10** (Keomany) — fastest Phase-1 fill, no outreach.
  (b) **Owner recovery** — run forensic Report 8, then contact owners to identify + re-supply their listings among the 79 (owners hold their own photos + facts).
  (c) **E9 Wayback CDX** for the 79 — covers + core presentation.
  (d) Light agent outreach: Tik (3, Facebook), Pee (2), Sivone (1). (Plus: first verified backup, parallel.)
**Closer than yesterday?** **Yes (measurement).** First hard evidence in: **agent-recoverability = 12/91**, and the single highest-ROI action is now concrete — one WhatsApp to Keomany recovers 10. Production-ready count is still 0, but the fastest path to the first ~12–16 is identified.

---

## Recovery philosophy — what actually blocks launch
**Irreplaceable (recovery-critical, gates launch):**
- Original **photo galleries**
- **Agent / owner / contact** identity
- **Core listing facts** (price, currency, beds/baths, sizes, district, village, type, transaction, coordinates)

**Recreatable (NEVER a launch dependency — regenerate later):**
- AI descriptions · translated titles · SEO fields · slugs

A listing is *not* held back from launch by missing AI text. It is held back only
by missing photos, missing contact, or missing core facts.

## Launch scoring model (per-listing) + set assembly
Weighted in the approved priority order (higher = more launch value):

| Weight | Factor | How scored |
|---|---|---|
| 8 | **Photo recoverability** | full gallery = 3 · verified cover = 2 · orphan-review only = 1 · none = 0 |
| 7 | **Agent/owner/phone recoverability** | agent+contact = 2 · one = 1 · none = 0 |
| 6 | **Core property facts** | recoverable (Wayback/FB) = 2 · partial = 1 · none = 0 |
| 5 | **Frontend presentation quality** | renders cleanly with what we can restore |
| 4 | **Market appeal** | premium district / price tier *(proxy until price returns)* |
| 3 | **Engagement** | views + leads (E7/E8) |

`LaunchScore = 8·Photo + 7·Contact + 6·Facts + 5·Frontend + 4·Appeal + 3·Engagement`

**Then the launch SET is assembled** from the top scores **subject to
diversity constraints** so the catalogue reads as broad and premium:
- **Geographic diversity** — spread across districts, no single-area monotony.
- **Property-type diversity** — houses / apartments / land / commercial represented.

## Recovery promotion priority — which recovered listings to promote first
When an agent gallery or Wayback evidence arrives, **do not promote every listing
equally.** For each, ask: **"Does publishing this make Pintag's launch catalogue
stronger?"** If yes → prioritize; if no → Phase 2 queue. Promotion order:
1. Listings that **complete the Phase 1 catalogue** (fill a district/type gap in the launch set).
2. **Premium** listings (highest-quality inventory).
3. Listings in **important districts**.
4. Listings that improve **property-type diversity**.
5. **Highest-confidence** listings.
6. Everything else → **Phase 2 queue**.

## Launch classification (4 tiers)
| Tier | Criteria |
|---|---|
| 🟢 **Production Ready** | correct photos (full gallery, or verified cover) + correct agent/owner/contact + core property facts + QA-passed — **AI text NOT required** |
| 🟡 **Recoverable Before Launch** | authoritative assets exist & high-confidence — Wayback cover and/or findable FB gallery + lead-linked agent + recoverable facts |
| 🟠 **Recoverable After Launch** | needs manual reconstruction, likely recoverable (agent supplies photos, FB uncertain) |
| 🔴 **Long-term Recovery** | insufficient evidence today |

---

## Current best answer ("reopen today")
**Production Ready today: 0 of 91** — no listing has photos reattached yet. The
site infrastructure and security *are* ready; **content is the gate.** The launch
set, counts, and rankings populate from the evidence below — **Pending Evidence.**

### Evidence status
| ID | Source | Feeds | Status |
|---|---|---|---|
| E0 | Identity export (title/district/type) | roadmap rows, Wayback match | ⬜ pending |
| E1 | Storage image count/size | photo pool size | ⬜ pending |
| E2 | Orphaned photos | reconnection target | ⬜ pending |
| E3 | `listings` table inspection | **wildcard legacy source** | ⬜ pending |
| E4 | Image-path scan | any surviving photo link | ⬜ pending |
| E5 | Time-correlation isolation | Needs-Review ceiling | ⬜ pending |
| E6 | Identity inventory | contact completeness | ⬜ pending |
| E7/E8 | Engagement + agent/contact per listing | ranking backbone | ⬜ pending |
| E9 | Wayback CDX | cover-image / core-facts coverage | ⬜ pending |
| — | Facebook post inventory | full-gallery coverage | ⬜ pending |

## Per-listing roadmap (populate from E0/E7/E8/E9 — Pending Evidence)
Ranked by `LaunchScore` once evidence lands. Columns:

| UUID | Title | District | Type | Tier | Missing assets | Recovery source | Confidence | Est. effort | Blocking issue | Recommended next action |
|---|---|---|---|---|---|---|---|---|---|---|
| _pending E0/E8_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | low/med/high | _pending_ | _pending_ |

*Effort model:* Wayback cover attach = **low** (batch) · lead→agent relink = **low** (batch) · FB gallery recovery = **high** (manual, login-gated) · manual specs = **med** · agent re-supply = **high**.

## Launch recommendation (framework now; counts Pending Evidence)
| Scenario | Publish criteria | Count | Trade-off |
|---|---|---|---|
| **Conservative** | 🟢 only (full gallery + contact + facts + QA) | _pending_ | Safest; smallest — risk of looking sparse |
| **Balanced (recommended)** | 🟢 + top 🟡 reaching production quality fast (cover/FB gallery + contact) | _pending_ | Best size-vs-quality; every visible listing solid |
| **Aggressive** | 🟢 + all 🟡 + best 🟠, accepting cover-only for some | _pending_ | Largest; some listings thinner — risks the premium feel |

**Minimum to reopen confidently:** ~25–40 flawless, district- and type-diverse
listings (fills the grid, curated feel, nothing broken visible). Refined once E8/E9 land.

## Launch blocker report (ranked by impact — populated from confirmed findings)
| # | Blocker | Launch impact | Est. effort | Listings affected | Phase |
|---|---|---|---|---|---|
| 1 | **No galleries attached to any listing** | 🔴 Critical — every listing renders photo-less | Cover=low (batch), Gallery=high (manual) | all 91 | **Blocks Phase 1** |
| 2 | **Full galleries only via manual Facebook** (login wall, ≤1 photo unauth) | 🟠 High — caps automatic photo quality | High / manual | majority (Pending E9/FB) | Phase 1 for premium feel; spills to Phase 2 |
| 3 | **Wayback coverage unknown** (caps the auto tier) | 🟠 High — sets the 🟡 ceiling | Low (run E9) | Pending | **Blocks Phase 1 planning** |
| 4 | **`listings` table unresolved** (possible legacy source) | 🟡 Wildcard — could shift everything | Low (run E3) | Pending | Resolve before Phase 1 planning |
| 5 | **Core facts (price/beds/sizes) mostly manual** | 🟡 Medium — listings look incomplete without price/specs | Med / manual (Wayback gives price+district; specs manual) | all 91 | Phase 1 for launch set; tail waits |
| 6 | **Agent/contact coverage partial** (leads-dependent) | 🟡 Medium — no-lead listings lack auto agent | Low (relink) for covered; manual otherwise | Pending E8 | Phase 1 for covered set |
| 7 | **Owner identity no automatic path** | 🟢 Low — owner is internal, not visitor-facing | Manual / FB poster | most | Phase 2 |
| — | AI descriptions / translations / SEO | ⚪ None — recreatable, not a blocker | n/a | n/a | Post-launch |

---

## Changelog
- **2026-08-05** — Document created (living). Framework, scoring model, philosophy,
  classification, and blocker report seeded from confirmed code findings. All
  per-listing rows and launch counts **Pending Evidence** (E0–E9 + Facebook).

*Next update: on receipt of E7/E8 (backbone) → populate rows, tiers, and the
Balanced launch count; then E9 (Wayback) → promote cover-recoverable listings.*
