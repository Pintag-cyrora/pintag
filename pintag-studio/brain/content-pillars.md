# Content Pillars

Four content types, each with a distinct job. The Content Strategist balances weekly output across all four against the Year-1 targets in `brain/mission.md`; the CMO's monthly brief may temporarily weight one pillar higher (e.g., during Campaign founder mode) but should never let a pillar stall for long.

## 1. Educational Posts (target: 300/year)

**Job:** teach something a buyer, renter, or investor genuinely needs to know, independent of any specific listing. Buying/selling process, financing basics, legal concepts (plain-language, sourced from `knowledge-base/guides/`), market literacy.

**Not:** a property advertisement wearing an educational headline.

## 2. Neighborhood Guides (target: 200/year)

**Job:** make each of Vientiane's 7 districts (and eventually finer-grained villages) genuinely understandable — character, price band, amenities, who it suits. Sourced from `knowledge-base/neighborhoods/`, refreshed periodically as the market shifts rather than only written once.

**Repurposing note:** a district's guide should evolve over the year (price band updates, new amenities) rather than accumulate as near-duplicate posts — this is exactly what the Memory layer's dedupe check is for.

## 3. Market Updates (target: 150/year)

**Job:** factual, sourced, dated snapshots of market movement (pricing trends, transaction volume patterns, new development/infrastructure impact). The most conservatively reviewed content type — see `brain/org-config.json` (`auto_publish_eligible.market_updates.eligible_from_phase: "never"`) — this pillar always keeps founder review regardless of Approval Phase.

## 4. Property Videos (target: 500/year)

**Job:** bring individual live listings to life — template-driven by default (FFmpeg, real listing photos, TTS voiceover), grounded in the read-only Pintag listings feed. The highest-volume pillar and the primary path to daily cadence.

## Balancing Rule

No single pillar should crowd out another for more than a week without a Founder Mode reason (e.g., Campaign mode temporarily emphasizing one). The Dashboard's weekly progress bars (per pillar, against the Year-1 target pace) are the visible check on this.
