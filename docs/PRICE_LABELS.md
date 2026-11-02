# How a listing's price is labelled (exact, starting price, range, varies)

A price shown to a visitor must never read as the confirmed price of a unit when it is not. One function decides the label and
one function writes it as text; every public surface uses them.

- `formatPropertyPrice(property, lang)` (`components.js`) resolves the price and returns `priceKind`, `fromLabel`,
  `fromPlacement`, `rangeText`, `isPriceVaries`.
- `ptFormatPriceLine(info, lang)` turns that into the displayed line. Surfaces that show a price as a string call it
  (listing detail, share text, `og:` / `twitter:` / meta description, agent and map cards); the card and the preview tile render
  the same result as markup.
- `cloudflare-worker/og-listing-preview.js` is a hand port for the crawler-visible link preview: change one, change the other.

## What each label means, and what data triggers it

| Label | `priceKind` | Triggered by | en / lo / zh |
|---|---|---|---|
| Exact price | `exact` | A plain listing; one priced unit type; units that all cost the same; any listing whose data does not show variation | `$350 / month` |
| Starting price | `from` | 2+ unit types with a real price in the **same currency and frequency** that are **not all equal** (the headline is the minimum), or the cheapest comparable lease term when the tiers differ | `From $350 / month` · `ເລີ່ມຕົ້ນ $350 / ເດືອນ` · `$350 / 月起` |
| Range | `range` (text) / `rangeText` | A range already typed or imported as text with one symbol (`$280-300 / month`) is shown in the standard format (`$280–$300 / month`); any other typed text is shown as written; a starting price on the detail page also shows the unit-price span on its own line | `$350–$500 / month` |
| Prices vary | `varies` | 2+ unit types with a real price whose **currencies or frequencies differ** (USD next to LAK, monthly next to daily): no amount is a reliable starting price | `Prices vary` · `ລາຄາແຕກຕ່າງກັນ` · `价格不一` |
| Price on request | `none` | No usable price anywhere | `Price on request` |

Rules that keep it honest:

- Existing listings are **never** converted to starting prices. A listing becomes one only because its own unit types differ.
- A selected unit on the detail page shows **its own** exact price.
- A structured amount must be a positive number. null, NaN, text, 0 and negative values fall through to the other sources and
  finally to "Price on request"; invalid unit prices are never compared.
- Chinese puts 起 **after** the price (`$350 / 月起`); English and Lao put the word before it.
- Currency symbols and grouping come from `currency.js` only (USD `$`, LAK `₭`, THB `฿`). Ranges carry the symbol on both ends
  (`formatMoneyRange()`: `$350–$500`, `₭3,000,000–₭4,500,000`).
- The Lao and Chinese wording of "Prices vary" is flagged for native-speaker review (same convention as the "From" words).

## Known limitation: a single-unit listing cannot say "starting price"

The label is **derived** from unit types and lease tiers. A listing with no unit types has one price and is shown as exact, even if
the owner means "from $350" (for example a studio whose price depends on floor, or an agent advertising an opening price). There
is no data to say otherwise, and guessing would convert every existing exact price. Likewise a multi-unit listing whose units are
all priced the same, and a unit type that itself is "from", stay exact.

## Proposed enhancement (not implemented): let the owner state it

Smallest safe design, additive and backward compatible:

1. **Schema**: a nullable `price_qualifier text CHECK (price_qualifier IN ('exact','from'))` on `properties` and on `unit_types`
   (and, if sale_or_rent legs need it, one per leg). NULL means "derive it as today", so every existing row behaves exactly as now.
   One migration, applied through the gated `apply-migration.yml` workflow.
2. **Owner forms** (`add-property.html`, `edit-listing.html`, `admin.html` Pricing section and each unit type card): a small
   "Price is: Exact / Starting from" control next to the amount, default blank/"Exact", with the same three languages. Not shown
   (or forced to derived) while unit types exist, because the range already determines it.
3. **Formatter**: in `formatPropertyPrice()` an explicit `'from'` sets `priceKind: 'from'` even without unit variance; an explicit
   `'exact'` suppresses a derived "From" only for a single price (never for units that really differ, where it would mislead).
   `cloudflare-worker/og-listing-preview.js` and the select lists (`LISTING_COLUMNS`, the card queries) gain the column.
4. **Tests**: formatter matrix (NULL / exact / from x single / multi), the three languages, the owner forms' payloads, the worker
   port, and an unchanged-behaviour test for every NULL row.

Open questions before building it: whether an agent (not only the owner) may set it, and whether the admin import (Smart Import)
should infer it from phrases such as "from $350".
